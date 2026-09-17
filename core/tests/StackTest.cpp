#include <gtest/gtest.h>
#include <unistd.h>

#include <filesystem>
#include <fstream>
#include <nlohmann/json.hpp>
#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>
#include <string>
#include <vector>

#include "imaging/ImageLoader.hpp"
#include "io/Json.hpp"
#include "io/ResultsCsv.hpp"
#include "pipeline/AnalysisRunner.hpp"

using namespace glcm;

namespace {

namespace fs = std::filesystem;

struct TemporaryFile {
    explicit TemporaryFile(const std::string& name)
        : path(fs::temp_directory_path() / ("glcm_stack_" + std::to_string(getpid()) + "_" + name)) {}
    ~TemporaryFile() {
        std::error_code ignored;
        fs::remove(path, ignored);
    }
    fs::path path;
};

LoadedStack RandomStack(int width, int height, int slices, int type) {
    LoadedStack stack;
    stack.slices = slices;
    stack.info.width = width;
    stack.info.height = height;
    stack.info.bit_depth = type == CV_16UC1 ? 16 : 8;
    stack.pixels = cv::Mat(height * slices, width, type);
    cv::randu(stack.pixels, 0, type == CV_16UC1 ? 65536 : 256);
    return stack;
}

void Write(const fs::path& path, const std::vector<uchar>& bytes) {
    std::ofstream out(path, std::ios::binary);
    out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
}

} // namespace

TEST(StackTest, TiffStacksReadBackWithTheSameSamplesAndSpacing) {
    for (int type : {CV_8UC1, CV_16UC1}) {
        LoadedStack stack = RandomStack(7, 5, 4, type);
        stack.info.pixel_spacing = PixelSpacing{0.703125, 1.25};
        TemporaryFile file(type == CV_8UC1 ? "eight.tif" : "sixteen.tif");
        Write(file.path, EncodeTiffStack(stack));

        const LoadedStack read = LoadImageStackFile(file.path.string());
        ASSERT_EQ(read.slices, 4);
        ASSERT_EQ(read.pixels.type(), type);
        EXPECT_EQ(cv::norm(read.pixels, stack.pixels, cv::NORM_INF), 0);
        ASSERT_TRUE(read.info.pixel_spacing.has_value());
        EXPECT_NEAR(read.info.pixel_spacing->x_mm, 0.703125, 1e-12);
        EXPECT_NEAR(read.info.pixel_spacing->y_mm, 1.25, 1e-12);
        EXPECT_TRUE(read.warnings.empty());

        // As a single image: the first page, with a warning
        const LoadedImage first = LoadImageFile(file.path.string());
        EXPECT_EQ(cv::norm(first.gray, stack.Slice(0), cv::NORM_INF), 0);
        EXPECT_EQ(first.warnings, std::vector<std::string>{"The TIFF file contains more than one image; only the first is used"});

        EXPECT_THROW(LoadImageStackFile(file.path.string(), 0, 7 * 5 * 4 - 1), StackTooLargeError);
        EXPECT_NO_THROW(LoadImageStackFile(file.path.string(), 35, 7 * 5 * 4));
        EXPECT_THROW(LoadImageStackFile(file.path.string(), 34), ImageTooLargeError);
    }
}

TEST(StackTest, ADescriptionMakesTheTiffDifferentButNotItsSamples) {
    for (const std::string description : {"odd", "even", "glcm colour conversion: red"}) {
        for (bool spacing : {false, true}) {
            LoadedStack stack = RandomStack(5, 3, 2, CV_16UC1);
            if (spacing) {
                stack.info.pixel_spacing = PixelSpacing{0.5, 0.25};
            }
            const std::vector<uchar> plain = EncodeTiffStack(stack);
            const std::vector<uchar> described = EncodeTiffStack(stack, description);
            EXPECT_NE(plain, described);
            TemporaryFile file("described.tif");
            Write(file.path, described);
            const LoadedStack read = LoadImageStackFile(file.path.string());
            ASSERT_EQ(read.slices, 2);
            EXPECT_EQ(cv::norm(read.pixels, stack.pixels, cv::NORM_INF), 0);
            EXPECT_EQ(read.info.pixel_spacing.has_value(), spacing);
            const std::string text(described.begin(), described.end());
            EXPECT_NE(text.find(description + std::string(1, '\0')), std::string::npos);
        }
    }
    EXPECT_THROW(EncodeTiffStack(RandomStack(2, 2, 1, CV_8UC1), std::string("a\0b", 3)), std::invalid_argument);
}

TEST(StackTest, TiffPagesOfAnotherSizeEndTheStack) {
    cv::Mat a(4, 6, CV_16UC1, cv::Scalar(100));
    cv::Mat b(4, 6, CV_16UC1, cv::Scalar(200));
    cv::Mat c(5, 6, CV_16UC1, cv::Scalar(300));
    TemporaryFile file("mixed.tif");
    ASSERT_TRUE(cv::imwrite(file.path.string(), std::vector<cv::Mat>{a, b, c}));
    const LoadedStack stack = LoadImageStackFile(file.path.string());
    ASSERT_EQ(stack.slices, 2);
    EXPECT_EQ(stack.Slice(1).at<uint16_t>(3, 5), 200);
    EXPECT_EQ(stack.warnings,
        std::vector<std::string>{"Page 3 of the TIFF file differs in size or type from the first; only the first 2 pages are used"});
}

TEST(StackTest, SingleImagesAreStacksOfOneSlice) {
    cv::Mat image(3, 4, CV_8UC1, cv::Scalar(9));
    TemporaryFile file("single.png");
    ASSERT_TRUE(cv::imwrite(file.path.string(), image));
    const LoadedStack stack = LoadImageStackFile(file.path.string());
    EXPECT_EQ(stack.slices, 1);
    EXPECT_EQ(stack.pixels.size(), cv::Size(4, 3));
    EXPECT_THROW(LoadImageStackFile(file.path.string(), 0, 11), StackTooLargeError);
}

TEST(StackTest, SlicesOfRoisAreCarriedIntoResultsAndFilesOnlyWhenSet) {
    const std::vector<Roi> plain = {Roi{"a", "A", "#FF0000", RectangleRoi{0, 0, 4, 4}, ""}};
    std::vector<Roi> sliced = plain;
    sliced[0].slice = 3;
    RoiSetDocument plain_set;
    plain_set.rois = plain;
    RoiSetDocument sliced_set;
    sliced_set.rois = sliced;
    EXPECT_FALSE(nlohmann::json::parse(RoiSetToJson(plain_set)).at("rois").at(0).contains("slice"));
    nlohmann::json document = nlohmann::json::parse(RoiSetToJson(sliced_set));
    EXPECT_EQ(document.at("rois").at(0).at("slice"), 3);
    EXPECT_EQ(RoiSetFromJson(document.dump()).rois[0].slice, 3);
    document["rois"][0]["slice"] = 0;
    EXPECT_THROW(RoiSetFromJson(document.dump()), std::invalid_argument);

    cv::Mat gray(8, 8, CV_8UC1);
    cv::randu(gray, 0, 256);
    AnalysisSettings settings = DefaultSettings(8);
    settings.features = {Type::Contrast};
    const AnalysisOutput output = RunAnalysis(gray, sliced, settings);
    ASSERT_EQ(output.results[0].slice, 3);
    const std::string json = ResultsToJson(output.results, settings, ExportContext{});
    EXPECT_EQ(nlohmann::json::parse(json).at("results").at(0).at("slice"), 3);
    EXPECT_EQ(ResultsToJson(ResultsFromJson(json).results, settings, ExportContext{}), json);
    const std::string csv = ResultsToCsv(output.results, settings, ExportContext{});
    EXPECT_NE(csv.find(",roiId,slice,status,"), std::string::npos);
    EXPECT_EQ(ResultsToCsv(RunAnalysis(gray, plain, settings).results, settings, ExportContext{}).find("slice"), std::string::npos);
}
