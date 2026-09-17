#include "imaging/ImageLoader.hpp"

#include <algorithm>
#include <cmath>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <optional>
#include <stdexcept>
#include <utility>

#include "imaging/DicomReader.hpp"
#include "imaging/ImageHeader.hpp"
#include "imaging/NiftiReader.hpp"

namespace glcm {

namespace {

// Keep the bit depth and color channels, apply the EXIF orientation, drop alpha
const int DECODE_FLAGS = cv::IMREAD_ANYDEPTH | cv::IMREAD_ANYCOLOR;

// Checks the size read from the header before decoding
void CheckHeaderSize(const std::optional<ImageSize>& size, int64_t max_pixels) {
    if (max_pixels <= 0) {
        return;
    }
    if (!size) {
        // Not recognized as an image whose size can be checked; reported like a file that cannot be decoded
        throw std::runtime_error(
            "Unknown image format: only PNG, JPEG, BMP, TIFF, DICOM and NIfTI images can be checked against the pixel limit");
    }
    // width * height > max_pixels, without overflowing for absurd sizes
    if (size->width > max_pixels / size->height) {
        throw ImageTooLargeError(size->width, size->height, max_pixels);
    }
}

LoadedImage ToLoadedImage(const cv::Mat& decoded, int64_t max_pixels, ColourConversion colour) {
    // The decoder may disagree with the header, e.g. for a multi-image TIFF
    if (max_pixels > 0 && static_cast<int64_t>(decoded.total()) > max_pixels) {
        throw ImageTooLargeError(decoded.cols, decoded.rows, max_pixels);
    }
    if (decoded.depth() != CV_8U && decoded.depth() != CV_16U) {
        throw std::invalid_argument("Unsupported image bit depth: only 8-bit and 16-bit images are supported");
    }

    LoadedImage result;
    result.info.source_channels = decoded.channels();
    switch (decoded.channels()) {
        case 1:
            result.gray = decoded;
            break;
        case 3: {
            ConvertedColour converted = ConvertColour(decoded, colour);
            result.gray = converted.gray;
            result.info.value_conversion = converted.value_conversion;
            result.warnings.push_back(converted.warning);
            break;
        }
        case 4:
            if (colour == ColourConversion::Luminance) {
                cv::cvtColor(decoded, result.gray, cv::COLOR_BGRA2GRAY);
                result.warnings.push_back("Color image converted to grayscale; alpha channel ignored");
            } else {
                cv::Mat bgr;
                cv::cvtColor(decoded, bgr, cv::COLOR_BGRA2BGR);
                ConvertedColour converted = ConvertColour(bgr, colour);
                result.gray = converted.gray;
                result.info.value_conversion = converted.value_conversion;
                result.warnings.push_back(converted.warning + "; alpha channel ignored");
            }
            break;
        default:
            throw std::invalid_argument("Unsupported number of image channels: " + std::to_string(decoded.channels()));
    }

    result.info.width = result.gray.cols;
    result.info.height = result.gray.rows;
    result.info.bit_depth = (result.gray.depth() == CV_16U) ? 16 : 8;
    return result;
}

// The header without the pixel limit: only for the metadata below, so an unreadable one is left to the decoder to report
template <typename Read>
std::optional<ImageSize> OptionalHeader(Read read) {
    try {
        return read();
    } catch (const std::exception&) {
        return std::nullopt;
    }
}

void AddHeaderMetadata(const std::optional<ImageSize>& header, LoadedImage& image) {
    if (!header) {
        return;
    }
    if (header->more_images) {
        image.warnings.push_back("The TIFF file contains more than one image; only the first is used");
    }
    if (header->pixel_spacing) {
        PixelSpacing spacing = *header->pixel_spacing;
        // The EXIF orientation may have turned the image by 90°: the header's width is now the height
        if (header->width != header->height && image.info.width == header->height && image.info.height == header->width) {
            std::swap(spacing.x_mm, spacing.y_mm);
        }
        image.info.pixel_spacing = spacing;
    }
}

} // namespace

ImageTooLargeError::ImageTooLargeError(int64_t width, int64_t height, int64_t max_pixels)
    : std::runtime_error("The image has " + std::to_string(width) + " x " + std::to_string(height) + " pixels, more than the limit of " +
                         std::to_string(max_pixels) + " pixels") {}

StackTooLargeError::StackTooLargeError(int64_t width, int64_t height, int64_t slices, int64_t max_pixels)
    : std::runtime_error("The stack has " + std::to_string(slices) + " slices of " + std::to_string(width) + " x " +
                         std::to_string(height) + " pixels, more than the limit of " + std::to_string(max_pixels) + " pixels") {}

LoadedImage LoadImageFile(const std::string& path, int64_t max_pixels, ColourConversion colour) {
    if (IsDicomFile(path)) {
        return LoadDicomFile(path, max_pixels, colour);
    }
    if (IsNiftiFile(path)) {
        return LoadNiftiFile(path, max_pixels);
    }
    std::optional<ImageSize> header;
    if (max_pixels > 0) {
        header = ReadImageSize(path);
        CheckHeaderSize(header, max_pixels);
    } else {
        header = OptionalHeader([&] { return ReadImageSize(path); });
    }
    cv::Mat decoded = cv::imread(path, DECODE_FLAGS);
    if (decoded.empty()) {
        throw std::runtime_error("Cannot read the image: " + path);
    }
    LoadedImage image = ToLoadedImage(decoded, max_pixels, colour);
    AddHeaderMetadata(header, image);
    return image;
}

namespace {

LoadedStack StackOf(LoadedImage image) {
    LoadedStack stack;
    stack.pixels = image.gray;
    stack.info = image.info;
    stack.warnings = std::move(image.warnings);
    stack.window = image.window;
    return stack;
}

// The pages of a multi-page TIFF, read a few at a time so that only those are held twice
LoadedStack LoadTiffPages(
    const std::string& path, const ImageSize& header, int64_t max_pixels, int64_t max_stack_pixels, ColourConversion colour) {
    const auto pages = static_cast<int64_t>(cv::imcount(path, DECODE_FLAGS));
    if (pages > MAX_SLICES) {
        throw std::invalid_argument("The TIFF file has " + std::to_string(pages) + " pages, more than " + std::to_string(MAX_SLICES));
    }
    if (max_stack_pixels > 0 && pages > 0 && header.width * header.height > max_stack_pixels / pages) {
        throw StackTooLargeError(header.width, header.height, pages, max_stack_pixels);
    }

    const int batch = 16;
    std::vector<cv::Mat> slices;
    LoadedStack stack;
    int first_type = -1;
    cv::Size first_size;
    for (int start = 0; start < pages; start += batch) {
        std::vector<cv::Mat> decoded;
        if (!cv::imreadmulti(path, decoded, start, static_cast<int>(std::min<int64_t>(batch, pages - start)), DECODE_FLAGS) ||
            decoded.empty()) {
            throw std::runtime_error("Cannot read the image: " + path);
        }
        bool stop = false;
        for (size_t i = 0; i < decoded.size(); ++i) {
            const int page = start + static_cast<int>(i);
            if (page == 0) {
                first_type = decoded[i].type();
                first_size = decoded[i].size();
            } else if (decoded[i].type() != first_type || decoded[i].size() != first_size) {
                stack.warnings.push_back("Page " + std::to_string(page + 1) +
                                         " of the TIFF file differs in size or type from the first; only the first " +
                                         std::to_string(page) + (page == 1 ? " page is" : " pages are") + " used");
                stop = true;
                break;
            }
            LoadedImage image = ToLoadedImage(decoded[i], max_pixels, colour);
            if (page == 0) {
                stack.info = image.info;
                for (const std::string& warning : image.warnings) {
                    stack.warnings.push_back(warning);
                }
            }
            slices.push_back(image.gray);
        }
        if (stop) {
            break;
        }
    }
    stack.slices = static_cast<int>(slices.size());
    cv::vconcat(slices, stack.pixels);
    return stack;
}

} // namespace

LoadedStack LoadImageStackFile(const std::string& path, int64_t max_pixels, int64_t max_stack_pixels, ColourConversion colour) {
    if (IsDicomFile(path)) {
        return LoadDicomStackFile(path, max_pixels, max_stack_pixels, colour);
    }
    if (!IsNiftiFile(path)) {
        std::optional<ImageSize> header = OptionalHeader([&] { return ReadImageSize(path); });
        if (header && header->more_images) {
            if (max_pixels > 0) {
                CheckHeaderSize(header, max_pixels);
            }
            LoadedStack stack = LoadTiffPages(path, *header, max_pixels, max_stack_pixels, colour);
            LoadedImage first;
            first.info = stack.info;
            AddHeaderMetadata(ImageSize{header->width, header->height, false, header->pixel_spacing}, first);
            stack.info.pixel_spacing = first.info.pixel_spacing;
            return stack;
        }
    }
    LoadedStack stack = StackOf(LoadImageFile(path, max_pixels, colour));
    if (max_stack_pixels > 0 && static_cast<int64_t>(stack.pixels.total()) > max_stack_pixels) {
        throw StackTooLargeError(stack.info.width, stack.info.height, 1, max_stack_pixels);
    }
    return stack;
}

namespace {

void Put16(std::vector<uchar>& out, size_t at, uint16_t value) {
    out[at] = static_cast<uchar>(value & 0xFF);
    out[at + 1] = static_cast<uchar>(value >> 8);
}

void Put32(std::vector<uchar>& out, size_t at, uint32_t value) {
    for (size_t i = 0; i < 4; ++i) {
        out[at + i] = static_cast<uchar>((value >> (8 * i)) & 0xFF);
    }
}

} // namespace

std::vector<uchar> EncodeTiffStack(const LoadedStack& stack) {
    if (stack.slices < 1 || stack.pixels.empty() || (stack.pixels.type() != CV_8UC1 && stack.pixels.type() != CV_16UC1) ||
        stack.pixels.rows != stack.info.height * stack.slices || stack.pixels.cols != stack.info.width) {
        throw std::invalid_argument("The stack's pixels do not match its size");
    }
    const uint16_t bits = stack.pixels.depth() == CV_16U ? 16 : 8;
    const uint64_t slice_bytes = static_cast<uint64_t>(stack.info.width) * static_cast<uint64_t>(stack.info.height) * (bits / 8);
    const bool with_resolution = stack.info.pixel_spacing.has_value();
    const uint16_t entries = with_resolution ? 12 : 9;
    const uint64_t ifd_bytes = 2 + 12 * static_cast<uint64_t>(entries) + 4 + (with_resolution ? 16 : 0);
    const uint64_t total = 8 + static_cast<uint64_t>(stack.slices) * (ifd_bytes + slice_bytes);
    if (total > 0xFFFFFFFFull) {
        throw std::invalid_argument("The stack is too large for a TIFF file (4 GB)");
    }

    std::vector<uchar> out(static_cast<size_t>(total), 0);
    out[0] = 'I';
    out[1] = 'I';
    Put16(out, 2, 42);
    Put32(out, 4, 8);
    // Resolution as a rational with a large numerator, so the spacing reads back closely: pixels per cm = 1e7 / (mm × 1e6)
    const auto denominator = [](double mm) { return static_cast<uint32_t>(std::clamp(std::llround(mm * 1e6), 1LL, 4294967295LL)); };

    size_t position = 8;
    for (int k = 0; k < stack.slices; ++k) {
        const size_t ifd = position;
        const size_t extra = ifd + 2 + 12 * entries + 4;
        const size_t data = extra + (with_resolution ? 16 : 0);
        size_t entry = ifd + 2;
        Put16(out, ifd, entries);
        const auto tag = [&](uint16_t id, uint16_t type, uint32_t count, uint32_t value) {
            Put16(out, entry, id);
            Put16(out, entry + 2, type);
            Put32(out, entry + 4, count);
            if (type == 3) {
                Put16(out, entry + 8, static_cast<uint16_t>(value));
            } else {
                Put32(out, entry + 8, value);
            }
            entry += 12;
        };
        // Tags in ascending order: NewSubfileType (a page), ImageWidth, ImageLength, BitsPerSample, Compression (none),
        // PhotometricInterpretation (black is zero), StripOffsets, RowsPerStrip, StripByteCounts, XResolution, YResolution,
        // ResolutionUnit (centimetre)
        tag(254, 4, 1, 2);
        tag(256, 4, 1, static_cast<uint32_t>(stack.info.width));
        tag(257, 4, 1, static_cast<uint32_t>(stack.info.height));
        tag(258, 3, 1, bits);
        tag(259, 3, 1, 1);
        tag(262, 3, 1, 1);
        tag(273, 4, 1, static_cast<uint32_t>(data));
        tag(278, 4, 1, static_cast<uint32_t>(stack.info.height));
        tag(279, 4, 1, static_cast<uint32_t>(slice_bytes));
        if (with_resolution) {
            tag(282, 5, 1, static_cast<uint32_t>(extra));
            tag(283, 5, 1, static_cast<uint32_t>(extra + 8));
            tag(296, 3, 1, 3);
            Put32(out, extra, 10000000);
            Put32(out, extra + 4, denominator(stack.info.pixel_spacing->x_mm));
            Put32(out, extra + 8, 10000000);
            Put32(out, extra + 12, denominator(stack.info.pixel_spacing->y_mm));
        }
        const bool last = k + 1 == stack.slices;
        Put32(out, ifd + 2 + 12 * entries, last ? 0 : static_cast<uint32_t>(data + slice_bytes));

        const cv::Mat slice = stack.Slice(k);
        for (int row = 0; row < slice.rows; ++row) {
            size_t at = data + static_cast<size_t>(row) * static_cast<size_t>(slice.cols) * (bits / 8);
            if (bits == 8) {
                const uchar* line = slice.ptr<uchar>(row);
                std::copy(line, line + slice.cols, out.begin() + static_cast<std::ptrdiff_t>(at));
            } else {
                const uint16_t* line = slice.ptr<uint16_t>(row);
                for (int col = 0; col < slice.cols; ++col, at += 2) {
                    Put16(out, at, line[col]);
                }
            }
        }
        position = data + slice_bytes;
    }
    return out;
}

LoadedImage LoadImageBytes(const std::vector<uchar>& bytes, int64_t max_pixels, ColourConversion colour) {
    if (bytes.empty()) {
        throw std::runtime_error("Cannot decode an empty image buffer");
    }
    if (IsDicomBytes(bytes)) {
        return LoadDicomBytes(bytes, max_pixels, colour);
    }
    std::optional<ImageSize> header;
    if (max_pixels > 0) {
        header = ReadImageSizeFromBytes(bytes);
        CheckHeaderSize(header, max_pixels);
    } else {
        header = OptionalHeader([&] { return ReadImageSizeFromBytes(bytes); });
    }
    cv::Mat decoded = cv::imdecode(bytes, DECODE_FLAGS);
    if (decoded.empty()) {
        throw std::runtime_error("Cannot decode the image data");
    }
    LoadedImage image = ToLoadedImage(decoded, max_pixels, colour);
    AddHeaderMetadata(header, image);
    return image;
}

} // namespace glcm
