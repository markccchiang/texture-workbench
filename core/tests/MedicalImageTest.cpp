#include <gtest/gtest.h>
#include <unistd.h>
#include <zlib.h>

#include <array>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <opencv2/core.hpp>
#include <sstream>
#include <string>
#include <vector>

#include "imaging/DicomReader.hpp"
#include "imaging/ImageHeader.hpp"
#include "imaging/ImageLoader.hpp"
#include "imaging/NiftiReader.hpp"
#include "imaging/PngEncoder.hpp"
#include "imaging/ValueConversion.hpp"

namespace {

namespace fs = std::filesystem;
using glcm::SliceOrientation;
using glcm::StorageKind;

struct TemporaryFile {
    explicit TemporaryFile(const std::string& name)
        : path(fs::temp_directory_path() / ("glcm_medical_" + std::to_string(getpid()) + "_" + name)) {}
    ~TemporaryFile() {
        std::error_code ignored;
        fs::remove(path, ignored);
    }
    fs::path path;
};

void WriteFile(const fs::path& path, const std::vector<uint8_t>& bytes) {
    std::ofstream out(path, std::ios::binary);
    out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
}

void Append16(std::vector<uint8_t>& out, uint32_t value) {
    out.push_back(static_cast<uint8_t>(value));
    out.push_back(static_cast<uint8_t>(value >> 8));
}

void Append32(std::vector<uint8_t>& out, uint32_t value) {
    Append16(out, value & 0xFFFF);
    Append16(out, value >> 16);
}

// ---- DICOM ----

struct Element {
    uint16_t group;
    uint16_t element;
    std::string vr;
    std::vector<uint8_t> value;
    bool undefined_length = false; // a sequence whose value holds encoded items and the delimiter
};

std::vector<uint8_t> Text(std::string text, char pad = ' ') {
    if (text.size() % 2 == 1) {
        text.push_back(pad);
    }
    return {text.begin(), text.end()};
}

std::vector<uint8_t> Short(uint16_t value) {
    std::vector<uint8_t> out;
    Append16(out, value);
    return out;
}

std::vector<uint8_t> Words(const std::vector<int>& values) {
    std::vector<uint8_t> out;
    for (int value : values) {
        Append16(out, static_cast<uint32_t>(value) & 0xFFFF);
    }
    return out;
}

void AppendElement(std::vector<uint8_t>& out, const Element& e, bool explicit_vr) {
    Append16(out, e.group);
    Append16(out, e.element);
    const uint32_t length = e.undefined_length ? 0xFFFFFFFF : static_cast<uint32_t>(e.value.size());
    if (explicit_vr) {
        out.push_back(static_cast<uint8_t>(e.vr[0]));
        out.push_back(static_cast<uint8_t>(e.vr[1]));
        static const std::vector<std::string> LONG = {"OB", "OW", "SQ", "UN", "UT"};
        if (std::find(LONG.begin(), LONG.end(), e.vr) != LONG.end()) {
            Append16(out, 0);
            Append32(out, length);
        } else {
            Append16(out, length);
        }
    } else {
        Append32(out, length);
    }
    out.insert(out.end(), e.value.begin(), e.value.end());
}

std::vector<uint8_t> Dicom(const std::string& transfer_syntax, const std::vector<Element>& elements) {
    const bool explicit_vr = transfer_syntax != "1.2.840.10008.1.2";
    std::vector<uint8_t> out(128, 0);
    for (char c : {'D', 'I', 'C', 'M'}) {
        out.push_back(static_cast<uint8_t>(c));
    }
    AppendElement(out, {0x0002, 0x0010, "UI", Text(transfer_syntax, '\0')}, true);
    for (const Element& element : elements) {
        AppendElement(out, element, explicit_vr);
    }
    return out;
}

// A sequence with one item of undefined length holding one element, then the sequence delimiter
Element NestedSequence(bool explicit_vr) {
    std::vector<uint8_t> value;
    Append16(value, 0xFFFE);
    Append16(value, 0xE000);
    Append32(value, 0xFFFFFFFF);
    AppendElement(value, {0x0028, 0x0010, "US", Short(9999)}, explicit_vr); // Rows inside a sequence: ignored
    Append16(value, 0xFFFE);
    Append16(value, 0xE00D);
    Append32(value, 0);
    Append16(value, 0xFFFE);
    Append16(value, 0xE0DD);
    Append32(value, 0);
    return {0x0008, 0x1140, "SQ", value, true};
}

std::vector<Element> Monochrome(int rows, int columns, int bits_allocated, int bits_stored, int pixel_representation,
    const std::string& photometric, const std::vector<uint8_t>& pixels) {
    return {
        {0x0028, 0x0002, "US", Short(1)},
        {0x0028, 0x0004, "CS", Text(photometric)},
        {0x0028, 0x0010, "US", Short(static_cast<uint16_t>(rows))},
        {0x0028, 0x0011, "US", Short(static_cast<uint16_t>(columns))},
        {0x0028, 0x0100, "US", Short(static_cast<uint16_t>(bits_allocated))},
        {0x0028, 0x0101, "US", Short(static_cast<uint16_t>(bits_stored))},
        {0x0028, 0x0102, "US", Short(static_cast<uint16_t>(bits_stored - 1))},
        {0x0028, 0x0103, "US", Short(static_cast<uint16_t>(pixel_representation))},
        {0x7FE0, 0x0010, bits_allocated == 8 ? "OB" : "OW", pixels},
    };
}

std::vector<Element> Inserted(std::vector<Element> elements, const std::vector<Element>& extra) {
    // Before the pixel data, which comes last
    elements.insert(elements.end() - 1, extra.begin(), extra.end());
    return elements;
}

constexpr const char* EXPLICIT_LE = "1.2.840.10008.1.2.1";
constexpr const char* IMPLICIT_LE = "1.2.840.10008.1.2";

TEST(DicomReaderTest, StoresSignedCtValuesPlus1024WithSpacingAndWindow) {
    const std::vector<Element> elements = Inserted(
        Monochrome(2, 3, 16, 16, 1, "MONOCHROME2", Words({0, 1024, 2048, -1000, 500, 3000})), {
                                                                                                  {0x0008, 0x0060, "CS", Text("CT")},
                                                                                                  {0x0028, 0x0030, "DS", Text("0.7\\0.5")},
                                                                                                  {0x0028, 0x1050, "DS", Text("40\\400")},
                                                                                                  {0x0028, 0x1051, "DS", Text("400\\2000")},
                                                                                                  {0x0028, 0x1052, "DS", Text("-1024")},
                                                                                                  {0x0028, 0x1053, "DS", Text("1")},
                                                                                              });
    // Elements must be in tag order: modality (0008) first
    std::vector<Element> ordered = {elements[8]};
    ordered.insert(ordered.end(), elements.begin(), elements.begin() + 8);
    ordered.insert(ordered.end(), elements.begin() + 9, elements.end());
    const std::vector<uint8_t> file = Dicom(EXPLICIT_LE, ordered);

    const glcm::LoadedImage image = glcm::LoadDicomBytes(file);
    ASSERT_EQ(image.gray.type(), CV_16UC1);
    EXPECT_EQ(image.info.width, 3);
    EXPECT_EQ(image.info.height, 2);
    EXPECT_EQ(image.info.bit_depth, 16);
    // HU = pixel - 1024; stored = HU + 1024 = pixel, and -2024 HU is clipped to 0
    const std::vector<int> expected = {0, 1024, 2048, 0, 500, 3000};
    for (int i = 0; i < 6; ++i) {
        EXPECT_EQ(image.gray.at<uint16_t>(i / 3, i % 3), expected[i]) << i;
    }
    ASSERT_TRUE(image.info.pixel_spacing.has_value());
    EXPECT_DOUBLE_EQ(image.info.pixel_spacing->x_mm, 0.5);
    EXPECT_DOUBLE_EQ(image.info.pixel_spacing->y_mm, 0.7);
    ASSERT_TRUE(image.info.value_conversion.has_value());
    EXPECT_EQ(image.info.value_conversion->unit, "HU");
    EXPECT_EQ(image.info.value_conversion->scale, 1);
    EXPECT_EQ(image.info.value_conversion->offset, -1024);
    EXPECT_EQ(image.info.value_conversion->description, "Rescale slope 1, intercept -1024; values stored + 1024; HU = stored value - 1024");
    EXPECT_EQ(image.warnings, std::vector<std::string>{"1 pixels below -1024 HU are stored as 0"});
    // Center 40, width 400: -160 to 239 HU
    ASSERT_TRUE(image.window.has_value());
    EXPECT_EQ(image.window->min, 864);
    EXPECT_EQ(image.window->max, 1263);
}

TEST(DicomReaderTest, InvertsMonochrome1AndSkipsSequencesInImplicitVr) {
    // 12 bits stored in 16; the unused high bits hold garbage
    std::vector<Element> elements = Monochrome(2, 2, 16, 12, 0, "MONOCHROME1", Words({0xF000, 0x0FFF | 0xA000, 100, 4000}));
    elements.insert(elements.begin(), NestedSequence(false));
    elements = Inserted(elements, {{0x0028, 0x1050, "DS", Text("1000")}, {0x0028, 0x1051, "DS", Text("501")}});
    // ImagerPixelSpacing (0018,1164) belongs before group 0028
    elements.insert(elements.begin() + 1, Element{0x0018, 0x1164, "DS", Text("0.1\\0.2")});
    TemporaryFile file("mono1.dcm");
    WriteFile(file.path, Dicom(IMPLICIT_LE, elements));

    const glcm::LoadedImage image = glcm::LoadImageFile(file.path.string());
    ASSERT_EQ(image.gray.type(), CV_16UC1);
    EXPECT_EQ(image.info.height, 2); // not the 9999 rows inside the sequence
    EXPECT_EQ(image.gray.at<uint16_t>(0, 0), 4095);
    EXPECT_EQ(image.gray.at<uint16_t>(0, 1), 0);
    EXPECT_EQ(image.gray.at<uint16_t>(1, 0), 3995);
    EXPECT_EQ(image.gray.at<uint16_t>(1, 1), 95);
    ASSERT_TRUE(image.info.pixel_spacing.has_value());
    EXPECT_DOUBLE_EQ(image.info.pixel_spacing->x_mm, 0.2);
    EXPECT_DOUBLE_EQ(image.info.pixel_spacing->y_mm, 0.1);
    ASSERT_TRUE(image.info.value_conversion.has_value());
    EXPECT_EQ(image.info.value_conversion->scale, -1);
    EXPECT_EQ(image.info.value_conversion->offset, 4095);
    EXPECT_EQ(image.info.value_conversion->description, "MONOCHROME1 inverted so that bright means dense; value = 4095 - stored value");
    // Window 749.5 to 1249.5 in the file's values is 3345.5 to 2845.5 stored: 2846 to 3346 after rounding and sorting
    ASSERT_TRUE(image.window.has_value());
    EXPECT_EQ(image.window->min, 2846);
    EXPECT_EQ(image.window->max, 3346);
}

TEST(DicomReaderTest, KeepsEightBitImagesAndMapsFractionalSlopesLinearly) {
    const glcm::LoadedImage eight = glcm::LoadDicomBytes(Dicom(EXPLICIT_LE, Monochrome(1, 3, 8, 8, 0, "MONOCHROME2", {0, 128, 255})));
    ASSERT_EQ(eight.gray.type(), CV_8UC1);
    EXPECT_EQ(eight.gray.at<uchar>(0, 1), 128);
    EXPECT_FALSE(eight.info.value_conversion.has_value());
    EXPECT_FALSE(eight.window.has_value());
    EXPECT_TRUE(eight.warnings.empty());

    const glcm::LoadedImage linear = glcm::LoadDicomBytes(Dicom(
        EXPLICIT_LE, Inserted(Monochrome(1, 4, 16, 16, 0, "MONOCHROME2", Words({0, 1, 2, 3})), {{0x0028, 0x1053, "DS", Text("0.5")}})));
    ASSERT_EQ(linear.gray.type(), CV_16UC1);
    EXPECT_EQ(linear.gray.at<uint16_t>(0, 0), 0);
    EXPECT_EQ(linear.gray.at<uint16_t>(0, 1), 21845);
    EXPECT_EQ(linear.gray.at<uint16_t>(0, 2), 43690);
    EXPECT_EQ(linear.gray.at<uint16_t>(0, 3), 65535);
    ASSERT_TRUE(linear.info.value_conversion.has_value());
    EXPECT_NEAR(linear.info.value_conversion->scale, 1.5 / 65535, 1e-15);
    EXPECT_EQ(linear.info.value_conversion->offset, 0);
    EXPECT_EQ(linear.info.value_conversion->description,
        "Rescale slope 0.5, intercept 0; values mapped linearly from 0 – 1.5 to 0 – 65535; value = stored value × 2.28885e-05");
}

TEST(DicomReaderTest, ConvertsRgbToGrayscale) {
    std::vector<Element> elements = Monochrome(1, 2, 8, 8, 0, "RGB", {255, 0, 0, 0, 0, 255});
    elements[0].value = Short(3);
    const glcm::LoadedImage image = glcm::LoadDicomBytes(Dicom(EXPLICIT_LE, elements));
    ASSERT_EQ(image.gray.type(), CV_8UC1);
    EXPECT_EQ(image.info.source_channels, 3);
    EXPECT_EQ(image.gray.at<uchar>(0, 0), 76); // red
    EXPECT_EQ(image.gray.at<uchar>(0, 1), 29); // blue
    EXPECT_EQ(image.warnings, std::vector<std::string>{"Color image converted to grayscale"});
}

TEST(DicomReaderTest, RefusesCompressedTruncatedAndOversizedFiles) {
    const std::vector<Element> elements = Monochrome(2, 2, 16, 16, 0, "MONOCHROME2", Words({1, 2, 3, 4}));
    try {
        glcm::LoadDicomBytes(Dicom("1.2.840.10008.1.2.4.90", elements));
        FAIL() << "expected std::invalid_argument";
    } catch (const std::invalid_argument& error) {
        EXPECT_NE(std::string(error.what()).find("Compressed DICOM images"), std::string::npos);
    }
    EXPECT_THROW(glcm::LoadDicomBytes(Dicom("1.2.840.10008.1.2.5", elements)), std::invalid_argument);
    EXPECT_THROW(glcm::LoadDicomBytes(Dicom("1.2.840.10008.1.2.2", elements)), std::invalid_argument);

    std::vector<uint8_t> truncated = Dicom(EXPLICIT_LE, elements);
    truncated.resize(truncated.size() - 1);
    EXPECT_THROW(glcm::LoadDicomBytes(truncated), std::runtime_error);

    EXPECT_THROW(glcm::LoadDicomBytes(Dicom(EXPLICIT_LE, elements), 3), glcm::ImageTooLargeError);
    EXPECT_EQ(glcm::LoadDicomBytes(Dicom(EXPLICIT_LE, elements), 4).info.width, 2);

    std::vector<Element> palette = elements;
    palette[1].value = Text("PALETTE COLOR");
    EXPECT_THROW(glcm::LoadDicomBytes(Dicom(EXPLICIT_LE, palette)), std::invalid_argument);

    std::vector<Element> no_pixels(elements.begin(), elements.end() - 1);
    EXPECT_THROW(glcm::LoadDicomBytes(Dicom(EXPLICIT_LE, no_pixels)), std::invalid_argument);
}

TEST(DicomReaderTest, UsesTheFirstFrameWithAWarning) {
    std::vector<Element> elements = Inserted(Monochrome(1, 2, 8, 8, 0, "MONOCHROME2", {1, 2, 3, 4}), {{0x0028, 0x0008, "IS", Text("2")}});
    // NumberOfFrames (0028,0008) comes after PhotometricInterpretation (0028,0004)
    std::rotate(elements.begin() + 2, elements.end() - 2, elements.end() - 1);
    const glcm::LoadedImage image = glcm::LoadDicomBytes(Dicom(EXPLICIT_LE, elements));
    EXPECT_EQ(image.gray.at<uchar>(0, 1), 2);
    EXPECT_EQ(image.warnings, std::vector<std::string>{"The DICOM file contains 2 frames; only the first is used"});
}

TEST(DicomReaderTest, ReadsEveryFrameAsAStackWithOneStorage) {
    // Two frames of signed CT values; the second frame's range makes both be stored + 1024
    std::vector<Element> elements = Inserted(Monochrome(1, 2, 16, 16, 1, "MONOCHROME2", Words({10, 20, -500, 30})),
        {{0x0008, 0x0060, "CS", Text("CT")}, {0x0028, 0x0008, "IS", Text("2")}});
    std::sort(elements.begin(), elements.end(),
        [](const Element& a, const Element& b) { return std::make_pair(a.group, a.element) < std::make_pair(b.group, b.element); });
    TemporaryFile file("frames.dcm");
    WriteFile(file.path, Dicom(EXPLICIT_LE, elements));

    const glcm::LoadedStack stack = glcm::LoadDicomStackFile(file.path.string());
    ASSERT_EQ(stack.slices, 2);
    ASSERT_EQ(stack.pixels.size(), cv::Size(2, 2));
    EXPECT_EQ(stack.Slice(0).at<uint16_t>(0, 0), 1034);
    EXPECT_EQ(stack.Slice(0).at<uint16_t>(0, 1), 1044);
    EXPECT_EQ(stack.Slice(1).at<uint16_t>(0, 0), 524);
    EXPECT_EQ(stack.Slice(1).at<uint16_t>(0, 1), 1054);
    ASSERT_TRUE(stack.info.value_conversion.has_value());
    EXPECT_EQ(stack.info.value_conversion->offset, -1024);
    EXPECT_TRUE(stack.warnings.empty());
    // The same file as an image keeps its first frame, as before
    const glcm::LoadedStack as_stack = glcm::LoadImageStackFile(file.path.string());
    EXPECT_EQ(as_stack.slices, 2);
    EXPECT_THROW(glcm::LoadDicomStackFile(file.path.string(), 0, 3), glcm::StackTooLargeError);
}

std::vector<uint8_t> SeriesFile(const std::string& series, double z, int instance, double slope, const std::vector<int>& values) {
    std::ostringstream position;
    position << "0\\0\\" << z;
    std::vector<Element> elements = Inserted(Monochrome(1, 2, 16, 12, 0, "MONOCHROME2", Words(values)),
        {{0x0008, 0x0060, "CS", Text("MR")}, {0x0008, 0x103E, "LO", Text("T1 axial")}, {0x0020, 0x000E, "UI", Text(series, '\0')},
            {0x0020, 0x0013, "IS", Text(std::to_string(instance))}, {0x0020, 0x0032, "DS", Text(position.str())},
            {0x0020, 0x0037, "DS", Text("1\\0\\0\\0\\1\\0")}, {0x0028, 0x0030, "DS", Text("0.5\\0.25")},
            {0x0028, 0x1053, "DS", Text(slope == 1 ? "1" : "2")}});
    std::sort(elements.begin(), elements.end(),
        [](const Element& a, const Element& b) { return std::make_pair(a.group, a.element) < std::make_pair(b.group, b.element); });
    return Dicom(EXPLICIT_LE, elements);
}

TEST(DicomReaderTest, OrdersASeriesAlongTheImageNormalWithOneStorage) {
    // Files written in a shuffled order, with instance numbers that disagree with the positions, one of another series
    // and one that is not DICOM
    TemporaryFile a("series_a.dcm"), b("series_b.dcm"), c("series_c.dcm"), other("series_other.dcm"), text("series_notes.txt");
    WriteFile(a.path, SeriesFile("1.2.3", 5.0, 1, 1, {1, 2}));
    WriteFile(b.path, SeriesFile("1.2.3", -5.0, 2, 2, {3, 4}));
    WriteFile(c.path, SeriesFile("1.2.3", 0.0, 3, 1, {5, 6}));
    WriteFile(other.path, SeriesFile("9.9", 0.0, 1, 1, {7, 8}));
    WriteFile(text.path, {'h', 'i'});

    const glcm::LoadedStack stack =
        glcm::LoadDicomSeries({a.path.string(), b.path.string(), c.path.string(), other.path.string(), text.path.string()});
    ASSERT_EQ(stack.slices, 3);
    // z = -5, 0, 5; the slope 2 of one file applies to its samples
    EXPECT_EQ(stack.Slice(0).at<uint16_t>(0, 0), 6);
    EXPECT_EQ(stack.Slice(0).at<uint16_t>(0, 1), 8);
    EXPECT_EQ(stack.Slice(1).at<uint16_t>(0, 0), 5);
    EXPECT_EQ(stack.Slice(2).at<uint16_t>(0, 1), 2);
    ASSERT_TRUE(stack.info.pixel_spacing.has_value());
    EXPECT_EQ(stack.info.pixel_spacing->x_mm, 0.25);
    EXPECT_EQ(stack.series_description, "T1 axial");
    ASSERT_TRUE(stack.info.value_conversion.has_value());
    EXPECT_NE(stack.info.value_conversion->description.find("rescale slope and intercept of each file"), std::string::npos);
    EXPECT_EQ(stack.warnings, (std::vector<std::string>{"1 file is not a DICOM image and was left out",
                                  "The files belong to 2 series; only the largest (3 files) is used"}));

    EXPECT_THROW(glcm::LoadDicomSeries({text.path.string()}), std::invalid_argument);
    EXPECT_THROW(glcm::LoadDicomSeries({a.path.string(), b.path.string()}, 0, 3), glcm::StackTooLargeError);
}

// ---- NIfTI ----

struct Nifti {
    std::array<int, 5> dim = {3, 4, 3, 2, 1}; // dim[0], then i, j, k, t
    int datatype = 4;                         // int16
    int bitpix = 16;
    std::array<float, 4> pixdim = {1, 1, 1, 1}; // qfac, then i, j, k
    float slope = 0;
    float intercept = 0;
    int qform_code = 0;
    std::array<float, 3> quaternion = {0, 0, 0};
    int sform_code = 0;
    std::array<std::array<float, 4>, 3> srow{};
    const char* magic = "n+1";
    std::vector<uint8_t> data;
};

void Put16(std::vector<uint8_t>& out, size_t offset, int value) {
    out[offset] = static_cast<uint8_t>(value);
    out[offset + 1] = static_cast<uint8_t>(value >> 8);
}

void PutFloat(std::vector<uint8_t>& out, size_t offset, float value) {
    std::memcpy(out.data() + offset, &value, 4); // test hosts are little endian
}

std::vector<uint8_t> NiftiBytes(const Nifti& nifti) {
    std::vector<uint8_t> out(352, 0);
    Put16(out, 0, 348);
    for (int d = 0; d < 5; ++d) {
        Put16(out, 40 + 2 * d, nifti.dim[d]);
    }
    Put16(out, 70, nifti.datatype);
    Put16(out, 72, nifti.bitpix);
    for (int d = 0; d < 4; ++d) {
        PutFloat(out, 76 + 4 * d, nifti.pixdim[d]);
    }
    PutFloat(out, 108, 352);
    PutFloat(out, 112, nifti.slope);
    PutFloat(out, 116, nifti.intercept);
    out[123] = 2; // millimetres
    Put16(out, 252, nifti.qform_code);
    Put16(out, 254, nifti.sform_code);
    for (int q = 0; q < 3; ++q) {
        PutFloat(out, 256 + 4 * q, nifti.quaternion[q]);
    }
    for (int row = 0; row < 3; ++row) {
        for (int column = 0; column < 4; ++column) {
            PutFloat(out, 280 + 16 * row + 4 * column, nifti.srow[row][column]);
        }
    }
    std::memcpy(out.data() + 344, nifti.magic, 4);
    out.insert(out.end(), nifti.data.begin(), nifti.data.end());
    return out;
}

void WriteGzip(const fs::path& path, const std::vector<uint8_t>& bytes) {
    gzFile file = gzopen(path.string().c_str(), "wb");
    ASSERT_NE(file, nullptr);
    ASSERT_EQ(gzwrite(file, bytes.data(), static_cast<unsigned>(bytes.size())), static_cast<int>(bytes.size()));
    gzclose(file);
}

// int16 voxels i + 10 j + 100 k + 1000 t
std::vector<uint8_t> Ramp(int ni, int nj, int nk, int nt = 1) {
    std::vector<uint8_t> data;
    for (int t = 0; t < nt; ++t) {
        for (int k = 0; k < nk; ++k) {
            for (int j = 0; j < nj; ++j) {
                for (int i = 0; i < ni; ++i) {
                    Append16(data, static_cast<uint32_t>(i + 10 * j + 100 * k + 1000 * t));
                }
            }
        }
    }
    return data;
}

Nifti RasVolume(float sx, float sy, float sz) {
    Nifti nifti;
    nifti.sform_code = 1;
    nifti.srow = {{{sx, 0, 0, 0}, {0, sy, 0, 0}, {0, 0, sz, 0}}};
    nifti.data = Ramp(4, 3, 2);
    return nifti;
}

int Pixel(const glcm::LoadedImage& image, int row, int column) {
    return image.gray.depth() == CV_8U ? image.gray.at<uchar>(row, column) : image.gray.at<uint16_t>(row, column);
}

TEST(NiftiReaderTest, DescribesAVolumeAndItsSlicesInRasOrientation) {
    TemporaryFile file("ras.nii");
    WriteFile(file.path, NiftiBytes(RasVolume(2, 3, 4)));
    const glcm::NiftiVolumeInfo info = glcm::InspectNiftiVolume(file.path.string());
    EXPECT_EQ(info.version, 1);
    EXPECT_EQ(info.dimensions, (std::array<int64_t, 3>{4, 3, 2}));
    EXPECT_EQ(info.volumes, 1);
    EXPECT_EQ(info.data_type, "int16");
    EXPECT_EQ(info.orientation_source, "sform");
    EXPECT_EQ(info.axis_codes, "RAS");
    EXPECT_EQ(info.acquisition_orientation, SliceOrientation::Axial);
    const auto& axial = info.slices[0];
    EXPECT_EQ((std::array<int64_t, 3>{axial.count, axial.width, axial.height}), (std::array<int64_t, 3>{2, 4, 3}));
    EXPECT_EQ(axial.pixel_spacing, (glcm::PixelSpacing{2, 3}));
    const auto& coronal = info.slices[1];
    EXPECT_EQ((std::array<int64_t, 3>{coronal.count, coronal.width, coronal.height}), (std::array<int64_t, 3>{3, 4, 2}));
    EXPECT_EQ(coronal.pixel_spacing, (glcm::PixelSpacing{2, 4}));
    const auto& sagittal = info.slices[2];
    EXPECT_EQ((std::array<int64_t, 3>{sagittal.count, sagittal.width, sagittal.height}), (std::array<int64_t, 3>{4, 3, 2}));
    EXPECT_EQ(sagittal.pixel_spacing, (glcm::PixelSpacing{3, 4}));
    EXPECT_EQ(info.minimum, 0);
    EXPECT_EQ(info.maximum, 123);
    EXPECT_EQ(info.storage.kind, StorageKind::Identity);
    EXPECT_EQ(info.storage.bit_depth, 16);
    EXPECT_FALSE(info.value_conversion.has_value());
    EXPECT_TRUE(info.warnings.empty());
    // 24 voxels: ranks 1 and 24
    EXPECT_EQ(info.window.min, 0);
    EXPECT_EQ(info.window.max, 123);

    // Axial slice 1: columns run along R (i), rows from anterior (top) to posterior
    const glcm::LoadedImage axial_slice = glcm::ExtractNiftiSlice(file.path.string(), SliceOrientation::Axial, 1, 0, info.storage);
    ASSERT_EQ(axial_slice.gray.size(), cv::Size(4, 3));
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 4; ++c) {
            EXPECT_EQ(Pixel(axial_slice, r, c), c + 10 * (2 - r) + 100) << r << "," << c;
        }
    }
    EXPECT_EQ(axial_slice.info.pixel_spacing, (glcm::PixelSpacing{2, 3}));

    // Coronal slice 2 (j = 2): rows from superior (top)
    const glcm::LoadedImage coronal_slice = glcm::ExtractNiftiSlice(file.path.string(), SliceOrientation::Coronal, 2, 0, info.storage);
    ASSERT_EQ(coronal_slice.gray.size(), cv::Size(4, 2));
    for (int r = 0; r < 2; ++r) {
        for (int c = 0; c < 4; ++c) {
            EXPECT_EQ(Pixel(coronal_slice, r, c), c + 20 + 100 * (1 - r)) << r << "," << c;
        }
    }

    // Sagittal slice 3 (i = 3): columns from posterior to anterior
    const glcm::LoadedImage sagittal_slice = glcm::ExtractNiftiSlice(file.path.string(), SliceOrientation::Sagittal, 3, 0, info.storage);
    ASSERT_EQ(sagittal_slice.gray.size(), cv::Size(3, 2));
    for (int r = 0; r < 2; ++r) {
        for (int c = 0; c < 3; ++c) {
            EXPECT_EQ(Pixel(sagittal_slice, r, c), 3 + 10 * c + 100 * (1 - r)) << r << "," << c;
        }
    }

    EXPECT_THROW(glcm::ExtractNiftiSlice(file.path.string(), SliceOrientation::Axial, 2, 0, info.storage), std::invalid_argument);
    EXPECT_THROW(glcm::ExtractNiftiSlice(file.path.string(), SliceOrientation::Axial, 0, 1, info.storage), std::invalid_argument);
    EXPECT_THROW(glcm::ExtractNiftiSlice(file.path.string(), SliceOrientation::Axial, 0, 0, info.storage, 11), glcm::ImageTooLargeError);
}

TEST(NiftiReaderTest, FlipsAndPermutesAxesIntoRas) {
    TemporaryFile flipped_file("lps.nii");
    WriteFile(flipped_file.path, NiftiBytes(RasVolume(-2, -3, 4)));
    const glcm::NiftiVolumeInfo flipped = glcm::InspectNiftiVolume(flipped_file.path.string());
    EXPECT_EQ(flipped.axis_codes, "LPS");
    const glcm::LoadedImage axial = glcm::ExtractNiftiSlice(flipped_file.path.string(), SliceOrientation::Axial, 0, 0, flipped.storage);
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 4; ++c) {
            // x = c runs against i; y = 2 - r runs against j
            EXPECT_EQ(Pixel(axial, r, c), (3 - c) + 10 * r) << r << "," << c;
        }
    }

    // i points superior, j right and k anterior
    Nifti permuted;
    permuted.sform_code = 1;
    permuted.srow = {{{0, 1, 0, 0}, {0, 0, 1, 0}, {1, 0, 0, 0}}};
    permuted.data = Ramp(4, 3, 2);
    TemporaryFile permuted_file("sra.nii");
    WriteFile(permuted_file.path, NiftiBytes(permuted));
    const glcm::NiftiVolumeInfo info = glcm::InspectNiftiVolume(permuted_file.path.string());
    EXPECT_EQ(info.axis_codes, "SRA");
    EXPECT_EQ(info.acquisition_orientation, SliceOrientation::Coronal);
    // Axial slices: constant i; columns along R = j (3), rows along A = k (2)
    const glcm::LoadedImage slice = glcm::ExtractNiftiSlice(permuted_file.path.string(), SliceOrientation::Axial, 1, 0, info.storage);
    ASSERT_EQ(slice.gray.size(), cv::Size(3, 2));
    for (int r = 0; r < 2; ++r) {
        for (int c = 0; c < 3; ++c) {
            EXPECT_EQ(Pixel(slice, r, c), 1 + 10 * c + 100 * (1 - r)) << r << "," << c;
        }
    }
}

TEST(NiftiReaderTest, UsesTheQformAndFallsBackToRasWithoutOrientation) {
    Nifti qform = RasVolume(1, 1, 1);
    qform.sform_code = 0;
    qform.qform_code = 1;
    qform.pixdim = {-1, 0.5, 0.25, 2}; // qfac -1 flips k
    TemporaryFile qform_file("qform.nii");
    WriteFile(qform_file.path, NiftiBytes(qform));
    const glcm::NiftiVolumeInfo info = glcm::InspectNiftiVolume(qform_file.path.string());
    EXPECT_EQ(info.orientation_source, "qform");
    EXPECT_EQ(info.axis_codes, "RAI");
    EXPECT_EQ(info.slices[1].pixel_spacing, (glcm::PixelSpacing{0.5, 2}));

    Nifti none = RasVolume(1, 1, 1);
    none.sform_code = 0;
    none.pixdim = {1, 0.9f, 0.9f, 3};
    TemporaryFile none_file("none.nii");
    WriteFile(none_file.path, NiftiBytes(none));
    const glcm::NiftiVolumeInfo plain = glcm::InspectNiftiVolume(none_file.path.string());
    EXPECT_EQ(plain.orientation_source, "none");
    EXPECT_EQ(plain.axis_codes, "RAS");
    ASSERT_EQ(plain.warnings.size(), 1u);
    EXPECT_NE(plain.warnings[0].find("no orientation"), std::string::npos);
}

TEST(NiftiReaderTest, ReadsCompressedFilesAndWritesAnUncompressedCopy) {
    Nifti nifti = RasVolume(1, 1, 1);
    nifti.dim = {4, 4, 3, 2, 2};
    nifti.data = Ramp(4, 3, 2, 2);
    TemporaryFile compressed("volume.nii.gz");
    WriteGzip(compressed.path, NiftiBytes(nifti));
    TemporaryFile copy("volume-copy.nii");

    EXPECT_TRUE(glcm::IsNiftiFile(compressed.path.string()));
    const glcm::NiftiVolumeInfo info = glcm::InspectNiftiVolume(compressed.path.string(), copy.path.string());
    EXPECT_EQ(info.volumes, 2);
    EXPECT_EQ(info.maximum, 1123);
    EXPECT_EQ(fs::file_size(copy.path), 352u + nifti.data.size());

    const auto from_copy = glcm::ExtractNiftiSlice(copy.path.string(), SliceOrientation::Sagittal, 2, 1, info.storage);
    const auto from_compressed = glcm::ExtractNiftiSlice(compressed.path.string(), SliceOrientation::Sagittal, 2, 1, info.storage);
    EXPECT_EQ(cv::countNonZero(from_copy.gray != from_compressed.gray), 0);
    EXPECT_EQ(Pixel(from_copy, 0, 0), 2 + 100 + 1000);

    EXPECT_THROW(glcm::InspectNiftiVolume(compressed.path.string(), "", nifti.data.size() - 1), glcm::VolumeTooLargeError);
    EXPECT_NO_THROW(glcm::InspectNiftiVolume(compressed.path.string(), "", nifti.data.size()));
}

TEST(NiftiReaderTest, AppliesTheSlopeAndStoresValuesByTheirRange) {
    // int16 with slope 2, intercept -100: values -100 ... 146, integers with a negative minimum
    Nifti rescaled = RasVolume(1, 1, 1);
    rescaled.slope = 2;
    rescaled.intercept = -100;
    TemporaryFile rescaled_file("rescaled.nii");
    WriteFile(rescaled_file.path, NiftiBytes(rescaled));
    const glcm::NiftiVolumeInfo offset = glcm::InspectNiftiVolume(rescaled_file.path.string());
    EXPECT_EQ(offset.minimum, -100);
    EXPECT_EQ(offset.maximum, 146);
    EXPECT_EQ(offset.storage.kind, StorageKind::Offset);
    ASSERT_TRUE(offset.value_conversion.has_value());
    EXPECT_EQ(offset.value_conversion->description,
        "Rescaled with scl_slope 2, scl_inter -100; values stored + 1024; value = stored value - 1024");
    const auto slice = glcm::ExtractNiftiSlice(rescaled_file.path.string(), SliceOrientation::Axial, 0, 0, offset.storage);
    EXPECT_EQ(Pixel(slice, 2, 1), 1 * 2 - 100 + 1024); // voxel (1, 0, 0)
    ASSERT_TRUE(slice.info.value_conversion.has_value());
    EXPECT_EQ(slice.info.value_conversion->description, offset.value_conversion->description);

    // float32 with a NaN: mapped linearly from the finite minimum-maximum
    Nifti floating = RasVolume(1, 1, 1);
    floating.dim = {3, 2, 2, 1, 1};
    floating.datatype = 16;
    floating.bitpix = 32;
    floating.data.clear();
    for (float value : {-1.5f, 0.5f, std::numeric_limits<float>::quiet_NaN(), 2.5f}) {
        const auto* bytes = reinterpret_cast<const uint8_t*>(&value);
        floating.data.insert(floating.data.end(), bytes, bytes + 4);
    }
    TemporaryFile float_file("float.nii");
    WriteFile(float_file.path, NiftiBytes(floating));
    const glcm::NiftiVolumeInfo linear = glcm::InspectNiftiVolume(float_file.path.string());
    EXPECT_EQ(linear.storage.kind, StorageKind::Linear);
    EXPECT_EQ(linear.value_conversion->description,
        "Values mapped linearly from -1.5 – 2.5 to 0 – 65535; value = stored value × 6.10361e-05 - 1.5");
    EXPECT_EQ(linear.warnings, std::vector<std::string>{"1 voxels are not finite numbers; they are stored as 0"});
    const glcm::LoadedImage image = glcm::LoadImageFile(float_file.path.string());
    // Rows from anterior: row 0 is j = 1
    EXPECT_EQ(Pixel(image, 1, 0), 0);
    EXPECT_EQ(Pixel(image, 1, 1), 32768); // 0.5 is half-way
    EXPECT_EQ(Pixel(image, 0, 0), 0);     // NaN
    EXPECT_EQ(Pixel(image, 0, 1), 65535);
    EXPECT_EQ(image.info.value_conversion->description, linear.value_conversion->description);
    ASSERT_TRUE(image.window.has_value());

    // uint8 stays 8-bit
    Nifti bytes = RasVolume(1, 1, 1);
    bytes.dim = {2, 2, 1, 1, 1};
    bytes.datatype = 2;
    bytes.bitpix = 8;
    bytes.data = {7, 200};
    TemporaryFile bytes_file("bytes.nii");
    WriteFile(bytes_file.path, NiftiBytes(bytes));
    const glcm::LoadedImage eight = glcm::LoadImageFile(bytes_file.path.string());
    EXPECT_EQ(eight.info.bit_depth, 8);
    EXPECT_EQ(Pixel(eight, 0, 1), 200);
}

TEST(NiftiReaderTest, RefusesVolumesAsImagesAndUnsupportedFiles) {
    TemporaryFile volume("volume.nii");
    WriteFile(volume.path, NiftiBytes(RasVolume(1, 1, 1)));
    try {
        glcm::LoadImageFile(volume.path.string());
        FAIL() << "expected std::invalid_argument";
    } catch (const std::invalid_argument& error) {
        EXPECT_EQ(std::string(error.what()), "The NIfTI file holds a 4 × 3 × 2 volume; open it in Texture Workbench to choose a slice");
    }

    Nifti pair = RasVolume(1, 1, 1);
    pair.magic = "ni1";
    TemporaryFile pair_file("pair.nii");
    WriteFile(pair_file.path, NiftiBytes(pair));
    EXPECT_THROW(glcm::InspectNiftiVolume(pair_file.path.string()), std::invalid_argument);

    Nifti rgb = RasVolume(1, 1, 1);
    rgb.datatype = 128;
    TemporaryFile rgb_file("rgb.nii");
    WriteFile(rgb_file.path, NiftiBytes(rgb));
    EXPECT_THROW(glcm::InspectNiftiVolume(rgb_file.path.string()), std::invalid_argument);

    std::vector<uint8_t> truncated = NiftiBytes(RasVolume(1, 1, 1));
    truncated.resize(truncated.size() - 2);
    TemporaryFile truncated_file("truncated.nii");
    WriteFile(truncated_file.path, truncated);
    EXPECT_THROW(glcm::InspectNiftiVolume(truncated_file.path.string()), std::runtime_error);

    TemporaryFile other("other.bin");
    WriteFile(other.path, std::vector<uint8_t>(400, 7));
    EXPECT_FALSE(glcm::IsNiftiFile(other.path.string()));
}

TEST(NiftiReaderTest, ReadsNifti2Headers) {
    std::vector<uint8_t> out(544, 0);
    const auto put64 = [&](size_t offset, int64_t value) { std::memcpy(out.data() + offset, &value, 8); };
    const auto put_double = [&](size_t offset, double value) { std::memcpy(out.data() + offset, &value, 8); };
    const auto put32 = [&](size_t offset, int32_t value) { std::memcpy(out.data() + offset, &value, 4); };
    put32(0, 540);
    std::memcpy(out.data() + 4, "n+2\0\r\n\032\n", 8);
    Put16(out, 12, 4);
    Put16(out, 14, 16);
    for (int64_t d : {0, 1, 2, 3}) {
        put64(16 + 8 * d, std::array<int64_t, 4>{3, 4, 3, 2}[d]);
    }
    put64(168, 544);
    put32(348, 1); // sform_code
    put_double(400, -1.5);
    put_double(440, 1.5);
    put_double(480, 2.0);
    put32(500, 2);
    const std::vector<uint8_t> data = Ramp(4, 3, 2);
    out.insert(out.end(), data.begin(), data.end());
    TemporaryFile file("nifti2.nii");
    WriteFile(file.path, out);

    const glcm::NiftiVolumeInfo info = glcm::InspectNiftiVolume(file.path.string());
    EXPECT_EQ(info.version, 2);
    EXPECT_EQ(info.axis_codes, "LAS");
    EXPECT_EQ(info.slices[0].pixel_spacing, (glcm::PixelSpacing{1.5, 1.5}));
    const glcm::LoadedImage slice = glcm::ExtractNiftiSlice(file.path.string(), SliceOrientation::Axial, 1, 0, info.storage);
    EXPECT_EQ(Pixel(slice, 0, 0), 3 + 20 + 100);
}

// ---- Storage and PNG ----

TEST(ValueConversionTest, ChoosesTheStorageFromTheRange) {
    EXPECT_EQ(glcm::ChooseStorage({0, 255, true}, true, false).bit_depth, 8);
    EXPECT_EQ(glcm::ChooseStorage({0, 256, true}, true, false).bit_depth, 16);
    EXPECT_EQ(glcm::ChooseStorage({0, 65535, true}, false, false).kind, StorageKind::Identity);
    EXPECT_EQ(glcm::ChooseStorage({-1024, 3071, true}, false, false).kind, StorageKind::Offset);
    EXPECT_EQ(glcm::ChooseStorage({-3024, 3071, true}, false, false).kind, StorageKind::Linear);
    EXPECT_EQ(glcm::ChooseStorage({-3024, 3071, true}, false, true).kind, StorageKind::Offset);
    EXPECT_EQ(glcm::ChooseStorage({-1, 64512, true}, false, true).kind, StorageKind::Linear);
    EXPECT_EQ(glcm::ChooseStorage({0, 1, false}, false, false).kind, StorageKind::Linear);

    const glcm::StorageChoice constant = glcm::ChooseStorage({2.5, 2.5, false}, false, false);
    EXPECT_EQ(glcm::StoredSample(2.5, constant), 0);
    EXPECT_EQ(glcm::StoredSample(std::nan(""), constant), 0);

    EXPECT_EQ(glcm::ConversionFormula(1, -1024, "HU"), "HU = stored value - 1024");
    EXPECT_EQ(glcm::ConversionFormula(-1, 4095, ""), "value = 4095 - stored value");
    EXPECT_EQ(glcm::ConversionFormula(0.5, 3, ""), "value = stored value × 0.5 + 3");
}

TEST(PngEncoderTest, WritesThePixelSpacing) {
    cv::Mat gray(3, 5, CV_16UC1);
    cv::randu(gray, 0, 65535);
    const std::vector<uchar> png = glcm::EncodePng(gray, glcm::PixelSpacing{0.5, 0.25});
    const auto size = glcm::ReadImageSizeFromBytes(png);
    ASSERT_TRUE(size && size->pixel_spacing);
    EXPECT_DOUBLE_EQ(size->pixel_spacing->x_mm, 0.5);
    EXPECT_DOUBLE_EQ(size->pixel_spacing->y_mm, 0.25);
    const glcm::LoadedImage decoded = glcm::LoadImageBytes(png);
    EXPECT_EQ(cv::countNonZero(decoded.gray != gray), 0);
    EXPECT_FALSE(glcm::ReadImageSizeFromBytes(glcm::EncodePng(gray, std::nullopt))->pixel_spacing.has_value());
}

} // namespace

TEST(NiftiReaderTest, ExtractsAStackEqualToItsSlices) {
    // Oblique permutation with flips, two volumes
    Nifti nifti;
    nifti.dim = {4, 4, 3, 2, 2};
    nifti.sform_code = 1;
    nifti.srow = {{{0, -1, 0, 0}, {0, 0, 1, 0}, {-1, 0, 0, 0}}};
    nifti.data = Ramp(4, 3, 2, 2);
    TemporaryFile file("stack.nii");
    WriteFile(file.path, NiftiBytes(nifti));
    const glcm::NiftiVolumeInfo info = glcm::InspectNiftiVolume(file.path.string());
    for (auto orientation : {SliceOrientation::Axial, SliceOrientation::Coronal, SliceOrientation::Sagittal}) {
        const glcm::LoadedStack stack = glcm::ExtractNiftiStack(file.path.string(), orientation, 1, info.storage);
        const auto& geometry = info.slices[static_cast<size_t>(orientation)];
        ASSERT_EQ(stack.slices, geometry.count);
        for (int slice = 0; slice < stack.slices; ++slice) {
            const glcm::LoadedImage expected = glcm::ExtractNiftiSlice(file.path.string(), orientation, slice, 1, info.storage);
            EXPECT_EQ(cv::norm(stack.Slice(slice), expected.gray, cv::NORM_INF), 0)
                << glcm::SliceOrientationId(orientation) << " " << slice;
            EXPECT_EQ(stack.info.pixel_spacing.has_value(), expected.info.pixel_spacing.has_value());
        }
    }
    EXPECT_THROW(glcm::ExtractNiftiStack(file.path.string(), SliceOrientation::Axial, 2, info.storage), std::invalid_argument);
    EXPECT_THROW(glcm::ExtractNiftiStack(file.path.string(), SliceOrientation::Axial, 0, info.storage, 0, 5), glcm::StackTooLargeError);
}
