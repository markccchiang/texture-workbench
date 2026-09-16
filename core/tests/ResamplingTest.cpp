#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <fstream>
#include <functional>
#include <nlohmann/json.hpp>
#include <opencv2/core.hpp>
#include <stdexcept>
#include <string>
#include <vector>

#include "imaging/ImageLoader.hpp"
#include "imaging/Resampling.hpp"
#include "io/Json.hpp"
#include "io/ResultsCsv.hpp"
#include "pipeline/AnalysisRunner.hpp"
#include "roi/Roi.hpp"

using namespace glcm;

TEST(ResamplingTest, MatchesSimpleItkBSplineResampling) {
    // Written by scripts/radiomics-reference.py: SimpleITK's sitkBSpline on PyRadiomics' grid, real-valued
    std::ifstream stream(GLCM_SOURCE_DIR "/core/tests/data/simpleitk-resampling.json");
    ASSERT_TRUE(stream) << "missing core/tests/data/simpleitk-resampling.json";
    const nlohmann::json document = nlohmann::json::parse(stream);
    ASSERT_EQ(document.at("cases").size(), 5u);

    for (const nlohmann::json& reference : document.at("cases")) {
        const std::string image_path = reference.at("image");
        SCOPED_TRACE(image_path + " from " + reference.at("from").dump() + " to " + reference.at("to").dump());
        const LoadedImage image = LoadImageFile(GLCM_SOURCE_DIR "/samples/" + image_path);
        const auto& crop = reference.at("crop");
        const cv::Mat gray = image.gray(cv::Rect(crop.at(0), crop.at(1), crop.at(2), crop.at(3))).clone();
        const PixelSpacing from{reference.at("from").at(0), reference.at("from").at(1)};
        const PixelSpacing to{reference.at("to").at(0), reference.at("to").at(1)};

        const cv::Mat values = ResampleValues(gray, from, to);
        ASSERT_EQ(values.cols, reference.at("size").at(0).get<int>());
        ASSERT_EQ(values.rows, reference.at("size").at(1).get<int>());
        const auto& expected = reference.at("values");
        for (int row = 0; row < values.rows; ++row) {
            for (int col = 0; col < values.cols; ++col) {
                const double want = expected.at(static_cast<size_t>(row) * values.cols + col);
                ASSERT_NEAR(values.at<double>(row, col), want, 1e-9 * std::max(1.0, std::abs(want))) << "pixel " << col << ", " << row;
            }
        }

        // The image keeps its depth, with every value rounded and clamped
        const cv::Mat rounded = ResampleImage(gray, from, to);
        ASSERT_EQ(rounded.type(), gray.type());
        const double maximum = gray.depth() == CV_16U ? 65535.0 : 255.0;
        for (int row = 0; row < values.rows; ++row) {
            for (int col = 0; col < values.cols; ++col) {
                const double stored = gray.depth() == CV_16U ? rounded.at<uint16_t>(row, col) : rounded.at<uchar>(row, col);
                ASSERT_EQ(stored, std::clamp(std::round(values.at<double>(row, col)), 0.0, maximum)) << "pixel " << col << ", " << row;
            }
        }
    }
}

TEST(ResamplingTest, GridsAndCoefficients) {
    // PyRadiomics' size: ceil(size * old / new)
    EXPECT_EQ(ResampledGrid({100, 60}, {1, 1}, {0.7, 1.3}).size, cv::Size(143, 47));
    EXPECT_EQ(ResampledGrid({100, 60}, {0.5, 0.8}, {0.5, 0.5}).size, cv::Size(100, 96));
    EXPECT_DOUBLE_EQ(ResampledGrid({100, 60}, {0.5, 0.8}, {0.5, 0.5}).ratio_y, 0.625);
    EXPECT_THROW(ResampledGrid({100, 60}, {0, 1}, {1, 1}), std::invalid_argument);
    EXPECT_THROW(ResampledGrid({100, 60}, {1, 1}, {1, NAN}), std::invalid_argument);
    EXPECT_THROW(ResampledGrid({20000, 20000}, {1, 1}, {0.01, 0.01}), std::invalid_argument);

    // A constant image stays constant, except for new pixels whose centres lie beyond the last half pixel, which ITK sets to 0:
    // 7 columns at 0.4 give 18, and the centre of the last lies at 17.5 * 0.4 = 7 pixels, beyond 6.5
    const cv::Mat flat(9, 7, CV_8UC1, cv::Scalar(123));
    const cv::Mat resampled = ResampleImage(flat, {1, 1}, {0.4, 0.9});
    ASSERT_EQ(resampled.size(), cv::Size(18, 10));
    EXPECT_EQ(cv::countNonZero(resampled(cv::Rect(0, 0, 17, 10)) != 123), 0);
    EXPECT_EQ(cv::countNonZero(resampled.col(17)), 0);
    cv::Mat ramp(12, 10, CV_16UC1);
    for (int row = 0; row < ramp.rows; ++row) {
        for (int col = 0; col < ramp.cols; ++col) {
            ramp.at<uint16_t>(row, col) = static_cast<uint16_t>(1000 + 37 * col + 101 * row + (row * col) % 7);
        }
    }
    EXPECT_EQ(cv::norm(ResampleImage(ramp, {0.6, 0.6}, {0.6, 0.6}), ramp, cv::NORM_INF), 0.0);

    // A region returns only its part of the grid, with the same values
    const cv::Mat whole = ResampleValues(ramp, {1, 1}, {0.7, 0.4});
    const cv::Rect region(3, 5, 6, 9);
    EXPECT_EQ(cv::norm(ResampleValues(ramp, {1, 1}, {0.7, 0.4}, region), whole(region), cv::NORM_INF), 0.0);
    EXPECT_EQ(ResampleImage(ramp, {1, 1}, {0.7, 0.4}, cv::Rect(10, 25, 50, 50)).size(), cv::Size(5, 5));
    EXPECT_THROW(ResampleImage(cv::Mat(5, 5, CV_32FC1), {1, 1}, {1, 1}), std::invalid_argument);
}

TEST(ResamplingTest, ShapesKeepTheirRegionOnTheNewGrid) {
    const cv::Size size(80, 60);
    const ResamplingGrid grid = ResampledGrid(size, {0.5, 0.8}, {0.45, 0.45});
    // A new pixel is inside when its centre, in original pixel units, lies inside the original shape
    const auto reference = [&grid](const std::function<bool(double, double)>& inside) {
        cv::Mat mask = cv::Mat::zeros(grid.size, CV_8UC1);
        for (int l = 0; l < grid.size.height; ++l) {
            for (int k = 0; k < grid.size.width; ++k) {
                if (inside((k + 0.5) * grid.ratio_x, (l + 0.5) * grid.ratio_y)) {
                    mask.at<uchar>(l, k) = 255;
                }
            }
        }
        return mask;
    };
    const auto ellipse = [](double cx, double cy, double rx, double ry, double angle) {
        return [=](double x, double y) {
            const double t = angle * CV_PI / 180.0;
            const double u = (x - cx) * std::cos(t) + (y - cy) * std::sin(t);
            const double v = -(x - cx) * std::sin(t) + (y - cy) * std::cos(t);
            return u * u / (rx * rx) + v * v / (ry * ry) <= 1.0;
        };
    };
    const auto differences = [&grid](const RoiShape& shape, const cv::Mat& expected) {
        return cv::countNonZero(RasterizeMask(ResampleShape(shape, grid), grid.size) != expected);
    };

    EXPECT_EQ(differences(RectangleRoi{10.2, 7.5, 30.3, 20},
                  reference([](double x, double y) { return x >= 10.2 && x < 40.5 && y >= 7.5 && y < 27.5; })),
        0);
    EXPECT_EQ(differences(EllipseRoi{40, 30, 20, 9, 0}, reference(ellipse(40, 30, 20, 9, 0))), 0);
    // Rotated ellipses become ellipses of other axes and angles on the new grid
    EXPECT_EQ(differences(EllipseRoi{40.3, 29.1, 22, 8, 35}, reference(ellipse(40.3, 29.1, 22, 8, 35))), 0);
    EXPECT_EQ(differences(EllipseRoi{30, 25, 15, 6, 90}, reference(ellipse(30, 25, 15, 6, 90))), 0);
    // A triangle, tested with the signs of the cross products in original pixel units
    const auto inside_triangle = [](double x, double y) {
        const std::array<std::array<double, 2>, 3> p = {{{5, 5}, {60, 12}, {20, 50}}};
        int positive = 0;
        for (size_t i = 0; i < 3; ++i) {
            const auto& a = p[i];
            const auto& b = p[(i + 1) % 3];
            positive += (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) > 0 ? 1 : 0;
        }
        return positive == 3 || positive == 0;
    };
    EXPECT_EQ(differences(PolygonRoi{{{5, 5}, {60, 12}, {20, 50}}}, reference(inside_triangle)), 0);
}

TEST(ResamplingTest, RoisReachingPastTheImageMeasureOnlyPixelsOnIt) {
    // 10 mm of image on a 3 mm grid: 4 new pixels per side, of which the last lies beyond the image (centre at 10.5 mm)
    cv::Mat gray(10, 10, CV_8UC1, cv::Scalar(100));
    const ResamplingGrid grid = ResampledGrid(gray.size(), {1, 1}, {3, 3});
    EXPECT_EQ(grid.size, cv::Size(4, 4));
    EXPECT_EQ(ResampledValidSize(grid, gray.size()), cv::Size(3, 3));
    EXPECT_EQ(ResampledValidSize(ResampledGrid(gray.size(), {1, 1}, {0.5, 0.5}), gray.size()), cv::Size(20, 20));

    AnalysisSettings settings = DefaultSettings(8);
    settings.features = {Type::Mean, Type::Contrast};
    settings.resampling = PixelSpacing{3, 3};
    const std::vector<Roi> rois = {Roi{"r", "Past the edge", "", RectangleRoi{0, 0, 12, 12}, ""}};
    AnalysisOutput output = RunAnalysis(gray, rois, settings, nullptr, PixelSpacing{1, 1});
    ASSERT_EQ(output.results[0].status, MeasurementStatus::Ok) << output.results[0].error;
    EXPECT_EQ(output.results[0].pixel_count, 9);
    EXPECT_EQ(output.results[0].values.at(Type::Mean).Avg(), 100);

    // Also when a filter sees the whole grid
    settings.filter = ImageFilterSettings{ImageFilterType::Wavelet};
    settings.filter->band = WaveletBand::LL;
    settings.quantization.method = QuantizationMethod::RoiMinMax;
    output = RunAnalysis(gray, rois, settings, nullptr, PixelSpacing{1, 1});
    ASSERT_EQ(output.results[0].status, MeasurementStatus::Ok) << output.results[0].error;
    EXPECT_EQ(output.results[0].pixel_count, 9);
}

TEST(ResamplingTest, RunAnalysisMeasuresTheResampledImageAndRecordsTheSetting) {
    cv::Mat gray(60, 80, CV_8UC1);
    cv::randu(gray, 0, 256);
    AnalysisSettings settings = DefaultSettings(8);
    settings.features = {Type::Contrast, Type::Mean, Type::ShapePixelSurface};
    settings.distances = {1, 2};
    const std::vector<Roi> rois = {Roi{"r", "Region", "", EllipseRoi{40, 30, 25, 15, 20}, ""}};
    const PixelSpacing spacing{0.5, 0.8};

    AnalysisSettings resampled = settings;
    resampled.resampling = PixelSpacing{0.5, 0.5};
    const AnalysisOutput output = RunAnalysis(gray, rois, resampled, nullptr, spacing);

    // The same as measuring the resampled image and ROI directly, with the new spacing
    const ResamplingGrid grid = ResampledGrid(gray.size(), spacing, *resampled.resampling);
    std::vector<Roi> moved = rois;
    moved[0].shape = ResampleShape(rois[0].shape, grid);
    const AnalysisOutput direct =
        RunAnalysis(ResampleImage(gray, spacing, *resampled.resampling), moved, settings, nullptr, resampled.resampling);
    ASSERT_EQ(output.results.size(), 2u);
    for (size_t i = 0; i < output.results.size(); ++i) {
        EXPECT_EQ(output.results[i].pixel_count, direct.results[i].pixel_count);
        EXPECT_EQ(output.results[i].values.at(Type::Contrast).Avg(), direct.results[i].values.at(Type::Contrast).Avg());
        EXPECT_DOUBLE_EQ(output.results[i].values.at(Type::ShapePixelSurface).Avg(), output.results[i].pixel_count * 0.25);
    }
    // More pixels than without resampling: 0.8 mm rows became 0.5 mm rows
    const AnalysisOutput plain = RunAnalysis(gray, rois, settings, nullptr, spacing);
    EXPECT_GT(output.results[0].pixel_count, plain.results[0].pixel_count);

    // Settings documents and CSV files record it, and read it back
    const std::string json = SettingsToJson(resampled);
    EXPECT_EQ(nlohmann::json::parse(json).at("resampling"), nlohmann::json::parse(R"({"x": 0.5, "y": 0.5})")) << json;
    EXPECT_EQ(SettingsToJson(SettingsFromJson(json)), json);
    EXPECT_EQ(SettingsToJson(settings).find("resampling"), std::string::npos);
    ExportContext context;
    context.pixel_spacing = spacing;
    const std::string csv = ResultsToCsv(output.results, resampled, context);
    EXPECT_NE(csv.find("# resampledPixelSpacingMm=0.5;0.5\n"), std::string::npos);

    EXPECT_THROW(RunAnalysis(gray, rois, resampled), std::invalid_argument) << "no pixel spacing";
    resampled.resampling = PixelSpacing{0, 1};
    EXPECT_THROW(ValidateSettings(resampled), std::invalid_argument);
}
