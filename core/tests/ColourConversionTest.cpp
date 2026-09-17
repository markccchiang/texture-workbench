#include <gtest/gtest.h>

#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <nlohmann/json.hpp>
#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <string>
#include <vector>

#include "imaging/ColourConversion.hpp"
#include "imaging/ImageLoader.hpp"

using namespace glcm;

namespace {

// SHA-256 (FIPS 180-4) of a byte string, as hexadecimal text
std::string Sha256(const std::vector<uint8_t>& input) {
    static const std::array<uint32_t, 64> K = {0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
        0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3,
        0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c,
        0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb,
        0xbef9a3f7, 0xc67178f2};
    std::array<uint32_t, 8> h = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    std::vector<uint8_t> message = input;
    const uint64_t bits = static_cast<uint64_t>(input.size()) * 8;
    message.push_back(0x80);
    while (message.size() % 64 != 56) {
        message.push_back(0);
    }
    for (int i = 7; i >= 0; --i) {
        message.push_back(static_cast<uint8_t>(bits >> (8 * i)));
    }
    const auto rotate = [](uint32_t value, int count) { return (value >> count) | (value << (32 - count)); };
    for (size_t block = 0; block < message.size(); block += 64) {
        std::array<uint32_t, 64> w{};
        for (size_t t = 0; t < 16; ++t) {
            w[t] = static_cast<uint32_t>(message[block + 4 * t]) << 24 | static_cast<uint32_t>(message[block + 4 * t + 1]) << 16 |
                   static_cast<uint32_t>(message[block + 4 * t + 2]) << 8 | message[block + 4 * t + 3];
        }
        for (size_t t = 16; t < 64; ++t) {
            w[t] = w[t - 16] + (rotate(w[t - 15], 7) ^ rotate(w[t - 15], 18) ^ (w[t - 15] >> 3)) + w[t - 7] +
                   (rotate(w[t - 2], 17) ^ rotate(w[t - 2], 19) ^ (w[t - 2] >> 10));
        }
        std::array<uint32_t, 8> v = h;
        for (size_t t = 0; t < 64; ++t) {
            const uint32_t t1 =
                v[7] + (rotate(v[4], 6) ^ rotate(v[4], 11) ^ rotate(v[4], 25)) + ((v[4] & v[5]) ^ (~v[4] & v[6])) + K[t] + w[t];
            const uint32_t t2 = (rotate(v[0], 2) ^ rotate(v[0], 13) ^ rotate(v[0], 22)) + ((v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]));
            v = {t1 + t2, v[0], v[1], v[2], v[3] + t1, v[4], v[5], v[6]};
        }
        for (size_t i = 0; i < 8; ++i) {
            h[i] += v[i];
        }
    }
    std::string text;
    for (uint32_t word : h) {
        char hex[9];
        std::snprintf(hex, sizeof(hex), "%08x", word);
        text += hex;
    }
    return text;
}

std::string Sha256(const cv::Mat& gray) {
    const cv::Mat continuous = gray.clone();
    return Sha256(std::vector<uint8_t>(continuous.data, continuous.data + continuous.total() * continuous.elemSize()));
}

// The test image of scripts/imagej-colour: pixel (x, y) is R = x, G = y, B = (7x + 13y) mod 256, in OpenCV's BGR order
cv::Mat SyntheticBgr() {
    cv::Mat bgr(256, 256, CV_8UC3);
    for (int y = 0; y < 256; ++y) {
        for (int x = 0; x < 256; ++x) {
            bgr.at<cv::Vec3b>(y, x) = cv::Vec3b(static_cast<uchar>((7 * x + 13 * y) % 256), static_cast<uchar>(y), static_cast<uchar>(x));
        }
    }
    return bgr;
}

nlohmann::json ReadJson(const std::string& name) {
    std::ifstream stream(std::string(GLCM_SOURCE_DIR "/core/tests/data/") + name);
    EXPECT_TRUE(stream) << "missing core/tests/data/" << name;
    return nlohmann::json::parse(stream);
}

} // namespace

TEST(ColourConversionTest, Sha256OfKnownInputs) {
    EXPECT_EQ(Sha256(std::vector<uint8_t>{}), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    EXPECT_EQ(Sha256(std::vector<uint8_t>{'a', 'b', 'c'}), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
}

TEST(ColourConversionTest, MeanAndHsbMatchImageJ) {
    // Written by scripts/imagej-colour/ImageJColourReference.java with ImageJ 1.54p
    const nlohmann::json reference = ReadJson("imagej-colour.json");
    const cv::Mat bgr = SyntheticBgr();
    for (const auto& [id, conversion] : {std::pair{"mean", ColourConversion::Mean}, std::pair{"hue", ColourConversion::Hue},
             std::pair{"saturation", ColourConversion::Saturation}, std::pair{"brightness", ColourConversion::Brightness}}) {
        SCOPED_TRACE(id);
        const ConvertedColour converted = ConvertColour(bgr, conversion);
        ASSERT_EQ(converted.gray.type(), CV_8UC1);
        EXPECT_EQ(Sha256(converted.gray), reference.at(id).get<std::string>());
        ASSERT_TRUE(converted.value_conversion.has_value());
        EXPECT_EQ(converted.value_conversion->scale, 1);
        EXPECT_EQ(converted.value_conversion->offset, 0);
    }
}

TEST(ColourConversionTest, ChannelsAndLuminance) {
    const cv::Mat bgr = SyntheticBgr();
    std::vector<cv::Mat> channels;
    cv::split(bgr, channels);
    EXPECT_EQ(cv::norm(ConvertColour(bgr, ColourConversion::Red).gray, channels[2], cv::NORM_INF), 0);
    EXPECT_EQ(cv::norm(ConvertColour(bgr, ColourConversion::Green).gray, channels[1], cv::NORM_INF), 0);
    EXPECT_EQ(cv::norm(ConvertColour(bgr, ColourConversion::Blue).gray, channels[0], cv::NORM_INF), 0);
    EXPECT_EQ(ConvertColour(bgr, ColourConversion::Red).value_conversion->description, "Red channel; value = stored value");

    // The luminance is the conversion images always had, without a value conversion
    cv::Mat gray;
    cv::cvtColor(bgr, gray, cv::COLOR_BGR2GRAY);
    const ConvertedColour luminance = ConvertColour(bgr, ColourConversion::Luminance);
    EXPECT_EQ(cv::norm(luminance.gray, gray, cv::NORM_INF), 0);
    EXPECT_FALSE(luminance.value_conversion.has_value());
    EXPECT_EQ(luminance.warning, "Color image converted to grayscale");
}

TEST(ColourConversionTest, SixteenBitImagesKeepTheirDepth) {
    // 16-bit samples are the 8-bit ones × 257: channels, mean and HSB scale the same way (to within truncation for HSB)
    const cv::Mat bgr8 = SyntheticBgr();
    cv::Mat bgr16;
    bgr8.convertTo(bgr16, CV_16UC3, 257);
    for (ColourConversion conversion : {ColourConversion::Red, ColourConversion::Mean, ColourConversion::Hue, ColourConversion::Saturation,
             ColourConversion::Brightness}) {
        SCOPED_TRACE(ColourConversionId(conversion));
        const cv::Mat gray16 = ConvertColour(bgr16, conversion).gray;
        ASSERT_EQ(gray16.type(), CV_16UC1);
        cv::Mat expected;
        ConvertColour(bgr8, conversion).gray.convertTo(expected, CV_32F, 257);
        cv::Mat actual;
        gray16.convertTo(actual, CV_32F);
        EXPECT_LE(cv::norm(actual, expected, cv::NORM_INF), 257);
    }
}

TEST(ColourConversionTest, StainsMatchScikitImage) {
    // Written by scripts/radiomics-reference.py: separate_stains with hed_from_rgb and hdx_from_rgb
    const nlohmann::json reference = ReadJson("scikit-image-stains.json");
    for (const nlohmann::json& reference_case : reference.at("cases")) {
        const std::string name = reference_case.at("image");
        SCOPED_TRACE(name);
        const cv::Mat bgr = name == "synthetic" ? SyntheticBgr() : cv::imread(GLCM_SOURCE_DIR "/samples/" + name, cv::IMREAD_COLOR);
        ASSERT_FALSE(bgr.empty());
        const int step = reference_case.at("step");
        for (ColourConversion conversion :
            {ColourConversion::HematoxylinHe, ColourConversion::EosinHe, ColourConversion::HematoxylinHdab, ColourConversion::DabHdab}) {
            const std::string id = ColourConversionId(conversion);
            SCOPED_TRACE(id);
            const ConvertedColour converted = ConvertColour(bgr, conversion);
            ASSERT_EQ(converted.gray.type(), CV_16UC1);
            ASSERT_TRUE(converted.value_conversion.has_value());
            const double scale = converted.value_conversion->scale;
            EXPECT_EQ(converted.value_conversion->unit, "OD");
            const std::vector<double> expected = reference_case.at(id);
            size_t index = 0;
            size_t nonzero = 0;
            for (int y = 0; y < bgr.rows; y += step) {
                for (int x = 0; x < bgr.cols; x += step, ++index) {
                    ASSERT_LT(index, expected.size());
                    const double value = converted.gray.at<uint16_t>(y, x) * scale;
                    // Stored as round(density / scale): within half a step of scikit-image's float value
                    ASSERT_LE(std::abs(value - expected[index]), scale * 0.5 * (1 + 1e-9)) << "at " << x << ", " << y;
                    nonzero += expected[index] > 0 ? 1 : 0;
                }
            }
            EXPECT_EQ(index, expected.size());
            if (name == "synthetic") {
                EXPECT_GT(nonzero, 0u);
            }
        }
    }
}

TEST(ColourConversionTest, LoadersApplyTheConversion) {
    const LoadedImage red = LoadImageFile(GLCM_SOURCE_DIR "/samples/textures/ihc.png", 0, ColourConversion::Red);
    const cv::Mat bgr = cv::imread(GLCM_SOURCE_DIR "/samples/textures/ihc.png", cv::IMREAD_COLOR);
    std::vector<cv::Mat> channels;
    cv::split(bgr, channels);
    EXPECT_EQ(cv::norm(red.gray, channels[2], cv::NORM_INF), 0);
    EXPECT_EQ(red.info.source_channels, 3);
    ASSERT_TRUE(red.info.value_conversion.has_value());
    EXPECT_EQ(red.warnings, std::vector<std::string>{"Colour image converted: Red channel"});

    const LoadedImage dab = LoadImageFile(GLCM_SOURCE_DIR "/samples/textures/ihc.png", 0, ColourConversion::DabHdab);
    EXPECT_EQ(dab.info.bit_depth, 16);
    EXPECT_EQ(dab.info.value_conversion->unit, "OD");

    // A grayscale image has nothing to convert
    const LoadedImage camera = LoadImageFile(GLCM_SOURCE_DIR "/samples/textures/camera.png", 0, ColourConversion::DabHdab);
    EXPECT_EQ(camera.info.bit_depth, 8);
    EXPECT_FALSE(camera.info.value_conversion.has_value());
}

TEST(ColourConversionTest, IdsRoundTrip) {
    for (const char* id : {"luminance", "mean", "red", "green", "blue", "hue", "saturation", "brightness", "hematoxylinHe", "eosinHe",
             "hematoxylinHdab", "dabHdab"}) {
        const auto conversion = ColourConversionFromId(id);
        ASSERT_TRUE(conversion.has_value()) << id;
        EXPECT_STREQ(ColourConversionId(*conversion), id);
    }
    EXPECT_FALSE(ColourConversionFromId("gray").has_value());
    EXPECT_THROW(ConvertColour(cv::Mat(2, 2, CV_8UC1), ColourConversion::Red), std::invalid_argument);
}
