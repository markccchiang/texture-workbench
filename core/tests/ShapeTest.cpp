#include <gtest/gtest.h>

#include <cmath>
#include <fstream>
#include <nlohmann/json.hpp>
#include <opencv2/core.hpp>
#include <set>
#include <stdexcept>
#include <string>

#include "analysis/Shape.hpp"
#include "imaging/ImageHeader.hpp"
#include "pipeline/AnalysisRunner.hpp"
#include "pipeline/FeatureCatalog.hpp"

using namespace glcm;

namespace {

const std::set<Type> ALL_SHAPE = {Type::ShapeMeshSurface, Type::ShapePixelSurface, Type::ShapePerimeter, Type::ShapePerimeterSurfaceRatio,
    Type::ShapeSphericity, Type::ShapeMaximumDiameter, Type::ShapeMajorAxisLength, Type::ShapeMinorAxisLength, Type::ShapeElongation};

} // namespace

TEST(ShapeTest, MatchesPyRadiomicsOnMasksAndSpacings) {
    // Written by scripts/radiomics-reference.py: PyRadiomics shape2D on masks given as runs, at pixel spacings (x, y)
    std::ifstream stream(GLCM_SOURCE_DIR "/core/tests/data/pyradiomics-shape2d.json");
    ASSERT_TRUE(stream) << "missing core/tests/data/pyradiomics-shape2d.json";
    const nlohmann::json document = nlohmann::json::parse(stream);
    ASSERT_GE(document.at("cases").size(), 21u);

    for (const nlohmann::json& reference : document.at("cases")) {
        const cv::Point2d spacing(reference.at("spacing").at(0), reference.at("spacing").at(1));
        SCOPED_TRACE(reference.at("name").get<std::string>() + " at " + std::to_string(spacing.x) + " x " + std::to_string(spacing.y));
        cv::Mat mask = cv::Mat::zeros(reference.at("height"), reference.at("width"), CV_8UC1);
        for (const nlohmann::json& run : reference.at("runs")) {
            mask.row(run.at(0)).colRange(run.at(1), run.at(2)).setTo(255);
        }
        const auto values = ComputeShapeFeatures(mask, spacing, ALL_SHAPE);
        ASSERT_EQ(reference.at("features").size(), ALL_SHAPE.size());
        for (const auto& [name, value] : reference.at("features").items()) {
            const double expected = value.get<double>();
            const std::optional<Type> type = FeatureTypeFromId("Shape" + name);
            ASSERT_TRUE(type.has_value()) << name;
            // The mesh (surface, perimeter, diameter) is computed as PyRadiomics computes it; the principal components differ from
            // NumPy's by rounding
            EXPECT_NEAR(values.at(*type), expected, 1e-10 * std::max(1.0, std::abs(expected))) << name;
        }
    }
}

TEST(ShapeTest, SquaresAndThinShapes) {
    // A 4 x 3 rectangle: the mesh cuts its corners by half a pixel each way
    cv::Mat rectangle = cv::Mat::zeros(10, 10, CV_8UC1);
    rectangle(cv::Rect(2, 3, 4, 3)).setTo(255);
    auto values = ComputeShapeFeatures(rectangle, {1, 1}, ALL_SHAPE);
    EXPECT_DOUBLE_EQ(values.at(Type::ShapePixelSurface), 12.0);
    EXPECT_DOUBLE_EQ(values.at(Type::ShapeMeshSurface), 12.0 - 4 * 0.125);
    EXPECT_DOUBLE_EQ(values.at(Type::ShapePerimeter), 2 * (3 + 2) + 4 * std::sqrt(0.5));
    // Mesh vertices lie half a pixel outside the pixel centres: the farthest pair runs from (row 3, col 1.5) to (row 5, col 5.5)
    EXPECT_DOUBLE_EQ(values.at(Type::ShapeMaximumDiameter), std::sqrt(20.0));

    // Millimetres scale lengths and areas
    const auto scaled = ComputeShapeFeatures(rectangle, {0.5, 0.5}, ALL_SHAPE);
    EXPECT_DOUBLE_EQ(scaled.at(Type::ShapePerimeter), values.at(Type::ShapePerimeter) * 0.5);
    EXPECT_DOUBLE_EQ(scaled.at(Type::ShapeMeshSurface), values.at(Type::ShapeMeshSurface) * 0.25);
    EXPECT_DOUBLE_EQ(scaled.at(Type::ShapeSphericity), values.at(Type::ShapeSphericity));

    // A one-pixel-wide line has no minor axis and an elongation of 0
    cv::Mat line = cv::Mat::zeros(5, 20, CV_8UC1);
    line.row(2).colRange(3, 17).setTo(255);
    values = ComputeShapeFeatures(line, {1, 1}, ALL_SHAPE);
    EXPECT_DOUBLE_EQ(values.at(Type::ShapeMinorAxisLength), 0.0);
    EXPECT_DOUBLE_EQ(values.at(Type::ShapeElongation), 0.0);

    const auto empty = ComputeShapeFeatures(cv::Mat::zeros(5, 5, CV_8UC1), {1, 1}, ALL_SHAPE);
    EXPECT_TRUE(std::isnan(empty.at(Type::ShapePerimeter)));
    EXPECT_THROW(ComputeShapeFeatures(rectangle, {0, 1}, ALL_SHAPE), std::invalid_argument);
    EXPECT_THROW(ComputeShapeFeatures(rectangle, {1, 1}, {Type::Contrast}), std::invalid_argument);
    EXPECT_THROW(ComputeShapeFeatures(cv::Mat::zeros(5, 5, CV_16UC1), {1, 1}, ALL_SHAPE), std::invalid_argument);
}

TEST(ShapeTest, RunAnalysisUsesThePixelSpacingAndRepeatsTheValues) {
    const cv::Mat gray(40, 50, CV_8UC1, cv::Scalar(7));
    AnalysisSettings settings = DefaultSettings(8);
    settings.features = {Type::ShapeMeshSurface, Type::ShapeSphericity, Type::Contrast};
    settings.distances = {1, 2};
    const std::vector<Roi> rois = {Roi{"e", "Ellipse", "", EllipseRoi{25, 20, 12, 7, 20}, ""}};

    const AnalysisOutput pixels = RunAnalysis(gray, rois, settings);
    const AnalysisOutput millimetres = RunAnalysis(gray, rois, settings, nullptr, PixelSpacing{0.5, 0.25});
    ASSERT_EQ(pixels.results.size(), 2u);
    const CroppedMask cropped = RasterizeCroppedMask(rois[0].shape, gray.size());
    const auto expected = ComputeShapeFeatures(cropped.mask, {0.5, 0.25}, {Type::ShapeMeshSurface, Type::ShapeSphericity});
    for (const MeasurementResult& result : millimetres.results) {
        EXPECT_EQ(result.status, MeasurementStatus::Ok);
        for (Direction direction : settings.directions) {
            EXPECT_DOUBLE_EQ(result.values.at(Type::ShapeMeshSurface).Get(direction), expected.at(Type::ShapeMeshSurface));
        }
        EXPECT_DOUBLE_EQ(result.values.at(Type::ShapeMeshSurface).Avg(), expected.at(Type::ShapeMeshSurface));
    }
    EXPECT_NE(pixels.results[0].values.at(Type::ShapeMeshSurface).Avg(), millimetres.results[0].values.at(Type::ShapeMeshSurface).Avg());
    EXPECT_THROW(RunAnalysis(gray, rois, settings, nullptr, PixelSpacing{0, 1}), std::invalid_argument);
}
