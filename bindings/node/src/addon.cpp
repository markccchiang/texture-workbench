// Node-API bindings for glcm_core (doc/ui-design-plan.md, phases 1 and 3).
//
// Long-running work (decoding, rendering, ROI statistics, analyses) runs in Napi::AsyncWorker threads and returns
// promises. Rejected promises and errors thrown by synchronous validation carry an error `code`: INVALID_ARGUMENT,
// UNSUPPORTED_IMAGE, IMAGE_TOO_LARGE, DECODE_FAILED, INTERNAL_ERROR or CANCELLED (a cancelled feature map).

#include <napi.h>

#include <array>
#include <atomic>
#include <climits>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <functional>
#include <initializer_list>
#include <map>
#include <memory>
#include <opencv2/imgcodecs.hpp>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "imaging/DicomReader.hpp"
#include "imaging/DisplayRenderer.hpp"
#include "imaging/EdgeDetection.hpp"
#include "imaging/ImageLoader.hpp"
#include "imaging/IntensityPlots.hpp"
#include "imaging/NiftiReader.hpp"
#include "imaging/PngEncoder.hpp"
#include "io/Identifiers.hpp"
#include "io/Json.hpp"
#include "io/ResultsCsv.hpp"
#include "io/RoiImageExport.hpp"
#include "pipeline/AnalysisRunner.hpp"
#include "pipeline/AnalysisSettings.hpp"
#include "pipeline/FeatureCatalog.hpp"
#include "pipeline/FeatureMap.hpp"
#include "pipeline/Version.hpp"
#include "roi/Livewire.hpp"
#include "roi/RegionSelection.hpp"
#include "roi/Roi.hpp"
#include "roi/RoiOperations.hpp"

namespace {

const char CODE_INVALID_ARGUMENT[] = "INVALID_ARGUMENT";
const char CODE_UNSUPPORTED_IMAGE[] = "UNSUPPORTED_IMAGE";
const char CODE_DECODE_FAILED[] = "DECODE_FAILED";
const char CODE_IMAGE_TOO_LARGE[] = "IMAGE_TOO_LARGE";
const char CODE_INTERNAL[] = "INTERNAL_ERROR";
const char CODE_CANCELLED[] = "CANCELLED";

bool HostIsLittleEndian() {
    const uint16_t probe = 1;
    return *reinterpret_cast<const uint8_t*>(&probe) == 1;
}

// The rows of a CV_8UC1 or CV_16UC1 image as bytes, with 16-bit samples in little-endian order
std::vector<uint8_t> ToLittleEndianBytes(const cv::Mat& gray) {
    const size_t bytes_per_sample = gray.elemSize();
    const size_t line_bytes = static_cast<size_t>(gray.cols) * bytes_per_sample;
    std::vector<uint8_t> bytes(line_bytes * static_cast<size_t>(gray.rows));
    for (int row = 0; row < gray.rows; ++row) {
        const uint8_t* source = gray.ptr<uint8_t>(row);
        uint8_t* target = bytes.data() + line_bytes * static_cast<size_t>(row);
        if (bytes_per_sample == 1 || HostIsLittleEndian()) {
            std::memcpy(target, source, line_bytes);
        } else {
            for (size_t i = 0; i < line_bytes; i += 2) {
                target[i] = source[i + 1];
                target[i + 1] = source[i];
            }
        }
    }
    return bytes;
}

// CV_8UC1 or CV_16UC1 image from row-major little-endian bytes. The bytes are wrapped without copying when they can be
// read in place (8-bit, or 16-bit on a little-endian host with aligned data); the caller must keep them alive.
cv::Mat FromLittleEndianBytes(const uint8_t* data, int width, int height, int bit_depth) {
    const int type = bit_depth == 16 ? CV_16UC1 : CV_8UC1;
    const bool aligned = reinterpret_cast<uintptr_t>(data) % alignof(uint16_t) == 0;
    if (bit_depth == 8 || (HostIsLittleEndian() && aligned)) {
        // cv::Mat has no read-only header; the workers only read from it
        return cv::Mat(height, width, type, const_cast<void*>(static_cast<const void*>(data)));
    }

    cv::Mat gray(height, width, type);
    const size_t line_bytes = static_cast<size_t>(width) * 2;
    for (int row = 0; row < height; ++row) {
        const uint8_t* source = data + line_bytes * static_cast<size_t>(row);
        uint8_t* target = gray.ptr<uint8_t>(row);
        if (HostIsLittleEndian()) {
            std::memcpy(target, source, line_bytes);
        } else {
            for (size_t i = 0; i < line_bytes; i += 2) {
                target[i] = source[i + 1];
                target[i + 1] = source[i];
            }
        }
    }
    return gray;
}

int IntegerArgument(const Napi::CallbackInfo& info, size_t index, const char* name) {
    if (info.Length() <= index || !info[index].IsNumber()) {
        throw Napi::TypeError::New(info.Env(), std::string(name) + " must be a number");
    }
    const double value = info[index].As<Napi::Number>().DoubleValue();
    if (!std::isfinite(value) || std::floor(value) != value || value < INT_MIN || value > INT_MAX) {
        throw Napi::TypeError::New(info.Env(), std::string(name) + " must be an integer");
    }
    return static_cast<int>(value);
}

std::string StringArgument(const Napi::CallbackInfo& info, size_t index, const char* name) {
    if (info.Length() <= index || !info[index].IsString()) {
        throw Napi::TypeError::New(info.Env(), std::string(name) + " must be a string");
    }
    return info[index].As<Napi::String>().Utf8Value();
}

bool BooleanArgument(const Napi::CallbackInfo& info, size_t index, const char* name) {
    if (info.Length() <= index || !info[index].IsBoolean()) {
        throw Napi::TypeError::New(info.Env(), std::string(name) + " must be a boolean");
    }
    return info[index].As<Napi::Boolean>().Value();
}

Napi::Array StringArray(Napi::Env env, const std::vector<std::string>& values) {
    Napi::Array array = Napi::Array::New(env, values.size());
    for (size_t i = 0; i < values.size(); ++i) {
        array.Set(static_cast<uint32_t>(i), Napi::String::New(env, values[i]));
    }
    return array;
}

Napi::Value NumberOrNull(Napi::Env env, double value) {
    return std::isfinite(value) ? Napi::Number::New(env, value) : env.Null();
}

Napi::Error ErrorWithCode(Napi::Env env, const char* code, const std::string& message) {
    Napi::Error error = Napi::Error::New(env, message);
    error.Set("code", Napi::String::New(env, code));
    return error;
}

// Grayscale pixels passed from JavaScript as (pixels, width, height, bitDepth), starting at argument `first`
struct PixelArguments {
    Napi::Uint8Array pixels;
    int width = 0;
    int height = 0;
    int bit_depth = 0;
};

PixelArguments ReadPixelArguments(const Napi::CallbackInfo& info, size_t first) {
    Napi::Env env = info.Env();
    if (info.Length() <= first || !info[first].IsTypedArray() || info[first].As<Napi::TypedArray>().TypedArrayType() != napi_uint8_array) {
        throw Napi::TypeError::New(env, "pixels must be a Uint8Array or Buffer");
    }
    PixelArguments arguments;
    arguments.pixels = info[first].As<Napi::Uint8Array>();
    arguments.width = IntegerArgument(info, first + 1, "width");
    arguments.height = IntegerArgument(info, first + 2, "height");
    arguments.bit_depth = IntegerArgument(info, first + 3, "bitDepth");

    if (arguments.width <= 0 || arguments.height <= 0) {
        throw Napi::TypeError::New(env, "width and height must be positive");
    }
    if (arguments.bit_depth != 8 && arguments.bit_depth != 16) {
        throw Napi::TypeError::New(env, "bitDepth must be 8 or 16");
    }
    const size_t expected =
        static_cast<size_t>(arguments.width) * static_cast<size_t>(arguments.height) * static_cast<size_t>(arguments.bit_depth / 8);
    if (arguments.pixels.ByteLength() != expected) {
        throw Napi::TypeError::New(
            env, "pixels has " + std::to_string(arguments.pixels.ByteLength()) + " bytes, expected " + std::to_string(expected));
    }
    return arguments;
}

// ROI objects as used in the ROI set file format, parsed from a JSON array
std::vector<glcm::Roi> ParseRois(const std::string& rois_json) {
    return glcm::RoiSetFromJson(R"({"format": "glcm-roi-set", "version": 1, "rois": )" + rois_json + "}").rois;
}

// AsyncWorker that settles a promise and rejects with an Error carrying `code`
class PromiseWorker : public Napi::AsyncWorker {
public:
    explicit PromiseWorker(Napi::Env env) : Napi::AsyncWorker(env), _deferred(Napi::Promise::Deferred::New(env)) {}

    Napi::Promise Promise() const {
        return _deferred.Promise();
    }

protected:
    void Fail(const char* code, const std::string& message) {
        _code = code;
        SetError(message);
    }

    void Resolve(Napi::Value value) {
        _deferred.Resolve(value);
    }

    void OnError(const Napi::Error& error) override {
        _deferred.Reject(ErrorWithCode(Env(), _code.empty() ? CODE_INTERNAL : _code.c_str(), error.Message()).Value());
    }

private:
    Napi::Promise::Deferred _deferred;
    std::string _code;
};

// Worker reading a JavaScript pixel buffer, which it keeps alive until it finishes
class PixelWorker : public PromiseWorker {
public:
    PixelWorker(Napi::Env env, const PixelArguments& arguments)
        : PromiseWorker(env),
          _pixels(Napi::Persistent(arguments.pixels)),
          _data(arguments.pixels.Data()),
          _width(arguments.width),
          _height(arguments.height),
          _bit_depth(arguments.bit_depth) {}

protected:
    cv::Mat Gray() const {
        return FromLittleEndianBytes(_data, _width, _height, _bit_depth);
    }

private:
    Napi::Reference<Napi::Uint8Array> _pixels;
    const uint8_t* _data;
    int _width;
    int _height;
    int _bit_depth;
};

Napi::Value ValueConversionValue(Napi::Env env, const std::optional<glcm::ValueConversion>& conversion) {
    if (!conversion) {
        return env.Null();
    }
    Napi::Object object = Napi::Object::New(env);
    object.Set("scale", Napi::Number::New(env, conversion->scale));
    object.Set("offset", Napi::Number::New(env, conversion->offset));
    object.Set("unit", Napi::String::New(env, conversion->unit));
    object.Set("description", Napi::String::New(env, conversion->description));
    return object;
}

Napi::Value PixelSpacingValue(Napi::Env env, const std::optional<glcm::PixelSpacing>& spacing) {
    if (!spacing) {
        return env.Null();
    }
    Napi::Object object = Napi::Object::New(env);
    object.Set("x", Napi::Number::New(env, spacing->x_mm));
    object.Set("y", Napi::Number::New(env, spacing->y_mm));
    return object;
}

// A decoded image for JavaScript (DecodedImage in index.d.ts)
struct DecodedResult {
    glcm::ImageInfo info;
    std::vector<std::string> warnings;
    glcm::DisplayStatistics statistics;
    std::vector<uint8_t> pixels;
    int slices = 1;

    void Take(const glcm::LoadedImage& image) {
        info = image.info;
        warnings = image.warnings;
        statistics = glcm::ComputeDisplayStatistics(image.gray);
        if (image.window) {
            statistics.window_min = image.window->min;
            statistics.window_max = image.window->max;
        }
        pixels = ToLittleEndianBytes(image.gray);
    }

    // A stack: the pixels of every slice one after the other; the window and histogram over all of them
    void Take(const glcm::LoadedStack& stack) {
        info = stack.info;
        warnings = stack.warnings;
        slices = stack.slices;
        statistics = glcm::ComputeDisplayStatistics(stack.pixels);
        if (stack.window) {
            statistics.window_min = stack.window->min;
            statistics.window_max = stack.window->max;
        }
        pixels = ToLittleEndianBytes(stack.pixels);
    }

    Napi::Object ToObject(Napi::Env env) const {
        Napi::Object result = Napi::Object::New(env);
        result.Set("width", Napi::Number::New(env, info.width));
        result.Set("height", Napi::Number::New(env, info.height));
        result.Set("bitDepth", Napi::Number::New(env, info.bit_depth));
        result.Set("slices", Napi::Number::New(env, slices));
        result.Set("sourceChannels", Napi::Number::New(env, info.source_channels));
        result.Set("pixelSpacing", PixelSpacingValue(env, info.pixel_spacing));
        result.Set("valueConversion", ValueConversionValue(env, info.value_conversion));
        result.Set("warnings", StringArray(env, warnings));
        result.Set("windowMin", Napi::Number::New(env, statistics.window_min));
        result.Set("windowMax", Napi::Number::New(env, statistics.window_max));

        Napi::Array histogram = Napi::Array::New(env, statistics.histogram.size());
        for (size_t i = 0; i < statistics.histogram.size(); ++i) {
            histogram.Set(static_cast<uint32_t>(i), Napi::Number::New(env, static_cast<double>(statistics.histogram[i])));
        }
        result.Set("histogram", histogram);
        result.Set("pixels", Napi::Buffer<uint8_t>::Copy(env, pixels.data(), pixels.size()));
        return result;
    }
};

class DecodeImageWorker : public PromiseWorker {
public:
    DecodeImageWorker(Napi::Env env, std::string path, int64_t max_pixels, int64_t max_stack_pixels)
        : PromiseWorker(env), _path(std::move(path)), _max_pixels(max_pixels), _max_stack_pixels(max_stack_pixels) {}

    void Execute() override {
        try {
            _result.Take(glcm::LoadImageStackFile(_path, _max_pixels, _max_stack_pixels));
        } catch (const glcm::ImageTooLargeError& error) {
            Fail(CODE_IMAGE_TOO_LARGE, error.what());
        } catch (const glcm::StackTooLargeError& error) {
            Fail(CODE_IMAGE_TOO_LARGE, error.what());
        } catch (const std::invalid_argument& error) {
            Fail(CODE_UNSUPPORTED_IMAGE, error.what());
        } catch (const std::exception& error) {
            Fail(CODE_DECODE_FAILED, error.what());
        }
    }

    void OnOK() override {
        Resolve(_result.ToObject(Env()));
    }

private:
    std::string _path;
    int64_t _max_pixels;
    int64_t _max_stack_pixels;
    DecodedResult _result;
};

// A stack made on the server (NIfTI volume, DICOM series), decoded and encoded as a TIFF that stands for its original file
class StackWorker : public PromiseWorker {
public:
    using Load = std::function<glcm::LoadedStack()>;

    StackWorker(Napi::Env env, Load load) : PromiseWorker(env), _load(std::move(load)) {}

    void Execute() override {
        try {
            glcm::LoadedStack stack = _load();
            _result.Take(stack);
            _tiff = glcm::EncodeTiffStack(stack);
            _series_description = stack.series_description;
        } catch (const glcm::ImageTooLargeError& error) {
            Fail(CODE_IMAGE_TOO_LARGE, error.what());
        } catch (const glcm::StackTooLargeError& error) {
            Fail(CODE_IMAGE_TOO_LARGE, error.what());
        } catch (const std::invalid_argument& error) {
            Fail(CODE_UNSUPPORTED_IMAGE, error.what());
        } catch (const std::exception& error) {
            Fail(CODE_DECODE_FAILED, error.what());
        }
    }

    void OnOK() override {
        Napi::Env env = Env();
        Napi::Object result = _result.ToObject(env);
        result.Set("tiff", Napi::Buffer<uint8_t>::Copy(env, _tiff.data(), _tiff.size()));
        result.Set("seriesDescription", Napi::String::New(env, _series_description));
        Resolve(result);
    }

private:
    Load _load;
    DecodedResult _result;
    std::vector<uchar> _tiff;
    std::string _series_description;
};

const char* StorageKindId(glcm::StorageKind kind) {
    switch (kind) {
        case glcm::StorageKind::Identity:
            return "identity";
        case glcm::StorageKind::Offset:
            return "offset";
        case glcm::StorageKind::Linear:
            return "linear";
    }
    return "identity";
}

class InspectNiftiVolumeWorker : public PromiseWorker {
public:
    InspectNiftiVolumeWorker(Napi::Env env, std::string path, std::string copy_path, uint64_t max_bytes)
        : PromiseWorker(env), _path(std::move(path)), _copy_path(std::move(copy_path)), _max_bytes(max_bytes) {}

    void Execute() override {
        try {
            _info = glcm::InspectNiftiVolume(_path, _copy_path, _max_bytes);
        } catch (const glcm::VolumeTooLargeError& error) {
            Fail(CODE_IMAGE_TOO_LARGE, error.what());
        } catch (const std::invalid_argument& error) {
            Fail(CODE_UNSUPPORTED_IMAGE, error.what());
        } catch (const std::exception& error) {
            Fail(CODE_DECODE_FAILED, error.what());
        }
    }

    void OnOK() override {
        Napi::Env env = Env();
        Napi::Object result = Napi::Object::New(env);
        result.Set("version", Napi::Number::New(env, _info.version));
        Napi::Array dimensions = Napi::Array::New(env, 3);
        for (uint32_t axis = 0; axis < 3; ++axis) {
            dimensions.Set(axis, Napi::Number::New(env, static_cast<double>(_info.dimensions[axis])));
        }
        result.Set("dimensions", dimensions);
        result.Set("volumes", Napi::Number::New(env, static_cast<double>(_info.volumes)));
        result.Set("dataType", Napi::String::New(env, _info.data_type));
        result.Set("orientationSource", Napi::String::New(env, _info.orientation_source));
        result.Set("axisCodes", Napi::String::New(env, _info.axis_codes));
        result.Set("acquisitionOrientation", Napi::String::New(env, glcm::SliceOrientationId(_info.acquisition_orientation)));
        Napi::Object slices = Napi::Object::New(env);
        for (int orientation = 0; orientation < 3; ++orientation) {
            const glcm::SliceGeometry& geometry = _info.slices[orientation];
            Napi::Object slice = Napi::Object::New(env);
            slice.Set("count", Napi::Number::New(env, static_cast<double>(geometry.count)));
            slice.Set("width", Napi::Number::New(env, static_cast<double>(geometry.width)));
            slice.Set("height", Napi::Number::New(env, static_cast<double>(geometry.height)));
            slice.Set("pixelSpacing", PixelSpacingValue(env, geometry.pixel_spacing));
            slices.Set(glcm::SliceOrientationId(static_cast<glcm::SliceOrientation>(orientation)), slice);
        }
        result.Set("slices", slices);
        result.Set("minimum", Napi::Number::New(env, _info.minimum));
        result.Set("maximum", Napi::Number::New(env, _info.maximum));
        Napi::Object storage = Napi::Object::New(env);
        storage.Set("kind", Napi::String::New(env, StorageKindId(_info.storage.kind)));
        storage.Set("bitDepth", Napi::Number::New(env, _info.storage.bit_depth));
        storage.Set("scale", Napi::Number::New(env, _info.storage.scale));
        storage.Set("offset", Napi::Number::New(env, _info.storage.offset));
        result.Set("storage", storage);
        result.Set("valueConversion", ValueConversionValue(env, _info.value_conversion));
        result.Set("windowMin", Napi::Number::New(env, _info.window.min));
        result.Set("windowMax", Napi::Number::New(env, _info.window.max));
        result.Set("warnings", StringArray(env, _info.warnings));
        Resolve(result);
    }

private:
    std::string _path;
    std::string _copy_path;
    uint64_t _max_bytes;
    glcm::NiftiVolumeInfo _info;
};

struct SliceRequest {
    glcm::SliceOrientation orientation = glcm::SliceOrientation::Axial;
    int64_t slice = 0;
    int64_t volume = 0;
    glcm::StorageChoice storage;
    int64_t max_pixels = 0;
    bool encode_png = false;
};

class ExtractNiftiSliceWorker : public PromiseWorker {
public:
    ExtractNiftiSliceWorker(Napi::Env env, std::string path, SliceRequest request)
        : PromiseWorker(env), _path(std::move(path)), _request(request) {}

    void Execute() override {
        try {
            const glcm::LoadedImage image = glcm::ExtractNiftiSlice(
                _path, _request.orientation, _request.slice, _request.volume, _request.storage, _request.max_pixels);
            _result.Take(image);
            if (_request.encode_png) {
                _png = glcm::EncodePng(image.gray, image.info.pixel_spacing);
            }
        } catch (const glcm::ImageTooLargeError& error) {
            Fail(CODE_IMAGE_TOO_LARGE, error.what());
        } catch (const std::invalid_argument& error) {
            Fail(CODE_INVALID_ARGUMENT, error.what());
        } catch (const std::exception& error) {
            Fail(CODE_DECODE_FAILED, error.what());
        }
    }

    void OnOK() override {
        Napi::Env env = Env();
        Napi::Object result = _result.ToObject(env);
        result.Set("png", _request.encode_png ? Napi::Buffer<uint8_t>::Copy(env, _png.data(), _png.size()).As<Napi::Value>() : env.Null());
        Resolve(result);
    }

private:
    std::string _path;
    SliceRequest _request;
    DecodedResult _result;
    std::vector<uchar> _png;
};

class RenderDisplayWorker : public PixelWorker {
public:
    RenderDisplayWorker(Napi::Env env, const PixelArguments& arguments, int window_min, int window_max, int max_size)
        : PixelWorker(env, arguments), _window_min(window_min), _window_max(window_max), _max_size(max_size) {}

    void Execute() override {
        try {
            const cv::Mat rendered = glcm::RenderWindowLevel(Gray(), _window_min, _window_max, _max_size);
            if (!cv::imencode(".png", rendered, _png)) {
                Fail(CODE_INTERNAL, "Cannot encode the PNG image");
            }
        } catch (const std::invalid_argument& error) {
            Fail(CODE_INVALID_ARGUMENT, error.what());
        } catch (const std::exception& error) {
            Fail(CODE_INTERNAL, error.what());
        }
    }

    void OnOK() override {
        Resolve(Napi::Buffer<uint8_t>::Copy(Env(), _png.data(), _png.size()));
    }

private:
    int _window_min;
    int _window_max;
    int _max_size;
    std::vector<uchar> _png;
};

struct RoiStatisticsResult {
    std::string error; // non-empty when the geometry is invalid
    glcm::RegionStatistics statistics;
    cv::Rect bounding_box;
};

class RoiStatsWorker : public PixelWorker {
public:
    RoiStatsWorker(Napi::Env env, const PixelArguments& arguments, std::string rois_json)
        : PixelWorker(env, arguments), _rois_json(std::move(rois_json)) {}

    void Execute() override {
        std::vector<glcm::Roi> rois;
        try {
            rois = ParseRois(_rois_json);
        } catch (const std::invalid_argument& error) {
            Fail(CODE_INVALID_ARGUMENT, error.what());
            return;
        }
        try {
            const cv::Mat gray = Gray();
            for (const glcm::Roi& roi : rois) {
                RoiStatisticsResult result;
                try {
                    // Only the box around the ROI is rasterized and visited
                    const glcm::CroppedMask cropped = glcm::RasterizeCroppedMask(roi.shape, gray.size());
                    if (!cropped.mask.empty()) {
                        result.statistics = glcm::ComputeRegionStatistics(gray(cropped.box), cropped.mask);
                        const cv::Rect box = glcm::MaskBoundingBox(cropped.mask);
                        result.bounding_box = box.area() > 0 ? box + cropped.box.tl() : cv::Rect();
                    }
                } catch (const std::invalid_argument& error) {
                    result.error = error.what();
                }
                _results.push_back(result);
            }
        } catch (const std::exception& error) {
            Fail(CODE_INTERNAL, error.what());
        }
    }

    void OnOK() override {
        Napi::Env env = Env();
        Napi::Array array = Napi::Array::New(env, _results.size());
        for (size_t i = 0; i < _results.size(); ++i) {
            const RoiStatisticsResult& result = _results[i];
            const glcm::RegionStatistics& statistics = result.statistics;
            const bool empty = statistics.pixel_count == 0;

            Napi::Object item = Napi::Object::New(env);
            item.Set("pixelCount", Napi::Number::New(env, statistics.pixel_count));
            if (empty) {
                item.Set("boundingBox", env.Null());
            } else {
                Napi::Object box = Napi::Object::New(env);
                box.Set("x", result.bounding_box.x);
                box.Set("y", result.bounding_box.y);
                box.Set("width", result.bounding_box.width);
                box.Set("height", result.bounding_box.height);
                item.Set("boundingBox", box);
            }
            item.Set("min", empty ? env.Null() : Napi::Number::New(env, statistics.min));
            item.Set("max", empty ? env.Null() : Napi::Number::New(env, statistics.max));
            item.Set("mean", NumberOrNull(env, statistics.mean));
            item.Set("std", NumberOrNull(env, statistics.std));
            item.Set("error", result.error.empty() ? env.Null() : Napi::String::New(env, result.error));
            array.Set(static_cast<uint32_t>(i), item);
        }
        Resolve(array);
    }

private:
    std::string _rois_json;
    std::vector<RoiStatisticsResult> _results;
};

class RunAnalysisWorker : public PixelWorker {
public:
    RunAnalysisWorker(Napi::Env env, const PixelArguments& arguments, std::string rois_json, std::string settings_json,
        std::optional<glcm::PixelSpacing> pixel_spacing)
        : PixelWorker(env, arguments),
          _rois_json(std::move(rois_json)),
          _settings_json(std::move(settings_json)),
          _pixel_spacing(pixel_spacing) {}

    void Execute() override {
        glcm::AnalysisSettings settings;
        std::vector<glcm::Roi> rois;
        try {
            rois = ParseRois(_rois_json);
            settings = glcm::SettingsFromJson(_settings_json);
            glcm::ValidateSettings(settings);
        } catch (const std::invalid_argument& error) {
            Fail(CODE_INVALID_ARGUMENT, error.what());
            return;
        }
        try {
            const glcm::AnalysisOutput output = glcm::RunAnalysis(Gray(), rois, settings, nullptr, _pixel_spacing);
            _json = glcm::ResultsToJson(output.results, settings, glcm::ExportContext{});
        } catch (const std::invalid_argument& error) {
            Fail(CODE_INVALID_ARGUMENT, error.what());
        } catch (const std::exception& error) {
            Fail(CODE_INTERNAL, error.what());
        }
    }

    void OnOK() override {
        Resolve(Napi::String::New(Env(), _json));
    }

private:
    std::string _rois_json;
    std::string _settings_json;
    std::optional<glcm::PixelSpacing> _pixel_spacing;
    std::string _json;
};

class ExportRoiImagesWorker : public PixelWorker {
public:
    ExportRoiImagesWorker(Napi::Env env, const PixelArguments& arguments, std::string rois_json, std::string settings_json,
        const glcm::RoiImageExportOptions& options)
        : PixelWorker(env, arguments), _rois_json(std::move(rois_json)), _settings_json(std::move(settings_json)), _options(options) {}

    void Execute() override {
        std::vector<glcm::Roi> rois;
        glcm::AnalysisSettings settings;
        try {
            rois = ParseRois(_rois_json);
            if (!_settings_json.empty()) {
                settings = glcm::SettingsFromJson(_settings_json);
                glcm::ValidateSettings(settings);
            } else if (_options.include_quantized) {
                throw std::invalid_argument("Quantized ROI images need analysis settings");
            }
        } catch (const std::invalid_argument& error) {
            Fail(CODE_INVALID_ARGUMENT, error.what());
            return;
        }
        try {
            _files = glcm::ExportRoiImages(Gray(), rois, settings, _options);
        } catch (const std::invalid_argument& error) {
            Fail(CODE_INVALID_ARGUMENT, error.what());
        } catch (const std::exception& error) {
            Fail(CODE_INTERNAL, error.what());
        }
    }

    void OnOK() override {
        Napi::Env env = Env();
        Napi::Array array = Napi::Array::New(env, _files.size());
        for (size_t i = 0; i < _files.size(); ++i) {
            Napi::Object file = Napi::Object::New(env);
            file.Set("name", _files[i].name);
            file.Set("data", Napi::Buffer<uint8_t>::Copy(env, _files[i].bytes.data(), _files[i].bytes.size()));
            array.Set(static_cast<uint32_t>(i), file);
        }
        Resolve(array);
    }

private:
    std::string _rois_json;
    std::string _settings_json;
    glcm::RoiImageExportOptions _options;
    std::vector<glcm::ExportedFile> _files;
};

Napi::Value CoreVersion(const Napi::CallbackInfo& info) {
    return Napi::String::New(info.Env(), glcm::CORE_VERSION);
}

Napi::Value Catalog(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    const auto& catalog = glcm::FeatureCatalog();

    Napi::Array features = Napi::Array::New(env, catalog.size());
    for (size_t i = 0; i < catalog.size(); ++i) {
        const glcm::FeatureInfo& feature = catalog[i];
        Napi::Object item = Napi::Object::New(env);
        item.Set("id", feature.id);
        item.Set("name", feature.name);
        item.Set("group", glcm::FeatureGroupId(feature.group));
        item.Set("nonStandard", feature.non_standard);
        item.Set("nonStandardReason", feature.non_standard_reason);
        item.Set("docAnchor", feature.doc_anchor);
        item.Set("cost", feature.cost == glcm::FeatureCost::Slow ? "slow" : "normal");
        features.Set(static_cast<uint32_t>(i), item);
    }

    const auto& presets = glcm::FeaturePresets();
    Napi::Array preset_array = Napi::Array::New(env, presets.size());
    for (size_t i = 0; i < presets.size(); ++i) {
        const glcm::FeaturePreset& preset = presets[i];
        std::vector<std::string> ids;
        for (const glcm::FeatureInfo& feature : catalog) {
            if (preset.features.count(feature.type) > 0) {
                ids.push_back(feature.id);
            }
        }
        Napi::Object item = Napi::Object::New(env);
        item.Set("id", preset.id);
        item.Set("name", preset.name);
        item.Set("features", StringArray(env, ids));
        item.Set("enablesScore", preset.enables_score);
        preset_array.Set(static_cast<uint32_t>(i), item);
    }

    Napi::Array directions = Napi::Array::New(env, glcm::DIRECTIONS_BY_ANGLE.size());
    for (size_t i = 0; i < glcm::DIRECTIONS_BY_ANGLE.size(); ++i) {
        directions.Set(static_cast<uint32_t>(i), Napi::Number::New(env, glcm::DirectionAngle(glcm::DIRECTIONS_BY_ANGLE[i])));
    }

    const glcm::ScoreCoefficients coefficients;
    Napi::Object default_coefficients = Napi::Object::New(env);
    default_coefficients.Set("age", coefficients.age);
    default_coefficients.Set("mean", coefficients.mean);
    default_coefficients.Set("entropy", coefficients.entropy);
    default_coefficients.Set("contrast", coefficients.contrast);

    Napi::Object limits = Napi::Object::New(env);
    limits.Set("minGrayLevels", Napi::Number::New(env, glcm::MIN_GRAY_LEVELS));
    limits.Set("maxGrayLevels", Napi::Number::New(env, glcm::MAX_GRAY_LEVELS));
    limits.Set("defaultGrayLevels", Napi::Number::New(env, glcm::AnalysisSettings().gray_levels));
    limits.Set("maxDistance", Napi::Number::New(env, glcm::MAX_DISTANCE));
    limits.Set("directions", directions);
    limits.Set("quantizationMethods", StringArray(env, {glcm::QuantizationMethodId(glcm::QuantizationMethod::FixedRange),
                                                           glcm::QuantizationMethodId(glcm::QuantizationMethod::RoiMinMax),
                                                           glcm::QuantizationMethodId(glcm::QuantizationMethod::FixedBinWidth),
                                                           glcm::QuantizationMethodId(glcm::QuantizationMethod::None)}));
    limits.Set("aggregations",
        StringArray(env, {glcm::AggregationId(glcm::Aggregation::PerDirectionAndMean), glcm::AggregationId(glcm::Aggregation::MeanOnly),
                             glcm::AggregationId(glcm::Aggregation::MeanAndRange)}));
    limits.Set("logBases", StringArray(env, {glcm::LogBaseId(glcm::LogBase::Natural), glcm::LogBaseId(glcm::LogBase::Two)}));
    limits.Set("scoreProfiles", StringArray(env, {glcm::ScoreProfileId(glcm::ScoreProfile::Calibration),
                                                     glcm::ScoreProfileId(glcm::ScoreProfile::CurrentSettings)}));
    limits.Set("defaultScoreCoefficients", default_coefficients);

    Napi::Object result = Napi::Object::New(env);
    result.Set("features", features);
    result.Set("presets", preset_array);
    result.Set("limits", limits);
    return result;
}

// maxPixels of an optional options object at `index`; 0 (no limit) when absent
int64_t MaxPixelsOption(const Napi::CallbackInfo& info, size_t index) {
    if (info.Length() <= index || info[index].IsUndefined()) {
        return 0;
    }
    if (!info[index].IsObject()) {
        throw Napi::TypeError::New(info.Env(), "options must be an object");
    }
    const Napi::Value value = info[index].As<Napi::Object>().Get("maxPixels");
    if (value.IsUndefined()) {
        return 0;
    }
    const double number = value.IsNumber() ? value.As<Napi::Number>().DoubleValue() : -1.0;
    if (!std::isfinite(number) || std::floor(number) != number || number < 0 || number > 9007199254740991.0) {
        throw Napi::TypeError::New(info.Env(), "options.maxPixels must be a non-negative integer");
    }
    return static_cast<int64_t>(number);
}

// maxStackPixels of an optional options object at `index`; 0 (no limit) when absent
int64_t MaxStackPixelsOption(const Napi::CallbackInfo& info, size_t index) {
    if (info.Length() <= index || !info[index].IsObject()) {
        return 0;
    }
    const Napi::Value value = info[index].As<Napi::Object>().Get("maxStackPixels");
    if (value.IsUndefined()) {
        return 0;
    }
    const double number = value.IsNumber() ? value.As<Napi::Number>().DoubleValue() : -1.0;
    if (!std::isfinite(number) || std::floor(number) != number || number < 0 || number > 9007199254740991.0) {
        throw Napi::TypeError::New(info.Env(), "options.maxStackPixels must be a non-negative integer");
    }
    return static_cast<int64_t>(number);
}

// decodeImageFile(path: string, options?: {maxPixels?, maxStackPixels?}): Promise<DecodedImage>
Napi::Value DecodeImageFile(const Napi::CallbackInfo& info) {
    auto* worker =
        new DecodeImageWorker(info.Env(), StringArgument(info, 0, "path"), MaxPixelsOption(info, 1), MaxStackPixelsOption(info, 1));
    const Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
}

double OptionalNumberField(const Napi::Env& env, const Napi::Object& object, const char* name, double fallback) {
    const Napi::Value value = object.Get(name);
    if (value.IsUndefined()) {
        return fallback;
    }
    if (!value.IsNumber() || !std::isfinite(value.As<Napi::Number>().DoubleValue())) {
        throw Napi::TypeError::New(env, std::string(name) + " must be a finite number");
    }
    return value.As<Napi::Number>().DoubleValue();
}

int64_t IntegerField(const Napi::Env& env, const Napi::Object& object, const char* name) {
    const double value = OptionalNumberField(env, object, name, std::nan(""));
    if (!std::isfinite(value) || std::floor(value) != value || value < 0 || value > 9007199254740991.0) {
        throw Napi::TypeError::New(env, std::string(name) + " must be a non-negative integer");
    }
    return static_cast<int64_t>(value);
}

// inspectNiftiVolume(path, copyPath, options?: {maxBytes?}): Promise<NativeVolumeInfo>
Napi::Value InspectNiftiVolume(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    uint64_t max_bytes = 0;
    if (info.Length() > 2 && !info[2].IsUndefined()) {
        if (!info[2].IsObject()) {
            throw Napi::TypeError::New(env, "options must be an object");
        }
        if (!info[2].As<Napi::Object>().Get("maxBytes").IsUndefined()) {
            max_bytes = static_cast<uint64_t>(IntegerField(env, info[2].As<Napi::Object>(), "maxBytes"));
        }
    }
    auto* worker = new InspectNiftiVolumeWorker(env, StringArgument(info, 0, "path"), StringArgument(info, 1, "copyPath"), max_bytes);
    const Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
}

// The request object of extractNiftiSlice (with_slice) and extractNiftiStack
SliceRequest ParseSliceRequest(const Napi::Env& env, const Napi::Object& object, bool with_slice) {
    SliceRequest request;
    const Napi::Value orientation = object.Get("orientation");
    const std::string orientation_id = orientation.IsString() ? orientation.As<Napi::String>().Utf8Value() : "";
    if (orientation_id == "axial") {
        request.orientation = glcm::SliceOrientation::Axial;
    } else if (orientation_id == "coronal") {
        request.orientation = glcm::SliceOrientation::Coronal;
    } else if (orientation_id == "sagittal") {
        request.orientation = glcm::SliceOrientation::Sagittal;
    } else {
        throw Napi::TypeError::New(env, "orientation must be axial, coronal or sagittal");
    }
    if (with_slice) {
        request.slice = IntegerField(env, object, "slice");
    }
    request.volume = IntegerField(env, object, "volume");
    if (!object.Get("storage").IsObject()) {
        throw Napi::TypeError::New(env, "storage must be an object");
    }
    const Napi::Object storage = object.Get("storage").As<Napi::Object>();
    const Napi::Value kind = storage.Get("kind");
    const std::string kind_id = kind.IsString() ? kind.As<Napi::String>().Utf8Value() : "";
    if (kind_id == "identity") {
        request.storage.kind = glcm::StorageKind::Identity;
    } else if (kind_id == "offset") {
        request.storage.kind = glcm::StorageKind::Offset;
    } else if (kind_id == "linear") {
        request.storage.kind = glcm::StorageKind::Linear;
    } else {
        throw Napi::TypeError::New(env, "storage.kind must be identity, offset or linear");
    }
    request.storage.bit_depth = static_cast<int>(IntegerField(env, storage, "bitDepth"));
    if (request.storage.bit_depth != 8 && request.storage.bit_depth != 16) {
        throw Napi::TypeError::New(env, "storage.bitDepth must be 8 or 16");
    }
    request.storage.scale = OptionalNumberField(env, storage, "scale", 1);
    request.storage.offset = OptionalNumberField(env, storage, "offset", 0);
    if (request.storage.scale == 0) {
        throw Napi::TypeError::New(env, "storage.scale must not be 0");
    }
    if (!object.Get("maxPixels").IsUndefined()) {
        request.max_pixels = IntegerField(env, object, "maxPixels");
    }
    const Napi::Value encode = object.Get("encodePng");
    request.encode_png = encode.IsBoolean() && encode.As<Napi::Boolean>().Value();

    return request;
}

// extractNiftiSlice(path, {orientation, slice, volume, storage, maxPixels?, encodePng?}): Promise<DecodedImage & {png}>
Napi::Value ExtractNiftiSlice(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    const std::string path = StringArgument(info, 0, "path");
    if (info.Length() <= 1 || !info[1].IsObject()) {
        throw Napi::TypeError::New(env, "request must be an object");
    }
    const Napi::Object object = info[1].As<Napi::Object>();
    const SliceRequest request = ParseSliceRequest(env, object, true);

    auto* worker = new ExtractNiftiSliceWorker(env, path, request);
    const Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
}

// extractNiftiStack(path, {orientation, volume, storage, maxPixels?, maxStackPixels?}): Promise<DecodedImage & {tiff}>
Napi::Value ExtractNiftiStack(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    const std::string path = StringArgument(info, 0, "path");
    if (info.Length() <= 1 || !info[1].IsObject()) {
        throw Napi::TypeError::New(env, "request must be an object");
    }
    // The same fields as extractNiftiSlice, with slice 0
    Napi::Object object = info[1].As<Napi::Object>();
    const SliceRequest request = ParseSliceRequest(env, object, false);
    const int64_t max_stack_pixels = MaxStackPixelsOption(info, 1);
    auto* worker = new StackWorker(env, [path, request, max_stack_pixels] {
        return glcm::ExtractNiftiStack(path, request.orientation, request.volume, request.storage, request.max_pixels, max_stack_pixels);
    });
    const Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
}

// decodeDicomSeries(paths: string[], options?: {maxPixels?, maxStackPixels?}): Promise<DecodedImage & {tiff, seriesDescription}>
Napi::Value DecodeDicomSeries(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsArray()) {
        throw Napi::TypeError::New(env, "paths must be an array of strings");
    }
    const Napi::Array array = info[0].As<Napi::Array>();
    std::vector<std::string> paths;
    for (uint32_t i = 0; i < array.Length(); ++i) {
        if (!array.Get(i).IsString()) {
            throw Napi::TypeError::New(env, "paths must be an array of strings");
        }
        paths.push_back(array.Get(i).As<Napi::String>().Utf8Value());
    }
    const int64_t max_pixels = MaxPixelsOption(info, 1);
    const int64_t max_stack_pixels = MaxStackPixelsOption(info, 1);
    auto* worker =
        new StackWorker(env, [paths, max_pixels, max_stack_pixels] { return glcm::LoadDicomSeries(paths, max_pixels, max_stack_pixels); });
    const Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
}

// renderDisplay(pixels, width, height, bitDepth, windowMin, windowMax, maxSize): Promise<Buffer> (PNG)
Napi::Value RenderDisplay(const Napi::CallbackInfo& info) {
    const PixelArguments pixels = ReadPixelArguments(info, 0);
    const int window_min = IntegerArgument(info, 4, "windowMin");
    const int window_max = IntegerArgument(info, 5, "windowMax");
    const int max_size = IntegerArgument(info, 6, "maxSize");

    auto* worker = new RenderDisplayWorker(info.Env(), pixels, window_min, window_max, max_size);
    const Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
}

// roiStats(pixels, width, height, bitDepth, roisJson): Promise<RoiStatistics[]>
Napi::Value RoiStats(const Napi::CallbackInfo& info) {
    const PixelArguments pixels = ReadPixelArguments(info, 0);
    auto* worker = new RoiStatsWorker(info.Env(), pixels, StringArgument(info, 4, "roisJson"));
    const Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
}

// validateAnalysis(roisJson, settingsJson): throws an Error with code INVALID_ARGUMENT when either is invalid
Napi::Value ValidateAnalysis(const Napi::CallbackInfo& info) {
    const std::string rois_json = StringArgument(info, 0, "roisJson");
    const std::string settings_json = StringArgument(info, 1, "settingsJson");
    try {
        ParseRois(rois_json);
        glcm::ValidateSettings(glcm::SettingsFromJson(settings_json));
    } catch (const std::invalid_argument& error) {
        throw ErrorWithCode(info.Env(), CODE_INVALID_ARGUMENT, error.what());
    } catch (const std::exception& error) {
        // Without this, e.g. std::bad_alloc would cross the Node-API boundary and terminate the process
        throw ErrorWithCode(info.Env(), CODE_INTERNAL, error.what());
    }
    return info.Env().Undefined();
}

// runAnalysis(pixels, width, height, bitDepth, roisJson, settingsJson, pixelSpacing?): Promise<string> (glcm-results JSON)
Napi::Value RunAnalysis(const Napi::CallbackInfo& info) {
    const PixelArguments pixels = ReadPixelArguments(info, 0);
    // Optional pixelSpacing {x, y} in mm (shape features are then in mm); null or absent: pixels
    std::optional<glcm::PixelSpacing> spacing;
    if (info.Length() > 6 && !info[6].IsNull() && !info[6].IsUndefined()) {
        if (!info[6].IsObject()) {
            throw Napi::TypeError::New(info.Env(), "pixelSpacing must be an object {x, y} or null");
        }
        const Napi::Object object = info[6].As<Napi::Object>();
        if (!object.Get("x").IsNumber() || !object.Get("y").IsNumber()) {
            throw Napi::TypeError::New(info.Env(), "pixelSpacing must have numbers x and y");
        }
        spacing = glcm::PixelSpacing{object.Get("x").As<Napi::Number>().DoubleValue(), object.Get("y").As<Napi::Number>().DoubleValue()};
    }
    auto* worker =
        new RunAnalysisWorker(info.Env(), pixels, StringArgument(info, 4, "roisJson"), StringArgument(info, 5, "settingsJson"), spacing);
    const Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
}

// formatResults(resultsJson, format): string; a "glcm-results" document written again by glcm_core as "csv" or "json"
Napi::Value FormatResults(const Napi::CallbackInfo& info) {
    const std::string text = StringArgument(info, 0, "resultsJson");
    const std::string format = StringArgument(info, 1, "format");
    if (format != "csv" && format != "json") {
        throw Napi::TypeError::New(info.Env(), "format must be \"csv\" or \"json\"");
    }
    try {
        const glcm::ResultsDocument document = glcm::ResultsFromJson(text);
        const std::string output = format == "csv" ? glcm::ResultsToCsv(document.results, document.settings, document.context)
                                                   : glcm::ResultsToJson(document.results, document.settings, document.context);
        return Napi::String::New(info.Env(), output);
    } catch (const std::invalid_argument& error) {
        throw ErrorWithCode(info.Env(), CODE_INVALID_ARGUMENT, error.what());
    } catch (const std::exception& error) {
        // Without this, e.g. std::bad_alloc for a huge document would cross the Node-API boundary and terminate the process
        throw ErrorWithCode(info.Env(), CODE_INTERNAL, error.what());
    }
}

// exportRoiImages(pixels, width, height, bitDepth, roisJson, settingsJson, transparentOutside, includeQuantized):
// Promise<{name, data}[]>; settingsJson may be empty unless includeQuantized
Napi::Value ExportRoiImages(const Napi::CallbackInfo& info) {
    const PixelArguments pixels = ReadPixelArguments(info, 0);
    glcm::RoiImageExportOptions options;
    options.transparent_outside = BooleanArgument(info, 6, "transparentOutside");
    options.include_quantized = BooleanArgument(info, 7, "includeQuantized");
    auto* worker = new ExportRoiImagesWorker(
        info.Env(), pixels, StringArgument(info, 4, "roisJson"), StringArgument(info, 5, "settingsJson"), options);
    const Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
}

// windowLevel(value, windowMin, windowMax): number
Napi::Value WindowLevel(const Napi::CallbackInfo& info) {
    const int value = IntegerArgument(info, 0, "value");
    const int window_min = IntegerArgument(info, 1, "windowMin");
    const int window_max = IntegerArgument(info, 2, "windowMax");
    return Napi::Number::New(info.Env(), glcm::WindowLevel(value, window_min, window_max));
}

// Marks CancelToken objects, so that computeFeatureMap never unwraps another kind of object
const napi_type_tag CANCEL_TOKEN_TAG = {0x8a4f2c1e5b7d4e3aULL, 0x9c6b1f0d2e8a7c55ULL};

// new CancelToken(): cancel() makes the computeFeatureMap calls that received the token stop after their current point
class CancelToken : public Napi::ObjectWrap<CancelToken> {
public:
    static Napi::Function Define(Napi::Env env) {
        return DefineClass(env, "CancelToken",
            {InstanceMethod("cancel", &CancelToken::Cancel), InstanceAccessor("cancelled", &CancelToken::Cancelled, nullptr)});
    }

    explicit CancelToken(const Napi::CallbackInfo& info)
        : Napi::ObjectWrap<CancelToken>(info), _flag(std::make_shared<std::atomic<bool>>(false)) {
        info.This().As<Napi::Object>().TypeTag(&CANCEL_TOKEN_TAG);
    }

    std::shared_ptr<std::atomic<bool>> Flag() const {
        return _flag;
    }

private:
    void Cancel(const Napi::CallbackInfo& /*info*/) {
        _flag->store(true);
    }

    Napi::Value Cancelled(const Napi::CallbackInfo& info) {
        return Napi::Boolean::New(info.Env(), _flag->load());
    }

    // Shared with the workers, which may outlive the JavaScript object
    std::shared_ptr<std::atomic<bool>> _flag;
};

class FeatureMapWorker : public PixelWorker {
public:
    FeatureMapWorker(Napi::Env env, const PixelArguments& arguments, std::string settings_json, int first_row, int row_count,
        std::shared_ptr<std::atomic<bool>> cancel)
        : PixelWorker(env, arguments),
          _settings_json(std::move(settings_json)),
          _first_row(first_row),
          _row_count(row_count),
          _cancel(std::move(cancel)) {}

    void Execute() override {
        try {
            _values = glcm::ComputeFeatureMapRows(
                Gray(), glcm::FeatureMapSettingsFromJson(_settings_json), _first_row, _row_count, _cancel.get());
        } catch (const glcm::FeatureMapCancelled& error) {
            Fail(CODE_CANCELLED, error.what());
        } catch (const std::invalid_argument& error) {
            Fail(CODE_INVALID_ARGUMENT, error.what());
        } catch (const std::exception& error) {
            Fail(CODE_INTERNAL, error.what());
        }
    }

    void OnOK() override {
        Napi::Float32Array values = Napi::Float32Array::New(Env(), _values.size());
        if (!_values.empty()) {
            std::memcpy(values.Data(), _values.data(), _values.size() * sizeof(float));
        }
        Resolve(values);
    }

private:
    std::string _settings_json;
    int _first_row;
    int _row_count;
    std::shared_ptr<std::atomic<bool>> _cancel;
    std::vector<float> _values;
};

// featureMapGrid(settingsJson, width, height): {step, columns, rows}; throws an Error with code INVALID_ARGUMENT when the
// settings are invalid for an image of this size
Napi::Value FeatureMapGridInfo(const Napi::CallbackInfo& info) {
    const std::string settings_json = StringArgument(info, 0, "settingsJson");
    const int width = IntegerArgument(info, 1, "width");
    const int height = IntegerArgument(info, 2, "height");
    Napi::Env env = info.Env();
    try {
        const glcm::FeatureMapSettings settings = glcm::FeatureMapSettingsFromJson(settings_json);
        glcm::ValidateFeatureMapSettings(settings);
        const glcm::FeatureMapGrid grid = glcm::ResolveFeatureMapGrid(width, height, settings.step);
        Napi::Object result = Napi::Object::New(env);
        result.Set("step", grid.step);
        result.Set("columns", grid.columns);
        result.Set("rows", grid.rows);
        result.Set("workPerRow", glcm::FeatureMapRowWork(settings, width, height));
        return result;
    } catch (const std::invalid_argument& error) {
        throw ErrorWithCode(env, CODE_INVALID_ARGUMENT, error.what());
    } catch (const std::exception& error) {
        throw ErrorWithCode(env, CODE_INTERNAL, error.what());
    }
}

// computeFeatureMap(pixels, width, height, bitDepth, settingsJson, firstRow, rowCount, cancelToken?): Promise<Float32Array> of
// rowCount × columns values (glcm::ComputeFeatureMapRows); rejects with code CANCELLED once the token is cancelled
Napi::Value ComputeFeatureMap(const Napi::CallbackInfo& info) {
    const PixelArguments pixels = ReadPixelArguments(info, 0);
    std::shared_ptr<std::atomic<bool>> cancel;
    if (info.Length() > 7 && !info[7].IsUndefined()) {
        if (!info[7].IsObject() || !info[7].As<Napi::Object>().CheckTypeTag(&CANCEL_TOKEN_TAG)) {
            throw Napi::TypeError::New(info.Env(), "cancelToken must be a CancelToken");
        }
        cancel = CancelToken::Unwrap(info[7].As<Napi::Object>())->Flag();
    }
    auto* worker = new FeatureMapWorker(info.Env(), pixels, StringArgument(info, 4, "settingsJson"), IntegerArgument(info, 5, "firstRow"),
        IntegerArgument(info, 6, "rowCount"), std::move(cancel));
    const Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
}

// {points: [[x, y], ...], pixelCount, boundingBox: {x, y, width, height}}
Napi::Object SelectedRegionToJs(Napi::Env env, const glcm::SelectedRegion& region) {
    Napi::Array points = Napi::Array::New(env, region.outline.size());
    for (size_t i = 0; i < region.outline.size(); ++i) {
        Napi::Array point = Napi::Array::New(env, 2);
        point.Set(uint32_t{0}, region.outline[i][0]);
        point.Set(uint32_t{1}, region.outline[i][1]);
        points.Set(static_cast<uint32_t>(i), point);
    }
    Napi::Object box = Napi::Object::New(env);
    box.Set("x", region.box.x);
    box.Set("y", region.box.y);
    box.Set("width", region.box.width);
    box.Set("height", region.box.height);
    Napi::Object result = Napi::Object::New(env);
    result.Set("points", points);
    result.Set("pixelCount", region.pixel_count);
    result.Set("boundingBox", box);
    return result;
}

double NumberArgument(const Napi::CallbackInfo& info, size_t index, const char* name);

class ThresholdRegionsWorker : public PixelWorker {
public:
    ThresholdRegionsWorker(Napi::Env env, const PixelArguments& arguments, int min_value, int max_value, int min_pixels, int max_regions,
        int max_pixels, double min_sphericity)
        : PixelWorker(env, arguments),
          _min_value(min_value),
          _max_value(max_value),
          _min_pixels(min_pixels),
          _max_regions(max_regions),
          _max_pixels(max_pixels),
          _min_sphericity(min_sphericity) {}

    void Execute() override {
        try {
            _selection =
                glcm::SelectThresholdRegions(Gray(), _min_value, _max_value, _min_pixels, _max_regions, _max_pixels, _min_sphericity);
        } catch (const std::invalid_argument& error) {
            Fail(CODE_INVALID_ARGUMENT, error.what());
        } catch (const std::exception& error) {
            Fail(CODE_INTERNAL, error.what());
        }
    }

    void OnOK() override {
        Napi::Env env = Env();
        Napi::Array regions = Napi::Array::New(env, _selection.regions.size());
        for (size_t i = 0; i < _selection.regions.size(); ++i) {
            regions.Set(static_cast<uint32_t>(i), SelectedRegionToJs(env, _selection.regions[i]));
        }
        Napi::Object result = Napi::Object::New(env);
        result.Set("regions", regions);
        result.Set("total", _selection.total);
        Resolve(result);
    }

private:
    int _min_value;
    int _max_value;
    int _min_pixels;
    int _max_regions;
    int _max_pixels;
    double _min_sphericity;
    glcm::ThresholdSelection _selection;
};

class WandRegionWorker : public PixelWorker {
public:
    WandRegionWorker(Napi::Env env, const PixelArguments& arguments, int x, int y, int tolerance)
        : PixelWorker(env, arguments), _x(x), _y(y), _tolerance(tolerance) {}

    void Execute() override {
        try {
            _region = glcm::SelectWandRegion(Gray(), _x, _y, _tolerance);
        } catch (const std::invalid_argument& error) {
            Fail(CODE_INVALID_ARGUMENT, error.what());
        } catch (const std::exception& error) {
            Fail(CODE_INTERNAL, error.what());
        }
    }

    void OnOK() override {
        Resolve(_region ? Napi::Value(SelectedRegionToJs(Env(), *_region)) : Env().Null());
    }

private:
    int _x;
    int _y;
    int _tolerance;
    std::optional<glcm::SelectedRegion> _region;
};

// selectThresholdRegions(pixels, width, height, bitDepth, min, max, minPixels, maxRegions, maxPixels?, minSphericity?):
// Promise<{regions, total}> (glcm::SelectThresholdRegions); maxPixels and minSphericity may be omitted or null
Napi::Value SelectThresholdRegions(const Napi::CallbackInfo& info) {
    const PixelArguments pixels = ReadPixelArguments(info, 0);
    const auto given = [&info](size_t index) { return info.Length() > index && !info[index].IsNull() && !info[index].IsUndefined(); };
    const int max_pixels = given(8) ? IntegerArgument(info, 8, "maxPixels") : INT_MAX;
    const double min_sphericity = given(9) ? NumberArgument(info, 9, "minSphericity") : 0.0;
    auto* worker = new ThresholdRegionsWorker(info.Env(), pixels, IntegerArgument(info, 4, "min"), IntegerArgument(info, 5, "max"),
        IntegerArgument(info, 6, "minPixels"), IntegerArgument(info, 7, "maxRegions"), max_pixels, min_sphericity);
    const Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
}

// selectWandRegion(pixels, width, height, bitDepth, x, y, tolerance): Promise<region | null> (glcm::SelectWandRegion)
Napi::Value SelectWandRegion(const Napi::CallbackInfo& info) {
    const PixelArguments pixels = ReadPixelArguments(info, 0);
    auto* worker = new WandRegionWorker(
        info.Env(), pixels, IntegerArgument(info, 4, "x"), IntegerArgument(info, 5, "y"), IntegerArgument(info, 6, "tolerance"));
    const Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
}

// {points, pixelCount, boundingBox} of a shape computed on the pixel grid; boundingBox is null when no pixel is left
Napi::Object OperationResultToJs(Napi::Env env, const glcm::OperationResult& result) {
    Napi::Array points = Napi::Array::New(env, result.polygon.points.size());
    for (size_t i = 0; i < result.polygon.points.size(); ++i) {
        Napi::Array point = Napi::Array::New(env, 2);
        point.Set(uint32_t{0}, result.polygon.points[i][0]);
        point.Set(uint32_t{1}, result.polygon.points[i][1]);
        points.Set(static_cast<uint32_t>(i), point);
    }
    Napi::Object object = Napi::Object::New(env);
    object.Set("points", points);
    object.Set("pixelCount", result.pixel_count);
    if (result.pixel_count > 0) {
        Napi::Object box = Napi::Object::New(env);
        box.Set("x", result.box.x);
        box.Set("y", result.box.y);
        box.Set("width", result.box.width);
        box.Set("height", result.box.height);
        object.Set("boundingBox", box);
    } else {
        object.Set("boundingBox", env.Null());
    }
    return object;
}

cv::Size ImageSizeArguments(const Napi::CallbackInfo& info, size_t first) {
    const int width = IntegerArgument(info, first, "width");
    const int height = IntegerArgument(info, first + 1, "height");
    if (width <= 0 || height <= 0) {
        throw Napi::TypeError::New(info.Env(), "width and height must be positive");
    }
    return {width, height};
}

class CombineRoisWorker : public PromiseWorker {
public:
    CombineRoisWorker(Napi::Env env, std::string rois_json, glcm::RoiOperation operation, cv::Size image_size)
        : PromiseWorker(env), _rois_json(std::move(rois_json)), _operation(operation), _image_size(image_size) {}

    void Execute() override {
        try {
            std::vector<glcm::RoiShape> shapes;
            for (const glcm::Roi& roi : ParseRois(_rois_json)) {
                shapes.push_back(roi.shape);
            }
            _result = glcm::CombineShapes(shapes, _operation, _image_size);
        } catch (const std::invalid_argument& error) {
            Fail(CODE_INVALID_ARGUMENT, error.what());
        } catch (const std::exception& error) {
            Fail(CODE_INTERNAL, error.what());
        }
    }

    void OnOK() override {
        Resolve(OperationResultToJs(Env(), _result));
    }

private:
    std::string _rois_json;
    glcm::RoiOperation _operation;
    cv::Size _image_size;
    glcm::OperationResult _result;
};

class BrushRoiWorker : public PromiseWorker {
public:
    BrushRoiWorker(
        Napi::Env env, std::string rois_json, std::vector<std::array<double, 2>> path, double radius, bool erase, cv::Size image_size)
        : PromiseWorker(env),
          _rois_json(std::move(rois_json)),
          _path(std::move(path)),
          _radius(radius),
          _erase(erase),
          _image_size(image_size) {}

    void Execute() override {
        try {
            const std::vector<glcm::Roi> rois = ParseRois(_rois_json);
            if (rois.size() > 1) {
                throw std::invalid_argument("A brush stroke changes at most one ROI");
            }
            const std::optional<glcm::RoiShape> shape = rois.empty() ? std::nullopt : std::optional<glcm::RoiShape>(rois[0].shape);
            _result = glcm::PaintStroke(shape, _path, _radius, _erase, _image_size);
        } catch (const std::invalid_argument& error) {
            Fail(CODE_INVALID_ARGUMENT, error.what());
        } catch (const std::exception& error) {
            Fail(CODE_INTERNAL, error.what());
        }
    }

    void OnOK() override {
        Resolve(OperationResultToJs(Env(), _result));
    }

private:
    std::string _rois_json;
    std::vector<std::array<double, 2>> _path;
    double _radius;
    bool _erase;
    cv::Size _image_size;
    glcm::OperationResult _result;
};

// combineRois(roisJson, operation, width, height): Promise<{points, pixelCount, boundingBox}> (glcm::CombineShapes);
// operation is "union", "subtract", "intersect" or "xor"
Napi::Value CombineRois(const Napi::CallbackInfo& info) {
    const std::string rois_json = StringArgument(info, 0, "roisJson");
    const std::string name = StringArgument(info, 1, "operation");
    const std::map<std::string, glcm::RoiOperation> operations = {{"union", glcm::RoiOperation::Union},
        {"subtract", glcm::RoiOperation::Subtract}, {"intersect", glcm::RoiOperation::Intersect}, {"xor", glcm::RoiOperation::Xor}};
    const auto operation = operations.find(name);
    if (operation == operations.end()) {
        throw Napi::TypeError::New(info.Env(), "operation must be \"union\", \"subtract\", \"intersect\" or \"xor\"");
    }
    auto* worker = new CombineRoisWorker(info.Env(), rois_json, operation->second, ImageSizeArguments(info, 2));
    const Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
}

// brushRoi(roisJson, path, radius, erase, width, height): Promise<{points, pixelCount, boundingBox}> (glcm::PaintStroke);
// roisJson holds the ROI to change or none, path is a Float64Array [x0, y0, x1, y1, ...]
Napi::Value BrushRoi(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    const std::string rois_json = StringArgument(info, 0, "roisJson");
    if (info.Length() <= 1 || !info[1].IsTypedArray() || info[1].As<Napi::TypedArray>().TypedArrayType() != napi_float64_array) {
        throw Napi::TypeError::New(env, "path must be a Float64Array");
    }
    const Napi::Float64Array flat = info[1].As<Napi::Float64Array>();
    if (flat.ElementLength() == 0 || flat.ElementLength() % 2 != 0) {
        throw Napi::TypeError::New(env, "path must hold x, y pairs");
    }
    std::vector<std::array<double, 2>> path(flat.ElementLength() / 2);
    for (size_t i = 0; i < path.size(); ++i) {
        path[i] = {flat[i * 2], flat[i * 2 + 1]};
    }
    if (info.Length() <= 2 || !info[2].IsNumber()) {
        throw Napi::TypeError::New(env, "radius must be a number");
    }
    const double radius = info[2].As<Napi::Number>().DoubleValue();
    const bool erase = BooleanArgument(info, 3, "erase");
    auto* worker = new BrushRoiWorker(env, rois_json, std::move(path), radius, erase, ImageSizeArguments(info, 4));
    const Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
}

class GrowRoiWorker : public PromiseWorker {
public:
    GrowRoiWorker(
        Napi::Env env, std::string rois_json, glcm::GrowOperation operation, double distance, cv::Point2d spacing, cv::Size image_size)
        : PromiseWorker(env),
          _rois_json(std::move(rois_json)),
          _operation(operation),
          _distance(distance),
          _spacing(spacing),
          _image_size(image_size) {}

    void Execute() override {
        try {
            const std::vector<glcm::Roi> rois = ParseRois(_rois_json);
            if (rois.size() != 1) {
                throw std::invalid_argument("Enlarging, shrinking and bands take exactly one ROI");
            }
            _result = glcm::GrowShape(rois[0].shape, _operation, _distance, _spacing, _image_size);
        } catch (const std::invalid_argument& error) {
            Fail(CODE_INVALID_ARGUMENT, error.what());
        } catch (const std::exception& error) {
            Fail(CODE_INTERNAL, error.what());
        }
    }

    void OnOK() override {
        Resolve(OperationResultToJs(Env(), _result));
    }

private:
    std::string _rois_json;
    glcm::GrowOperation _operation;
    double _distance;
    cv::Point2d _spacing;
    cv::Size _image_size;
    glcm::OperationResult _result;
};

double NumberArgument(const Napi::CallbackInfo& info, size_t index, const char* name) {
    if (info.Length() <= index || !info[index].IsNumber()) {
        throw Napi::TypeError::New(info.Env(), std::string(name) + " must be a number");
    }
    const double value = info[index].As<Napi::Number>().DoubleValue();
    if (!std::isfinite(value)) {
        throw Napi::TypeError::New(info.Env(), std::string(name) + " must be a finite number");
    }
    return value;
}

// growRoi(roisJson, operation, distance, spacingX, spacingY, width, height): Promise<{points, pixelCount, boundingBox}>
// (glcm::GrowShape); roisJson holds one ROI, operation is "enlarge", "shrink" or "band"
Napi::Value GrowRoi(const Napi::CallbackInfo& info) {
    const std::string rois_json = StringArgument(info, 0, "roisJson");
    const std::string name = StringArgument(info, 1, "operation");
    const std::map<std::string, glcm::GrowOperation> operations = {
        {"enlarge", glcm::GrowOperation::Enlarge}, {"shrink", glcm::GrowOperation::Shrink}, {"band", glcm::GrowOperation::Band}};
    const auto operation = operations.find(name);
    if (operation == operations.end()) {
        throw Napi::TypeError::New(info.Env(), "operation must be \"enlarge\", \"shrink\" or \"band\"");
    }
    const double distance = NumberArgument(info, 2, "distance");
    const cv::Point2d spacing(NumberArgument(info, 3, "spacingX"), NumberArgument(info, 4, "spacingY"));
    auto* worker = new GrowRoiWorker(info.Env(), rois_json, operation->second, distance, spacing, ImageSizeArguments(info, 5));
    const Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
}

class GradientStatisticsWorker : public PixelWorker {
public:
    GradientStatisticsWorker(Napi::Env env, const PixelArguments& arguments, double sigma) : PixelWorker(env, arguments), _sigma(sigma) {}

    void Execute() override {
        try {
            _statistics = glcm::ComputeGradientStatistics(Gray(), _sigma);
        } catch (const std::invalid_argument& error) {
            Fail(CODE_INVALID_ARGUMENT, error.what());
        } catch (const std::exception& error) {
            Fail(CODE_INTERNAL, error.what());
        }
    }

    void OnOK() override {
        Napi::Env env = Env();
        Napi::Object percentiles = Napi::Object::New(env);
        percentiles.Set("50", _statistics.p50);
        percentiles.Set("90", _statistics.p90);
        percentiles.Set("95", _statistics.p95);
        percentiles.Set("99", _statistics.p99);
        Napi::Object result = Napi::Object::New(env);
        result.Set("sigma", _sigma);
        result.Set("percentiles", percentiles);
        result.Set("max", _statistics.max);
        Resolve(result);
    }

private:
    double _sigma;
    glcm::GradientStatistics _statistics;
};

class EdgeMapWorker : public PixelWorker {
public:
    EdgeMapWorker(
        Napi::Env env, const PixelArguments& arguments, glcm::EdgeMethod method, double sigma, double low, double high, int max_size)
        : PixelWorker(env, arguments), _method(method), _sigma(sigma), _low(low), _high(high), _max_size(max_size) {}

    void Execute() override {
        try {
            const cv::Mat map = glcm::RenderEdgeMap(Gray(), _method, _sigma, _low, _high, _max_size);
            if (!cv::imencode(".png", map, _png)) {
                Fail(CODE_INTERNAL, "Cannot encode the PNG image");
            }
        } catch (const std::invalid_argument& error) {
            Fail(CODE_INVALID_ARGUMENT, error.what());
        } catch (const std::exception& error) {
            Fail(CODE_INTERNAL, error.what());
        }
    }

    void OnOK() override {
        Resolve(Napi::Buffer<uint8_t>::Copy(Env(), _png.data(), _png.size()));
    }

private:
    glcm::EdgeMethod _method;
    double _sigma;
    double _low;
    double _high;
    int _max_size;
    std::vector<uchar> _png;
};

class LivewireWorker : public PixelWorker {
public:
    LivewireWorker(Napi::Env env, const PixelArguments& arguments, cv::Point from, cv::Point to, double sigma)
        : PixelWorker(env, arguments), _from(from), _to(to), _sigma(sigma) {}

    void Execute() override {
        try {
            _path = glcm::LivewirePath(Gray(), _from, _to, _sigma);
        } catch (const std::invalid_argument& error) {
            Fail(CODE_INVALID_ARGUMENT, error.what());
        } catch (const std::exception& error) {
            Fail(CODE_INTERNAL, error.what());
        }
    }

    void OnOK() override {
        Napi::Env env = Env();
        Napi::Array points = Napi::Array::New(env, _path.size());
        for (size_t i = 0; i < _path.size(); ++i) {
            Napi::Array point = Napi::Array::New(env, 2);
            point.Set(uint32_t{0}, _path[i][0]);
            point.Set(uint32_t{1}, _path[i][1]);
            points.Set(static_cast<uint32_t>(i), point);
        }
        Resolve(points);
    }

private:
    cv::Point _from;
    cv::Point _to;
    double _sigma;
    std::vector<std::array<double, 2>> _path;
};

// gradientStatistics(pixels, width, height, bitDepth, sigma): Promise<{sigma, percentiles, max}> (glcm::ComputeGradientStatistics)
Napi::Value GradientStatistics(const Napi::CallbackInfo& info) {
    const PixelArguments pixels = ReadPixelArguments(info, 0);
    auto* worker = new GradientStatisticsWorker(info.Env(), pixels, NumberArgument(info, 4, "sigma"));
    const Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
}

// renderEdgeMap(pixels, width, height, bitDepth, method, sigma, low, high, maxSize): Promise<Buffer> (8-bit PNG,
// glcm::RenderEdgeMap); method is "sobel" or "canny"
Napi::Value RenderEdgeMap(const Napi::CallbackInfo& info) {
    const PixelArguments pixels = ReadPixelArguments(info, 0);
    const std::string method = StringArgument(info, 4, "method");
    if (method != "sobel" && method != "canny") {
        throw Napi::TypeError::New(info.Env(), "method must be \"sobel\" or \"canny\"");
    }
    auto* worker = new EdgeMapWorker(info.Env(), pixels, method == "sobel" ? glcm::EdgeMethod::Sobel : glcm::EdgeMethod::Canny,
        NumberArgument(info, 5, "sigma"), NumberArgument(info, 6, "low"), NumberArgument(info, 7, "high"),
        IntegerArgument(info, 8, "maxSize"));
    const Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
}

// livewirePath(pixels, width, height, bitDepth, fromX, fromY, toX, toY, sigma): Promise<Array<[x, y]>> (glcm::LivewirePath)
Napi::Value LivewirePath(const Napi::CallbackInfo& info) {
    const PixelArguments pixels = ReadPixelArguments(info, 0);
    const cv::Point from(IntegerArgument(info, 4, "fromX"), IntegerArgument(info, 5, "fromY"));
    const cv::Point to(IntegerArgument(info, 6, "toX"), IntegerArgument(info, 7, "toY"));
    auto* worker = new LivewireWorker(info.Env(), pixels, from, to, NumberArgument(info, 8, "sigma"));
    const Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
}

class LineProfileWorker : public PixelWorker {
public:
    LineProfileWorker(Napi::Env env, const PixelArguments& arguments, cv::Point2d from, cv::Point2d to)
        : PixelWorker(env, arguments), _from(from), _to(to) {}

    void Execute() override {
        try {
            _profile = glcm::ComputeLineProfile(Gray(), _from, _to);
        } catch (const std::invalid_argument& error) {
            Fail(CODE_INVALID_ARGUMENT, error.what());
        } catch (const std::exception& error) {
            Fail(CODE_INTERNAL, error.what());
        }
    }

    void OnOK() override {
        Napi::Env env = Env();
        Napi::Object result = Napi::Object::New(env);
        Napi::Array values = Napi::Array::New(env, _profile.values.size());
        for (size_t i = 0; i < _profile.values.size(); ++i) {
            values.Set(static_cast<uint32_t>(i), NumberOrNull(env, _profile.values[i]));
        }
        result.Set("values", values);
        result.Set("length", Napi::Number::New(env, _profile.length));
        result.Set("step", Napi::Number::New(env, _profile.step));
        Resolve(result);
    }

private:
    cv::Point2d _from;
    cv::Point2d _to;
    glcm::LineProfile _profile;
};

// lineProfile(pixels, width, height, bitDepth, fromX, fromY, toX, toY): Promise<{values, length, step}> (glcm::ComputeLineProfile)
Napi::Value LineProfile(const Napi::CallbackInfo& info) {
    const PixelArguments pixels = ReadPixelArguments(info, 0);
    const cv::Point2d from(NumberArgument(info, 4, "fromX"), NumberArgument(info, 5, "fromY"));
    const cv::Point2d to(NumberArgument(info, 6, "toX"), NumberArgument(info, 7, "toY"));
    auto* worker = new LineProfileWorker(info.Env(), pixels, from, to);
    const Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
}

class RoiHistogramWorker : public PixelWorker {
public:
    RoiHistogramWorker(Napi::Env env, const PixelArguments& arguments, std::string rois_json, int bins)
        : PixelWorker(env, arguments), _rois_json(std::move(rois_json)), _bins(bins) {}

    void Execute() override {
        try {
            const std::vector<glcm::Roi> rois = ParseRois(_rois_json);
            if (rois.size() != 1) {
                throw std::invalid_argument("A histogram needs exactly one ROI");
            }
            _histogram = glcm::ComputeRoiHistogram(Gray(), rois[0].shape, _bins);
        } catch (const std::invalid_argument& error) {
            Fail(CODE_INVALID_ARGUMENT, error.what());
        } catch (const std::exception& error) {
            Fail(CODE_INTERNAL, error.what());
        }
    }

    void OnOK() override {
        Napi::Env env = Env();
        Napi::Object result = Napi::Object::New(env);
        const bool empty = _histogram.pixel_count == 0;
        result.Set("pixelCount", Napi::Number::New(env, _histogram.pixel_count));
        result.Set("min", empty ? env.Null() : Napi::Number::New(env, _histogram.min));
        result.Set("max", empty ? env.Null() : Napi::Number::New(env, _histogram.max));
        result.Set("mean", empty ? env.Null() : Napi::Number::New(env, _histogram.mean));
        result.Set("std", empty ? env.Null() : Napi::Number::New(env, _histogram.std));
        result.Set("mode", empty ? env.Null() : Napi::Number::New(env, _histogram.mode));
        result.Set("binStart", Napi::Number::New(env, _histogram.bin_start));
        result.Set("binWidth", Napi::Number::New(env, _histogram.bin_width));
        Napi::Array counts = Napi::Array::New(env, _histogram.counts.size());
        for (size_t i = 0; i < _histogram.counts.size(); ++i) {
            counts.Set(static_cast<uint32_t>(i), Napi::Number::New(env, static_cast<double>(_histogram.counts[i])));
        }
        result.Set("counts", counts);
        Resolve(result);
    }

private:
    std::string _rois_json;
    int _bins;
    glcm::RoiHistogram _histogram;
};

// roiHistogram(pixels, width, height, bitDepth, roisJson (one ROI), bins): Promise<NativeRoiHistogram> (glcm::ComputeRoiHistogram)
Napi::Value RoiHistogram(const Napi::CallbackInfo& info) {
    const PixelArguments pixels = ReadPixelArguments(info, 0);
    auto* worker = new RoiHistogramWorker(info.Env(), pixels, StringArgument(info, 4, "roisJson"), IntegerArgument(info, 5, "bins"));
    const Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("coreVersion", Napi::Function::New(env, CoreVersion, "coreVersion"));
    exports.Set("catalog", Napi::Function::New(env, Catalog, "catalog"));
    exports.Set("decodeImageFile", Napi::Function::New(env, DecodeImageFile, "decodeImageFile"));
    exports.Set("inspectNiftiVolume", Napi::Function::New(env, InspectNiftiVolume, "inspectNiftiVolume"));
    exports.Set("extractNiftiSlice", Napi::Function::New(env, ExtractNiftiSlice, "extractNiftiSlice"));
    exports.Set("extractNiftiStack", Napi::Function::New(env, ExtractNiftiStack, "extractNiftiStack"));
    exports.Set("decodeDicomSeries", Napi::Function::New(env, DecodeDicomSeries, "decodeDicomSeries"));
    exports.Set("renderDisplay", Napi::Function::New(env, RenderDisplay, "renderDisplay"));
    exports.Set("roiStats", Napi::Function::New(env, RoiStats, "roiStats"));
    exports.Set("roiHistogram", Napi::Function::New(env, RoiHistogram, "roiHistogram"));
    exports.Set("lineProfile", Napi::Function::New(env, LineProfile, "lineProfile"));
    exports.Set("validateAnalysis", Napi::Function::New(env, ValidateAnalysis, "validateAnalysis"));
    exports.Set("runAnalysis", Napi::Function::New(env, RunAnalysis, "runAnalysis"));
    exports.Set("formatResults", Napi::Function::New(env, FormatResults, "formatResults"));
    exports.Set("exportRoiImages", Napi::Function::New(env, ExportRoiImages, "exportRoiImages"));
    exports.Set("windowLevel", Napi::Function::New(env, WindowLevel, "windowLevel"));
    exports.Set("featureMapGrid", Napi::Function::New(env, FeatureMapGridInfo, "featureMapGrid"));
    exports.Set("computeFeatureMap", Napi::Function::New(env, ComputeFeatureMap, "computeFeatureMap"));
    exports.Set("CancelToken", CancelToken::Define(env));
    exports.Set("selectThresholdRegions", Napi::Function::New(env, SelectThresholdRegions, "selectThresholdRegions"));
    exports.Set("selectWandRegion", Napi::Function::New(env, SelectWandRegion, "selectWandRegion"));
    exports.Set("combineRois", Napi::Function::New(env, CombineRois, "combineRois"));
    exports.Set("brushRoi", Napi::Function::New(env, BrushRoi, "brushRoi"));
    exports.Set("growRoi", Napi::Function::New(env, GrowRoi, "growRoi"));
    exports.Set("gradientStatistics", Napi::Function::New(env, GradientStatistics, "gradientStatistics"));
    exports.Set("renderEdgeMap", Napi::Function::New(env, RenderEdgeMap, "renderEdgeMap"));
    exports.Set("livewirePath", Napi::Function::New(env, LivewirePath, "livewirePath"));
    return exports;
}

} // namespace

NODE_API_MODULE(glcm_native, Init)
