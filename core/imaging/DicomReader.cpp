#include "imaging/DicomReader.hpp"

#include <algorithm>
#include <array>
#include <climits>
#include <cmath>
#include <cstdint>
#include <functional>
#include <limits>
#include <locale>
#include <map>
#include <memory>
#include <opencv2/imgproc.hpp>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>

#include "imaging/ByteSource.hpp"
#include "imaging/ValueConversion.hpp"

namespace glcm {

namespace {

using imaging_detail::ByteSource;
using imaging_detail::FileSource;
using imaging_detail::MemorySource;

constexpr uint64_t PREAMBLE_SIZE = 128;
constexpr uint32_t UNDEFINED_LENGTH = 0xFFFFFFFF;
// Limits against crafted files
constexpr int MAX_SEQUENCE_DEPTH = 32;
constexpr uint64_t MAX_ELEMENTS = 1000000;
constexpr uint32_t MAX_STORED_VALUE_LENGTH = 1024;

constexpr uint32_t TAG_TRANSFER_SYNTAX = 0x00020010;
constexpr uint32_t TAG_MODALITY = 0x00080060;
constexpr uint32_t TAG_IMAGER_PIXEL_SPACING = 0x00181164;
constexpr uint32_t TAG_SAMPLES_PER_PIXEL = 0x00280002;
constexpr uint32_t TAG_PHOTOMETRIC = 0x00280004;
constexpr uint32_t TAG_PLANAR_CONFIGURATION = 0x00280006;
constexpr uint32_t TAG_NUMBER_OF_FRAMES = 0x00280008;
constexpr uint32_t TAG_ROWS = 0x00280010;
constexpr uint32_t TAG_COLUMNS = 0x00280011;
constexpr uint32_t TAG_PIXEL_SPACING = 0x00280030;
constexpr uint32_t TAG_BITS_ALLOCATED = 0x00280100;
constexpr uint32_t TAG_BITS_STORED = 0x00280101;
constexpr uint32_t TAG_HIGH_BIT = 0x00280102;
constexpr uint32_t TAG_PIXEL_REPRESENTATION = 0x00280103;
constexpr uint32_t TAG_WINDOW_CENTER = 0x00281050;
constexpr uint32_t TAG_WINDOW_WIDTH = 0x00281051;
constexpr uint32_t TAG_RESCALE_INTERCEPT = 0x00281052;
constexpr uint32_t TAG_RESCALE_SLOPE = 0x00281053;
constexpr uint32_t TAG_RESCALE_TYPE = 0x00281054;
constexpr uint32_t TAG_SERIES_DESCRIPTION = 0x0008103E;
constexpr uint32_t TAG_SERIES_INSTANCE_UID = 0x0020000E;
constexpr uint32_t TAG_INSTANCE_NUMBER = 0x00200013;
constexpr uint32_t TAG_IMAGE_POSITION = 0x00200032;
constexpr uint32_t TAG_IMAGE_ORIENTATION = 0x00200037;
constexpr uint32_t TAG_SHARED_FUNCTIONAL_GROUPS = 0x52009229;
constexpr uint32_t TAG_PER_FRAME_FUNCTIONAL_GROUPS = 0x52009230;
constexpr uint32_t TAG_PIXEL_DATA = 0x7FE00010;
constexpr uint32_t TAG_ITEM = 0xFFFEE000;
constexpr uint32_t TAG_ITEM_END = 0xFFFEE00D;
constexpr uint32_t TAG_SEQUENCE_END = 0xFFFEE0DD;

constexpr std::array<uint32_t, 24> WANTED_TAGS = {TAG_TRANSFER_SYNTAX, TAG_MODALITY, TAG_SERIES_DESCRIPTION, TAG_SERIES_INSTANCE_UID,
    TAG_INSTANCE_NUMBER, TAG_IMAGE_POSITION, TAG_IMAGE_ORIENTATION, TAG_IMAGER_PIXEL_SPACING, TAG_SAMPLES_PER_PIXEL, TAG_PHOTOMETRIC,
    TAG_PLANAR_CONFIGURATION, TAG_NUMBER_OF_FRAMES, TAG_ROWS, TAG_COLUMNS, TAG_PIXEL_SPACING, TAG_BITS_ALLOCATED, TAG_BITS_STORED,
    TAG_HIGH_BIT, TAG_PIXEL_REPRESENTATION, TAG_WINDOW_CENTER, TAG_WINDOW_WIDTH, TAG_RESCALE_INTERCEPT, TAG_RESCALE_SLOPE,
    TAG_RESCALE_TYPE};

// Value representations with a 2-byte reserved field and a 4-byte length in explicit VR
bool HasLongLength(const std::array<char, 2>& vr) {
    static const std::array<const char*, 13> LONG_VRS = {"OB", "OD", "OF", "OL", "OV", "OW", "SQ", "SV", "UC", "UN", "UR", "UT", "UV"};
    return std::any_of(LONG_VRS.begin(), LONG_VRS.end(), [&](const char* name) { return vr[0] == name[0] && vr[1] == name[1]; });
}

struct ElementHeader {
    uint32_t tag = 0;
    std::array<char, 2> vr{};
    bool has_vr = false;
    uint32_t length = 0;
    uint64_t value_offset = 0;
};

// The attributes of the top-level dataset that the reader uses, as raw values
struct Attributes {
    std::map<uint32_t, std::string> values;
    bool has_pixel_data = false;
    uint64_t pixel_offset = 0;
    uint32_t pixel_length = 0;
};

class DicomParser {
public:
    explicit DicomParser(ByteSource& source) : _source(source) {}

    Attributes Parse() {
        // File meta information: group 0002, always explicit VR little endian
        uint64_t position = PREAMBLE_SIZE + 4;
        while (Available(position, 8)) {
            const ElementHeader header = ReadHeader(position, true);
            if ((header.tag >> 16) != 0x0002) {
                break;
            }
            if (header.length == UNDEFINED_LENGTH) {
                throw std::runtime_error("Invalid DICOM file meta information");
            }
            Store(header);
            position = header.value_offset + header.length;
        }

        const std::string syntax = Text(TAG_TRANSFER_SYNTAX);
        bool explicit_vr = true;
        if (syntax.empty() || syntax == "1.2.840.10008.1.2") {
            explicit_vr = false; // implicit VR little endian, also assumed when the transfer syntax is missing
        } else if (syntax == "1.2.840.10008.1.2.1") {
            explicit_vr = true;
        } else if (syntax == "1.2.840.10008.1.2.2") {
            throw std::invalid_argument("Big-endian DICOM files are not supported; convert the file to little endian");
        } else if (syntax == "1.2.840.10008.1.2.1.99") {
            throw std::invalid_argument("Deflated DICOM files are not supported; convert the file to an uncompressed transfer syntax");
        } else if (syntax.rfind("1.2.840.10008.1.2.4.", 0) == 0 || syntax == "1.2.840.10008.1.2.5") {
            throw std::invalid_argument(
                "Compressed DICOM images (JPEG, JPEG-LS, JPEG 2000 or RLE) are not supported; convert the file "
                "to an uncompressed transfer syntax, e.g. with dcmdjpeg or gdcmconv --raw");
        } else {
            throw std::invalid_argument("The DICOM transfer syntax " + syntax +
                                        " is not supported; convert the file to an uncompressed "
                                        "transfer syntax");
        }
        ParseElements(position, explicit_vr, 0, true);
        return _attributes;
    }

    std::string Text(uint32_t tag) const {
        const auto found = _attributes.values.find(tag);
        if (found == _attributes.values.end()) {
            return "";
        }
        std::string text = found->second;
        // Values are padded with spaces (text) or NUL (UI) to an even length
        const size_t end = text.find_last_not_of(std::string(" \0", 2));
        text.erase(end == std::string::npos ? 0 : end + 1);
        const size_t begin = text.find_first_not_of(' ');
        return begin == std::string::npos ? "" : text.substr(begin);
    }

    // A top-level element was present, whatever its value (e.g. a sequence)
    bool Seen(uint32_t tag) const {
        return _seen.count(tag) > 0;
    }

    std::optional<int> UnsignedShort(uint32_t tag) const {
        const auto found = _attributes.values.find(tag);
        if (found == _attributes.values.end() || found->second.size() < 2) {
            return std::nullopt;
        }
        const auto* bytes = reinterpret_cast<const unsigned char*>(found->second.data());
        return bytes[0] | (bytes[1] << 8);
    }

private:
    bool Available(uint64_t offset, size_t count) {
        std::array<uint8_t, 16> buffer{};
        return _source.Read(offset, buffer.data(), std::min(count, buffer.size())) == std::min(count, buffer.size());
    }

    void Bytes(uint64_t offset, uint8_t* out, size_t count) {
        if (_source.Read(offset, out, count) != count) {
            throw std::runtime_error("Truncated DICOM file");
        }
    }

    uint16_t Uint16(uint64_t offset) {
        std::array<uint8_t, 2> bytes{};
        Bytes(offset, bytes.data(), bytes.size());
        return static_cast<uint16_t>(bytes[0] | (bytes[1] << 8));
    }

    uint32_t Uint32(uint64_t offset) {
        std::array<uint8_t, 4> bytes{};
        Bytes(offset, bytes.data(), bytes.size());
        return static_cast<uint32_t>(bytes[0]) | (static_cast<uint32_t>(bytes[1]) << 8) | (static_cast<uint32_t>(bytes[2]) << 16) |
               (static_cast<uint32_t>(bytes[3]) << 24);
    }

    ElementHeader ReadHeader(uint64_t position, bool explicit_vr) {
        ElementHeader header;
        header.tag = (static_cast<uint32_t>(Uint16(position)) << 16) | Uint16(position + 2);
        if (!explicit_vr || (header.tag >> 16) == 0xFFFE) {
            header.length = Uint32(position + 4);
            header.value_offset = position + 8;
            return header;
        }
        std::array<uint8_t, 2> vr{};
        Bytes(position + 4, vr.data(), vr.size());
        header.vr = {static_cast<char>(vr[0]), static_cast<char>(vr[1])};
        header.has_vr = true;
        if (HasLongLength(header.vr)) {
            header.length = Uint32(position + 8);
            header.value_offset = position + 12;
        } else {
            header.length = Uint16(position + 6);
            header.value_offset = position + 8;
        }
        return header;
    }

    void CountElement() {
        if (++_elements > MAX_ELEMENTS) {
            throw std::runtime_error("Invalid DICOM file: too many elements");
        }
    }

    void Store(const ElementHeader& header) {
        if (std::find(WANTED_TAGS.begin(), WANTED_TAGS.end(), header.tag) == WANTED_TAGS.end() || header.length > MAX_STORED_VALUE_LENGTH) {
            return;
        }
        std::string value(header.length, '\0');
        Bytes(header.value_offset, reinterpret_cast<uint8_t*>(value.data()), value.size());
        _attributes.values[header.tag] = std::move(value);
    }

    // Reads the elements of a dataset. At the top level it ends at the pixel data or the end of the file; in an item of
    // undefined length, after the item delimiter. Returns the position after the last element read.
    uint64_t ParseElements(uint64_t position, bool explicit_vr, int depth, bool top_level) {
        while (true) {
            if (top_level && !Available(position, 1)) {
                return position;
            }
            CountElement();
            const ElementHeader header = ReadHeader(position, explicit_vr);
            if (top_level) {
                _seen.insert(header.tag);
            }
            if (!top_level && header.tag == TAG_ITEM_END) {
                return header.value_offset;
            }
            if (top_level && header.tag == TAG_PIXEL_DATA) {
                if (header.length == UNDEFINED_LENGTH) {
                    throw std::invalid_argument(
                        "Compressed (encapsulated) DICOM pixel data is not supported; convert the file to an "
                        "uncompressed transfer syntax");
                }
                _attributes.has_pixel_data = true;
                _attributes.pixel_offset = header.value_offset;
                _attributes.pixel_length = header.length;
                return header.value_offset;
            }
            if (header.length == UNDEFINED_LENGTH) {
                // A sequence; the items of UN elements are encoded in implicit VR
                const bool unknown = header.has_vr && header.vr[0] == 'U' && header.vr[1] == 'N';
                position = SkipSequence(header.value_offset, explicit_vr && !unknown, depth + 1);
            } else {
                if (top_level) {
                    Store(header);
                }
                position = header.value_offset + header.length;
            }
        }
    }

    uint64_t SkipSequence(uint64_t position, bool explicit_vr, int depth) {
        if (depth > MAX_SEQUENCE_DEPTH) {
            throw std::runtime_error("Invalid DICOM file: sequences nested too deeply");
        }
        while (true) {
            CountElement();
            const uint32_t tag = (static_cast<uint32_t>(Uint16(position)) << 16) | Uint16(position + 2);
            const uint32_t length = Uint32(position + 4);
            position += 8;
            if (tag == TAG_SEQUENCE_END) {
                return position;
            }
            if (tag != TAG_ITEM) {
                throw std::runtime_error("Invalid DICOM sequence");
            }
            position = length == UNDEFINED_LENGTH ? ParseElements(position, explicit_vr, depth, false) : position + length;
        }
    }

    ByteSource& _source;
    Attributes _attributes;
    std::set<uint32_t> _seen;
    uint64_t _elements = 0;
};

std::vector<double> Numbers(const std::string& text) {
    std::vector<double> numbers;
    std::stringstream parts(text);
    std::string part;
    while (std::getline(parts, part, '\\')) {
        std::istringstream in(part);
        in.imbue(std::locale::classic());
        double number = 0;
        if (in >> number && std::isfinite(number)) {
            numbers.push_back(number);
        } else {
            numbers.push_back(std::numeric_limits<double>::quiet_NaN());
        }
    }
    return numbers;
}

std::optional<double> FirstNumber(const std::string& text) {
    const std::vector<double> numbers = Numbers(text);
    if (numbers.empty() || !std::isfinite(numbers[0])) {
        return std::nullopt;
    }
    return numbers[0];
}

std::optional<PixelSpacing> Spacing(const std::string& text) {
    const std::vector<double> numbers = Numbers(text);
    // Row spacing (between rows: vertical), then column spacing (horizontal)
    if (numbers.size() != 2) {
        return std::nullopt;
    }
    const auto plausible = [](double mm) { return std::isfinite(mm) && mm >= 1e-6 && mm <= 1e6; };
    if (!plausible(numbers[0]) || !plausible(numbers[1])) {
        return std::nullopt;
    }
    return PixelSpacing{numbers[1], numbers[0]};
}

bool IsInteger(double value) {
    return std::isfinite(value) && std::abs(value - std::round(value)) < 1e-9;
}

std::string Capitalized(std::string text) {
    if (!text.empty() && text[0] >= 'a' && text[0] <= 'z') {
        text[0] = static_cast<char>(text[0] - 'a' + 'A');
    }
    return text;
}

int RequiredShort(const DicomParser& parser, uint32_t tag, const char* name) {
    const std::optional<int> value = parser.UnsignedShort(tag);
    if (!value) {
        throw std::runtime_error(std::string("Invalid DICOM image: ") + name + " is missing");
    }
    return *value;
}

// The attributes of one DICOM image that decoding needs, read from the header; the pixels stay in the file
struct DicomImage {
    int64_t rows = 0;
    int64_t columns = 0;
    int64_t frames = 1;         // NumberOfFrames, at most MAX_SLICES + 1
    double declared_frames = 1; // NumberOfFrames as the file gives it
    int64_t present_frames = 1; // the frames whose pixel data is in the file (at least the first)
    int bits_allocated = 0;
    int samples_per_pixel = 1;
    int bits_stored = 0;
    int high_bit = 0;
    bool is_signed = false;
    bool planar = false;
    bool inverted = false; // MONOCHROME1
    uint64_t pixel_offset = 0;
    double slope = 1;
    double intercept = 0;
    std::string unit;
    std::optional<PixelSpacing> spacing;
    std::optional<double> window_center;
    std::optional<double> window_width;
    // For sorting the files of a series
    std::optional<std::array<double, 3>> position;    // ImagePositionPatient
    std::optional<std::array<double, 6>> orientation; // ImageOrientationPatient
    std::optional<double> instance;                   // InstanceNumber
    std::string series_uid;
    std::string series_description;
    bool functional_groups = false; // enhanced DICOM: per-frame attributes in sequences, which are not read

    uint64_t BytesPerSample() const {
        return static_cast<uint64_t>(bits_allocated / 8);
    }
    uint64_t PixelCount() const {
        return static_cast<uint64_t>(rows) * static_cast<uint64_t>(columns);
    }
    uint64_t FrameBytes() const {
        return PixelCount() * static_cast<uint64_t>(samples_per_pixel) * BytesPerSample();
    }
    int32_t MaxSample() const {
        return (1 << (is_signed ? bits_stored - 1 : bits_stored)) - 1;
    }
    bool Rgb() const {
        return samples_per_pixel == 3;
    }
};

std::optional<std::vector<double>> NumbersOf(const std::string& text, size_t count) {
    const std::vector<double> numbers = Numbers(text);
    if (numbers.size() != count || !std::all_of(numbers.begin(), numbers.end(), [](double n) { return std::isfinite(n); })) {
        return std::nullopt;
    }
    return numbers;
}

DicomImage ParseDicomImage(ByteSource& source, int64_t max_pixels) {
    std::array<uint8_t, 4> magic{};
    if (source.Read(PREAMBLE_SIZE, magic.data(), magic.size()) != magic.size() || magic != std::array<uint8_t, 4>{'D', 'I', 'C', 'M'}) {
        throw std::runtime_error("Not a DICOM file");
    }
    DicomParser parser(source);
    const Attributes attributes = parser.Parse();
    if (!attributes.has_pixel_data) {
        throw std::invalid_argument("The DICOM file contains no image (pixel data)");
    }

    DicomImage image;
    image.rows = RequiredShort(parser, TAG_ROWS, "Rows");
    image.columns = RequiredShort(parser, TAG_COLUMNS, "Columns");
    image.bits_allocated = RequiredShort(parser, TAG_BITS_ALLOCATED, "BitsAllocated");
    image.samples_per_pixel = parser.UnsignedShort(TAG_SAMPLES_PER_PIXEL).value_or(1);
    image.bits_stored = parser.UnsignedShort(TAG_BITS_STORED).value_or(image.bits_allocated);
    image.high_bit = parser.UnsignedShort(TAG_HIGH_BIT).value_or(image.bits_stored - 1);
    image.is_signed = parser.UnsignedShort(TAG_PIXEL_REPRESENTATION).value_or(0) == 1;
    const std::string photometric = parser.Text(TAG_PHOTOMETRIC);
    if (image.rows <= 0 || image.columns <= 0) {
        throw std::runtime_error("Invalid DICOM image: the rows and columns must be positive");
    }
    if (image.bits_allocated != 8 && image.bits_allocated != 16) {
        throw std::invalid_argument(
            "DICOM images with " + std::to_string(image.bits_allocated) + " bits allocated are not supported; only 8 and 16 bits are");
    }
    if (image.bits_stored < 1 || image.bits_stored > image.bits_allocated || image.high_bit < image.bits_stored - 1 ||
        image.high_bit >= image.bits_allocated) {
        throw std::runtime_error("Invalid DICOM image: inconsistent BitsStored and HighBit");
    }
    const bool monochrome = photometric == "MONOCHROME1" || photometric == "MONOCHROME2";
    if (!(image.samples_per_pixel == 1 && monochrome) && !(image.samples_per_pixel == 3 && photometric == "RGB")) {
        throw std::invalid_argument("DICOM images with the photometric interpretation " + (photometric.empty() ? "(none)" : photometric) +
                                    " and " + std::to_string(image.samples_per_pixel) +
                                    " samples per pixel are not supported; only MONOCHROME1, MONOCHROME2 and RGB are");
    }
    if (max_pixels > 0 && image.columns > max_pixels / image.rows) {
        throw ImageTooLargeError(image.columns, image.rows, max_pixels);
    }
    image.inverted = photometric == "MONOCHROME1";
    image.planar = parser.UnsignedShort(TAG_PLANAR_CONFIGURATION).value_or(0) == 1;

    const std::optional<double> frames = FirstNumber(parser.Text(TAG_NUMBER_OF_FRAMES));
    if (frames && *frames > 1) {
        image.declared_frames = *frames;
        image.frames = static_cast<int64_t>(std::min(*frames, static_cast<double>(MAX_SLICES) + 1));
    }
    image.pixel_offset = attributes.pixel_offset;
    uint8_t last = 0;
    const uint64_t frame_bytes = image.FrameBytes();
    if (attributes.pixel_length < frame_bytes || source.Read(attributes.pixel_offset + frame_bytes - 1, &last, 1) != 1) {
        throw std::runtime_error("Truncated DICOM pixel data");
    }
    // The frames present: those within the declared length whose last byte the file has (a binary search over the count)
    const auto present = [&](int64_t count) {
        const uint64_t bytes = frame_bytes * static_cast<uint64_t>(count);
        return attributes.pixel_length >= bytes && source.Read(attributes.pixel_offset + bytes - 1, &last, 1) == 1;
    };
    int64_t low = 1;
    int64_t high = image.frames;
    while (low < high) {
        const int64_t middle = low + (high - low + 1) / 2;
        if (present(middle)) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    image.present_frames = low;

    image.spacing = Spacing(parser.Text(TAG_PIXEL_SPACING));
    if (!image.spacing) {
        image.spacing = Spacing(parser.Text(TAG_IMAGER_PIXEL_SPACING));
    }
    std::optional<double> slope = FirstNumber(parser.Text(TAG_RESCALE_SLOPE));
    image.slope = (!slope || *slope == 0) ? 1 : *slope;
    image.intercept = FirstNumber(parser.Text(TAG_RESCALE_INTERCEPT)).value_or(0);
    const std::string rescale_type = parser.Text(TAG_RESCALE_TYPE);
    image.unit = (rescale_type == "HU" || (rescale_type.empty() && parser.Text(TAG_MODALITY) == "CT")) ? "HU" : "";
    image.window_center = FirstNumber(parser.Text(TAG_WINDOW_CENTER));
    image.window_width = FirstNumber(parser.Text(TAG_WINDOW_WIDTH));

    if (const auto position = NumbersOf(parser.Text(TAG_IMAGE_POSITION), 3)) {
        image.position = std::array<double, 3>{(*position)[0], (*position)[1], (*position)[2]};
    }
    if (const auto orientation = NumbersOf(parser.Text(TAG_IMAGE_ORIENTATION), 6)) {
        std::array<double, 6> values{};
        std::copy(orientation->begin(), orientation->end(), values.begin());
        image.orientation = values;
    }
    image.instance = FirstNumber(parser.Text(TAG_INSTANCE_NUMBER));
    image.series_uid = parser.Text(TAG_SERIES_INSTANCE_UID);
    image.series_description = parser.Text(TAG_SERIES_DESCRIPTION);
    image.functional_groups = parser.Seen(TAG_SHARED_FUNCTIONAL_GROUPS) || parser.Seen(TAG_PER_FRAME_FUNCTIONAL_GROUPS);
    return image;
}

// The raw bytes of one frame
std::vector<uint8_t> ReadFrame(ByteSource& source, const DicomImage& image, int64_t frame) {
    std::vector<uint8_t> bytes(image.FrameBytes());
    if (source.Read(image.pixel_offset + image.FrameBytes() * static_cast<uint64_t>(frame), bytes.data(), bytes.size()) != bytes.size()) {
        throw std::runtime_error("Truncated DICOM pixel data");
    }
    return bytes;
}

// Sample `index` of a frame's bytes, masked to the stored bits and sign-extended
int32_t RawSample(const std::vector<uint8_t>& bytes, const DicomImage& image, uint64_t index) {
    const int shift = image.high_bit + 1 - image.bits_stored;
    const uint32_t mask = image.bits_stored >= 32 ? 0xFFFFFFFFu : ((1u << image.bits_stored) - 1);
    uint32_t word = image.BytesPerSample() == 1 ? bytes[index] : static_cast<uint32_t>(bytes[2 * index] | (bytes[2 * index + 1] << 8));
    word = (word >> shift) & mask;
    if (image.is_signed && (word & (1u << (image.bits_stored - 1)))) {
        return static_cast<int32_t>(word) - (1 << image.bits_stored);
    }
    return static_cast<int32_t>(word);
}

// A grayscale sample with MONOCHROME1 inverted: unsigned max - value, signed -1 - value, both reversing the range of the
// stored bits onto itself
int32_t GraySample(const std::vector<uint8_t>& bytes, const DicomImage& image, uint64_t index) {
    const int32_t value = RawSample(bytes, image, index);
    if (!image.inverted) {
        return value;
    }
    return image.is_signed ? -1 - value : image.MaxSample() - value;
}

ConvertedColour RgbFrameToGray(const std::vector<uint8_t>& bytes, const DicomImage& image, ColourConversion colour) {
    const int depth = image.bits_allocated == 8 ? CV_8U : CV_16U;
    const uint64_t pixel_count = image.PixelCount();
    cv::Mat rgb(static_cast<int>(image.rows), static_cast<int>(image.columns), CV_MAKETYPE(depth, 3));
    for (uint64_t p = 0; p < pixel_count; ++p) {
        for (uint64_t c = 0; c < 3; ++c) {
            const uint64_t index = image.planar ? c * pixel_count + p : p * 3 + c;
            const int value = RawSample(bytes, image, index);
            const int r = static_cast<int>(p / static_cast<uint64_t>(image.columns));
            const int x = static_cast<int>(p % static_cast<uint64_t>(image.columns));
            if (depth == CV_8U) {
                rgb.at<cv::Vec3b>(r, x)[static_cast<int>(c)] = static_cast<uchar>(value);
            } else {
                rgb.at<cv::Vec3w>(r, x)[static_cast<int>(c)] = static_cast<uint16_t>(value);
            }
        }
    }
    if (colour == ColourConversion::Luminance) {
        ConvertedColour converted;
        cv::cvtColor(rgb, converted.gray, cv::COLOR_RGB2GRAY);
        converted.warning = "Color image converted to grayscale";
        return converted;
    }
    cv::Mat bgr;
    cv::cvtColor(rgb, bgr, cv::COLOR_RGB2BGR);
    // 12 bits stored in 16 allocated: white is 4095, not 65535
    return ConvertColour(bgr, colour, image.bits_allocated == 16 ? static_cast<int>(image.MaxSample()) : 0);
}

// One frame of one file of a stack
struct FrameRef {
    size_t file = 0;
    int64_t frame = 0;
};

// Opens the files of a series one at a time, so a large series does not hold every file open
using SourceOpener = std::function<ByteSource&(size_t file)>;

// Decodes frames of one or more DICOM files into a stack. Grayscale values are stored with one storage choice for all
// frames (ChooseStorage over the range of every frame), so equal values give equal samples on every slice.
LoadedStack BuildDicomStack(
    const std::vector<DicomImage>& images, const std::vector<FrameRef>& frames, const SourceOpener& open, ColourConversion colour) {
    const DicomImage& first = images[frames.front().file];
    LoadedStack stack;
    stack.slices = static_cast<int>(frames.size());
    stack.info.width = static_cast<int>(first.columns);
    stack.info.height = static_cast<int>(first.rows);
    stack.info.source_channels = first.samples_per_pixel;
    stack.info.pixel_spacing = first.spacing;
    const int height = stack.info.height;

    if (first.Rgb()) {
        for (size_t k = 0; k < frames.size(); ++k) {
            const DicomImage& image = images[frames[k].file];
            if (image.bits_allocated != first.bits_allocated) {
                throw std::invalid_argument("The DICOM files have different bits allocated; they cannot form one stack");
            }
            ConvertedColour converted = RgbFrameToGray(ReadFrame(open(frames[k].file), image, frames[k].frame), image, colour);
            if (k == 0) {
                stack.pixels = cv::Mat(height * stack.slices, stack.info.width, converted.gray.type());
                stack.info.value_conversion = converted.value_conversion;
                stack.warnings.push_back(converted.warning);
            }
            converted.gray.copyTo(stack.pixels.rowRange(static_cast<int>(k) * height, static_cast<int>(k + 1) * height));
        }
        stack.info.bit_depth = stack.pixels.depth() == CV_16U ? 16 : 8;
        return stack;
    }

    // First pass: the range of the values of every frame
    double minimum = std::numeric_limits<double>::infinity();
    double maximum = -std::numeric_limits<double>::infinity();
    bool integral = true;
    bool eight_bit = true;
    bool hounsfield = false;
    for (const FrameRef& ref : frames) {
        const DicomImage& image = images[ref.file];
        const std::vector<uint8_t> bytes = ReadFrame(open(ref.file), image, ref.frame);
        int32_t lowest = std::numeric_limits<int32_t>::max();
        int32_t highest = std::numeric_limits<int32_t>::min();
        for (uint64_t p = 0; p < image.PixelCount(); ++p) {
            const int32_t value = GraySample(bytes, image, p);
            lowest = std::min(lowest, value);
            highest = std::max(highest, value);
        }
        const double value_a = lowest * image.slope + image.intercept;
        const double value_b = highest * image.slope + image.intercept;
        minimum = std::min({minimum, value_a, value_b});
        maximum = std::max({maximum, value_a, value_b});
        integral = integral && IsInteger(image.slope) && IsInteger(image.intercept);
        eight_bit = eight_bit && image.bits_allocated == 8 && !image.is_signed;
        hounsfield = hounsfield || image.unit == "HU";
    }
    const ValueRange range{minimum, maximum, integral};
    const StorageChoice storage = ChooseStorage(range, eight_bit, hounsfield);
    const std::string unit = hounsfield ? "HU" : "";

    // Second pass: the stored samples
    stack.pixels = cv::Mat(height * stack.slices, stack.info.width, storage.bit_depth == 8 ? CV_8UC1 : CV_16UC1);
    uint64_t clipped = 0;
    for (size_t k = 0; k < frames.size(); ++k) {
        const DicomImage& image = images[frames[k].file];
        const std::vector<uint8_t> bytes = ReadFrame(open(frames[k].file), image, frames[k].frame);
        cv::Mat slice = stack.pixels.rowRange(static_cast<int>(k) * height, static_cast<int>(k + 1) * height);
        for (uint64_t p = 0; p < image.PixelCount(); ++p) {
            const double value = GraySample(bytes, image, p) * image.slope + image.intercept;
            const int stored = StoredSample(value, storage);
            if (storage.kind == StorageKind::Offset && value < -STORAGE_OFFSET) {
                ++clipped;
            }
            const int r = static_cast<int>(p / static_cast<uint64_t>(image.columns));
            const int x = static_cast<int>(p % static_cast<uint64_t>(image.columns));
            if (storage.bit_depth == 8) {
                slice.at<uchar>(r, x) = static_cast<uchar>(stored);
            } else {
                slice.at<uint16_t>(r, x) = static_cast<uint16_t>(stored);
            }
        }
    }
    stack.info.bit_depth = storage.bit_depth;
    if (clipped > 0) {
        stack.warnings.push_back(std::to_string(clipped) + " pixels below -1024" + (unit.empty() ? "" : " " + unit) + " are stored as 0");
    }

    // The file's value in terms of the stored sample. Inverted: value = K - (stored × scale + offset), with K the value of
    // the inverted sample plus the value of the original sample (the same for every sample of a file)
    const auto same = [&](auto property) {
        return std::all_of(
            frames.begin(), frames.end(), [&](const FrameRef& ref) { return property(images[ref.file]) == property(first); });
    };
    const bool one_rescale =
        same([](const DicomImage& image) { return image.slope; }) && same([](const DicomImage& image) { return image.intercept; });
    const bool inverted = std::any_of(frames.begin(), frames.end(), [&](const FrameRef& ref) { return images[ref.file].inverted; });
    const bool one_inversion = same([](const DicomImage& image) { return image.inverted; }) &&
                               same([](const DicomImage& image) { return image.MaxSample(); }) &&
                               same([](const DicomImage& image) { return image.is_signed; });
    double scale = storage.scale;
    double offset = storage.offset;
    const bool formula_of_file_values = inverted && one_inversion && one_rescale;
    if (formula_of_file_values) {
        const double k = (first.is_signed ? -1.0 : static_cast<double>(first.MaxSample())) * first.slope + 2 * first.intercept;
        scale = -storage.scale;
        offset = k - storage.offset;
    }
    const bool rescaled = std::any_of(
        frames.begin(), frames.end(), [&](const FrameRef& ref) { return images[ref.file].slope != 1 || images[ref.file].intercept != 0; });
    if (inverted || rescaled || storage.kind != StorageKind::Identity) {
        std::vector<std::string> parts;
        if (inverted) {
            parts.push_back(formula_of_file_values
                                ? "MONOCHROME1 inverted so that bright means dense"
                                : "MONOCHROME1 inverted so that bright means dense (the formula gives the inverted values)");
        }
        if (rescaled) {
            parts.push_back(one_rescale ? "rescale slope " + FormatValue(first.slope) + ", intercept " + FormatValue(first.intercept)
                                        : "the rescale slope and intercept of each file applied");
        }
        if (storage.kind == StorageKind::Offset) {
            parts.push_back("values stored + 1024");
        } else if (storage.kind == StorageKind::Linear) {
            parts.push_back(
                "values mapped linearly from " + FormatValue(range.minimum) + " – " + FormatValue(range.maximum) + " to 0 – 65535");
        }
        parts.push_back(ConversionFormula(scale, offset, unit));
        std::string description;
        for (const std::string& part : parts) {
            description += (description.empty() ? "" : "; ") + part;
        }
        stack.info.value_conversion = ValueConversion{scale, offset, unit, Capitalized(description)};
    }

    // The window of the first file that has one
    for (const FrameRef& ref : frames) {
        const DicomImage& image = images[ref.file];
        if (image.window_center && image.window_width && *image.window_width >= 1) {
            // DICOM linear window: from c - 0.5 - (w - 1) / 2 to c - 0.5 + (w - 1) / 2, in the file's values
            const double max_stored = storage.bit_depth == 8 ? 255 : 65535;
            const auto stored = [&](double value) { return std::clamp(std::round((value - offset) / scale), 0.0, max_stored); };
            double low = stored(*image.window_center - 0.5 - (*image.window_width - 1) / 2);
            double high = stored(*image.window_center - 0.5 + (*image.window_width - 1) / 2);
            if (low > high) {
                std::swap(low, high);
            }
            stack.window = DisplayWindow{static_cast<int>(low), static_cast<int>(high)};
            break;
        }
    }
    return stack;
}

void CheckStackPixels(int64_t width, int64_t height, int64_t slices, int64_t max_stack_pixels) {
    if (slices > MAX_SLICES) {
        throw std::invalid_argument("The stack has " + std::to_string(slices) + " slices, more than " + std::to_string(MAX_SLICES));
    }
    // width × height × slices > limit, without overflow
    if (max_stack_pixels > 0 && width * height > max_stack_pixels / slices) {
        throw StackTooLargeError(width, height, slices, max_stack_pixels);
    }
}

LoadedImage LoadDicom(ByteSource& source, int64_t max_pixels, ColourConversion colour) {
    const DicomImage image = ParseDicomImage(source, max_pixels);
    LoadedStack stack = BuildDicomStack({image}, {FrameRef{0, 0}}, [&source](size_t) -> ByteSource& { return source; }, colour);
    LoadedImage loaded;
    loaded.gray = stack.pixels;
    loaded.info = stack.info;
    loaded.window = stack.window;
    if (image.frames > 1) {
        loaded.warnings.push_back("The DICOM file contains " + FormatValue(image.declared_frames) + " frames; only the first is used");
    }
    loaded.warnings.insert(loaded.warnings.end(), stack.warnings.begin(), stack.warnings.end());
    return loaded;
}

LoadedStack LoadDicomFrames(ByteSource& source, int64_t max_pixels, int64_t max_stack_pixels, ColourConversion colour) {
    const DicomImage image = ParseDicomImage(source, max_pixels);
    CheckStackPixels(image.columns, image.rows, image.present_frames, max_stack_pixels);
    std::vector<FrameRef> frames;
    for (int64_t frame = 0; frame < image.present_frames; ++frame) {
        frames.push_back({0, frame});
    }
    LoadedStack stack = BuildDicomStack({image}, frames, [&source](size_t) -> ByteSource& { return source; }, colour);
    if (image.present_frames < image.frames) {
        // A truncated file still opens with the frames it has, as the first frame alone did before stacks
        stack.warnings.insert(stack.warnings.begin(), "The DICOM file declares " + FormatValue(image.declared_frames) +
                                                          " frames, but its pixel data holds only " + std::to_string(image.present_frames) +
                                                          "; the others are left out");
    }
    if (image.frames > 1 && image.functional_groups) {
        stack.warnings.push_back(
            "Per-frame attributes of this enhanced DICOM file (functional groups) are not read; the pixel spacing, "
            "rescale and window may be missing or apply only to some frames");
    }
    return stack;
}

bool HasDicomMagic(ByteSource& source) {
    std::array<uint8_t, 4> magic{};
    return source.Read(PREAMBLE_SIZE, magic.data(), magic.size()) == magic.size() && magic == std::array<uint8_t, 4>{'D', 'I', 'C', 'M'};
}

} // namespace

bool IsDicomFile(const std::string& path) {
    FileSource source(path);
    return HasDicomMagic(source);
}

bool IsDicomBytes(const std::vector<uchar>& bytes) {
    MemorySource source(bytes);
    return HasDicomMagic(source);
}

LoadedImage LoadDicomFile(const std::string& path, int64_t max_pixels, ColourConversion colour) {
    FileSource source(path);
    return LoadDicom(source, max_pixels, colour);
}

LoadedImage LoadDicomBytes(const std::vector<uchar>& bytes, int64_t max_pixels, ColourConversion colour) {
    MemorySource source(bytes);
    return LoadDicom(source, max_pixels, colour);
}

LoadedStack LoadDicomStackFile(const std::string& path, int64_t max_pixels, int64_t max_stack_pixels, ColourConversion colour) {
    FileSource source(path);
    return LoadDicomFrames(source, max_pixels, max_stack_pixels, colour);
}

LoadedStack LoadDicomSeries(const std::vector<std::string>& paths, int64_t max_pixels, int64_t max_stack_pixels) {
    if (paths.empty()) {
        throw std::invalid_argument("A DICOM series needs at least one file");
    }
    if (static_cast<int64_t>(paths.size()) > MAX_SLICES) {
        throw std::invalid_argument("The series has " + std::to_string(paths.size()) + " files, more than " + std::to_string(MAX_SLICES));
    }
    std::vector<std::string> warnings;
    std::vector<DicomImage> images;
    std::vector<size_t> sources; // index into paths of each image
    size_t skipped = 0;
    for (size_t i = 0; i < paths.size(); ++i) {
        FileSource source(paths[i]);
        if (!HasDicomMagic(source)) {
            ++skipped;
            continue;
        }
        try {
            images.push_back(ParseDicomImage(source, max_pixels));
            sources.push_back(i);
        } catch (const std::invalid_argument& error) {
            // e.g. a DICOMDIR or a report without pixel data; ImageTooLargeError is not an invalid_argument
            if (std::string(error.what()).find("no image") == std::string::npos) {
                throw;
            }
            ++skipped;
        }
    }
    if (images.empty()) {
        throw std::invalid_argument("None of the files is a DICOM image");
    }
    if (skipped > 0) {
        warnings.push_back(std::to_string(skipped) + (skipped == 1 ? " file is" : " files are") + " not a DICOM image and " +
                           (skipped == 1 ? "was" : "were") + " left out");
    }

    // The series with the most images
    std::map<std::string, size_t> counts;
    for (const DicomImage& image : images) {
        ++counts[image.series_uid];
    }
    std::string series;
    size_t most = 0;
    for (const auto& [uid, count] : counts) {
        if (count > most) {
            series = uid;
            most = count;
        }
    }
    if (counts.size() > 1) {
        warnings.push_back("The files belong to " + std::to_string(counts.size()) + " series; only the largest (" + std::to_string(most) +
                           " files) is used");
    }

    std::vector<size_t> order;
    for (size_t i = 0; i < images.size(); ++i) {
        if (images[i].series_uid == series) {
            order.push_back(i);
        }
    }
    const DicomImage& reference = images[order.front()];
    for (size_t i : order) {
        if (images[i].rows != reference.rows || images[i].columns != reference.columns || images[i].Rgb() != reference.Rgb()) {
            throw std::invalid_argument("The images of the series differ in size or colour; they cannot form one stack");
        }
        if (images[i].frames > 1) {
            throw std::invalid_argument("The series contains a multi-frame file; open it on its own");
        }
    }

    // Along the normal of the image plane when every file has a position and an orientation, else by instance number,
    // else in the order of the file names
    const bool positioned = std::all_of(
        order.begin(), order.end(), [&](size_t i) { return images[i].position.has_value() && images[i].orientation.has_value(); });
    const bool numbered = std::all_of(order.begin(), order.end(), [&](size_t i) { return images[i].instance.has_value(); });
    if (positioned) {
        const std::array<double, 6>& o = *reference.orientation;
        const std::array<double, 3> normal = {o[1] * o[5] - o[2] * o[4], o[2] * o[3] - o[0] * o[5], o[0] * o[4] - o[1] * o[3]};
        const auto along = [&](size_t i) {
            const std::array<double, 3>& p = *images[i].position;
            return p[0] * normal[0] + p[1] * normal[1] + p[2] * normal[2];
        };
        std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return along(a) < along(b); });
    } else if (numbered) {
        std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return *images[a].instance < *images[b].instance; });
        warnings.push_back("The files have no image position; the slices are ordered by instance number");
    } else {
        // Kept in the order of the paths, which callers give sorted by file name
        warnings.push_back("The files have no image position or instance number; the slices are in the order of the file names");
    }
    CheckStackPixels(reference.columns, reference.rows, static_cast<int64_t>(order.size()), max_stack_pixels);

    std::vector<FrameRef> frames;
    for (size_t i : order) {
        frames.push_back({i, 0});
    }
    std::unique_ptr<FileSource> current;
    size_t current_file = SIZE_MAX;
    const SourceOpener open = [&](size_t file) -> ByteSource& {
        if (file != current_file) {
            current = std::make_unique<FileSource>(paths[sources[file]]);
            current_file = file;
        }
        return *current;
    };
    LoadedStack stack = BuildDicomStack(images, frames, open, ColourConversion::Luminance);
    const auto differs = std::any_of(order.begin(), order.end(), [&](size_t i) { return !(images[i].spacing == reference.spacing); });
    if (differs) {
        warnings.push_back("The files have different pixel spacings; the first file's is used");
    }
    stack.warnings.insert(stack.warnings.begin(), warnings.begin(), warnings.end());
    stack.series_description = reference.series_description;
    return stack;
}

} // namespace glcm
