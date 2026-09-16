#include <gtest/gtest.h>

#include <cmath>
#include <functional>
#include <limits>
#include <map>
#include <opencv2/core.hpp>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

#include "analysis/LocalBinaryPattern.hpp"
#include "analysis/Score.hpp"
#include "analysis/TextureAnalysis.hpp"
#include "imaging/Quantizer.hpp"
#include "pipeline/AnalysisRunner.hpp"
#include "pipeline/AnalysisSettings.hpp"
#include "pipeline/FeatureCatalog.hpp"
#include "roi/Roi.hpp"

using namespace glcm;

namespace {

const Direction DIRECTIONS[] = {Direction::H, Direction::V, Direction::LD, Direction::RD};

cv::Mat Pattern8(int rows, int cols) {
    cv::Mat image(rows, cols, CV_8UC1);
    for (int m = 0; m < rows; ++m) {
        for (int n = 0; n < cols; ++n) {
            image.at<uchar>(m, n) = static_cast<uchar>((m * 37 + n * 11 + m * n * 3) % 256);
        }
    }
    return image;
}

// Gray levels v / 8 (Ng = 32 over 0-255)
cv::Mat DivideBy8(const cv::Mat& image) {
    cv::Mat levels(image.size(), CV_8UC1);
    for (int m = 0; m < image.rows; ++m) {
        for (int n = 0; n < image.cols; ++n) {
            levels.at<uchar>(m, n) = static_cast<uchar>(image.at<uchar>(m, n) / 8);
        }
    }
    return levels;
}

Roi RectangleRegion(const std::string& name, double x, double y, double width, double height) {
    Roi roi;
    roi.id = name + "-id";
    roi.name = name;
    roi.color = "#FFD400";
    roi.shape = RectangleRoi{x, y, width, height};
    return roi;
}

std::set<Type> AllFeatures() {
    std::set<Type> types;
    for (const FeatureInfo& info : FeatureCatalog()) {
        types.insert(info.type);
    }
    return types;
}

void ExpectFeaturesEqual(const Features& actual, const Features& expected) {
    for (Direction direction : DIRECTIONS) {
        const double a = actual.Get(direction);
        const double e = expected.Get(direction);
        if (std::isnan(e)) {
            EXPECT_TRUE(std::isnan(a));
        } else {
            EXPECT_DOUBLE_EQ(a, e);
        }
    }
}

bool HasWarningContaining(const MeasurementResult& result, const std::string& text) {
    for (const std::string& warning : result.warnings) {
        if (warning.find(text) != std::string::npos) {
            return true;
        }
    }
    return false;
}

} // namespace

// ---------------------------------------------------------------------------------------------------------------------
// Feature catalog and settings
// ---------------------------------------------------------------------------------------------------------------------

TEST(FeatureCatalogTest, ListsEveryFeatureOnce) {
    std::set<Type> types;
    std::set<std::string> ids;
    for (const FeatureInfo& info : FeatureCatalog()) {
        EXPECT_TRUE(types.insert(info.type).second) << info.id;
        EXPECT_TRUE(ids.insert(info.id).second) << info.id;
        EXPECT_EQ(info.name, TextureAnalysis::TypeToString(info.type));
        EXPECT_EQ(FeatureTypeFromId(info.id), info.type);
        EXPECT_EQ(&FindFeature(info.type), &info);
        EXPECT_FALSE(info.doc_anchor.empty());
    }
    EXPECT_EQ(types.size(), static_cast<size_t>(Type::Score)); // Mean ... MaximalCorrelationCoefficient
    EXPECT_FALSE(FeatureTypeFromId("Score").has_value());
    EXPECT_FALSE(FeatureTypeFromId("NoSuchFeature").has_value());
    EXPECT_THROW(FindFeature(Type::Score), std::invalid_argument);
}

TEST(FeatureCatalogTest, MarksNonStandardAndSlowFeatures) {
    std::set<Type> non_standard;
    for (const FeatureInfo& info : FeatureCatalog()) {
        if (info.non_standard) {
            non_standard.insert(info.type);
            EXPECT_FALSE(info.non_standard_reason.empty());
        } else {
            EXPECT_TRUE(info.non_standard_reason.empty());
        }
    }
    EXPECT_EQ(non_standard, (std::set<Type>{Type::CorrelationIII, Type::SumOfSquares}));
    EXPECT_EQ(FindFeature(Type::MaximalCorrelationCoefficient).cost, FeatureCost::Slow);
    EXPECT_EQ(FindFeature(Type::Contrast).cost, FeatureCost::Normal);
    EXPECT_EQ(FeatureGroupId(FindFeature(Type::Mean).group), "regionStatistics");
}

TEST(FeatureCatalogTest, PresetsAreValid) {
    std::set<std::string> ids;
    for (const FeaturePreset& preset : FeaturePresets()) {
        ids.insert(preset.id);
        AnalysisSettings settings = DefaultSettings(8);
        settings.features = preset.features;
        settings.score.enabled = preset.enables_score;
        EXPECT_NO_THROW(ValidateSettings(settings)) << preset.id;

        if (preset.id == "all") {
            EXPECT_EQ(preset.features, AllFeatures());
        }
        if (preset.id == "haralick") {
            EXPECT_EQ(preset.features.size(), 14u);
        }
        if (preset.id == "lbp") {
            EXPECT_EQ(preset.features.size(), 12u);
        }
        if (preset.id == "shape") {
            EXPECT_EQ(preset.features.size(), 9u);
        }
        if (preset.id == "ngtdm") {
            EXPECT_EQ(preset.features.size(), 5u);
        }
        if (preset.id == "glszm") {
            EXPECT_EQ(preset.features.size(), 16u);
        }
        if (preset.id == "glrlm") {
            EXPECT_EQ(preset.features.size(), 16u);
        }
        if (preset.id == "firstOrder") {
            EXPECT_EQ(preset.features.size(), 18u); // Mean, Std and the 16 of analysis/FirstOrder
        }
        if (preset.id == "score") {
            EXPECT_TRUE(preset.enables_score);
        }
    }
    EXPECT_EQ(ids, (std::set<std::string>{
                       "haralick", "clausi2002", "basic", "score", "firstOrder", "glrlm", "glszm", "ngtdm", "lbp", "shape", "all"}));
}

TEST(AnalysisSettingsTest, DefaultsDependOnBitDepth) {
    const AnalysisSettings eight = DefaultSettings(8);
    EXPECT_NO_THROW(ValidateSettings(eight));
    EXPECT_EQ(eight.gray_levels, 32);
    EXPECT_EQ(eight.quantization.method, QuantizationMethod::FixedRange);
    EXPECT_EQ(eight.quantization.range_max, 255);
    EXPECT_EQ(eight.features.size(), 14u);
    EXPECT_FALSE(eight.score.enabled);

    const AnalysisSettings sixteen = DefaultSettings(16);
    EXPECT_EQ(sixteen.quantization.range_max, 65535);
    EXPECT_EQ(sixteen.score.intensity_max, 65535);
    EXPECT_THROW(DefaultSettings(12), std::invalid_argument);
}

TEST(AnalysisSettingsTest, InvalidSettingsThrow) {
    const double nan = std::numeric_limits<double>::quiet_NaN();
    const std::vector<std::pair<std::string, std::function<void(AnalysisSettings&)>>> changes = {
        {"Ng = 1", [](AnalysisSettings& s) { s.gray_levels = 1; }},
        {"Ng = 257", [](AnalysisSettings& s) { s.gray_levels = 257; }},
        {"no distance", [](AnalysisSettings& s) { s.distances = {}; }},
        {"distance 0", [](AnalysisSettings& s) { s.distances = {0}; }},
        {"distance 65", [](AnalysisSettings& s) { s.distances = {65}; }},
        {"duplicate distance", [](AnalysisSettings& s) { s.distances = {1, 2, 1}; }},
        {"no direction", [](AnalysisSettings& s) { s.directions = {}; }},
        {"Avg direction", [](AnalysisSettings& s) { s.directions = {Direction::H, Direction::Avg}; }},
        {"no feature", [](AnalysisSettings& s) { s.features = {}; }},
        {"Score as feature", [](AnalysisSettings& s) { s.features = {Type::Score}; }},
        {"range max < min", [](AnalysisSettings& s) { s.quantization.range_min = 10, s.quantization.range_max = 5; }},
        {"bin width 0",
            [](AnalysisSettings& s) {
                s.quantization.method = QuantizationMethod::FixedBinWidth;
                s.quantization.bin_width = 0.0;
            }},
        {"age 0",
            [](AnalysisSettings& s) {
                s.score.enabled = true;
                s.score.age = 0.0;
            }},
        {"NaN coefficient",
            [nan](AnalysisSettings& s) {
                s.score.enabled = true;
                s.score.coefficients.entropy = nan;
            }},
        {"empty score intensity range",
            [](AnalysisSettings& s) {
                s.score.enabled = true;
                s.score.intensity_min = s.score.intensity_max = 100;
            }},
    };

    for (const auto& [name, change] : changes) {
        AnalysisSettings settings = DefaultSettings(8);
        change(settings);
        EXPECT_THROW(ValidateSettings(settings), std::invalid_argument) << name;
    }

    AnalysisSettings score_only = DefaultSettings(8);
    score_only.features = {};
    score_only.score.enabled = true;
    EXPECT_NO_THROW(ValidateSettings(score_only));
}

// ---------------------------------------------------------------------------------------------------------------------
// Region statistics
// ---------------------------------------------------------------------------------------------------------------------

TEST(RegionStatisticsTest, UsesPixelsInsideTheMask) {
    uchar pixels[] = {2, 4, 4, 4, 5, 5, 7, 9};
    const cv::Mat image = cv::Mat(2, 4, CV_8UC1, pixels).clone();
    const RegionStatistics full = ComputeRegionStatistics(image, cv::Mat(image.size(), CV_8UC1, cv::Scalar(255)));
    EXPECT_EQ(full.pixel_count, 8);
    EXPECT_DOUBLE_EQ(full.mean, 5.0);
    EXPECT_DOUBLE_EQ(full.std, std::sqrt(32.0 / 7.0));
    EXPECT_EQ(full.min, 2);
    EXPECT_EQ(full.max, 9);

    cv::Mat one = cv::Mat::zeros(image.size(), CV_8UC1);
    one.at<uchar>(1, 3) = 255;
    const RegionStatistics single = ComputeRegionStatistics(image, one);
    EXPECT_DOUBLE_EQ(single.mean, 9.0);
    EXPECT_DOUBLE_EQ(single.std, 0.0);

    const RegionStatistics empty = ComputeRegionStatistics(image, cv::Mat::zeros(image.size(), CV_8UC1));
    EXPECT_EQ(empty.pixel_count, 0);
    EXPECT_TRUE(std::isnan(empty.mean));
    EXPECT_TRUE(std::isnan(empty.std));
}

// ---------------------------------------------------------------------------------------------------------------------
// Analysis runner
// ---------------------------------------------------------------------------------------------------------------------

TEST(AnalysisRunnerTest, MatchesDirectComputationForEachDistance) {
    const cv::Mat image = Pattern8(40, 50);
    AnalysisSettings settings = DefaultSettings(8);
    settings.features = AllFeatures();
    settings.distances = {1, 3};

    const AnalysisOutput output = RunAnalysis(image, {RectangleRegion("A", 5, 4, 30, 20)}, settings);
    ASSERT_EQ(output.results.size(), 2u);
    EXPECT_FALSE(output.cancelled);

    const cv::Mat crop = image(cv::Rect(5, 4, 30, 20)).clone();
    const cv::Mat mask = RasterizeMask(RectangleRoi{5, 4, 30, 20}, image.size());
    const RegionStatistics original = ComputeRegionStatistics(image, mask);

    for (size_t i = 0; i < output.results.size(); ++i) {
        const MeasurementResult& result = output.results[i];
        SCOPED_TRACE("distance " + std::to_string(result.distance));
        EXPECT_EQ(result.status, MeasurementStatus::Ok);
        EXPECT_EQ(result.roi_id, "A-id");
        EXPECT_EQ(result.roi_name, "A");
        EXPECT_EQ(result.distance, settings.distances[i]);
        EXPECT_EQ(result.pixel_count, 600);
        EXPECT_EQ(result.quantization_lower, 0);
        EXPECT_EQ(result.quantization_upper, 255);
        EXPECT_EQ(result.values.size(), AllFeatures().size());
        EXPECT_TRUE(result.warnings.empty());

        // Texture features from the gray levels of the rectangle crop, through the rectangle path of TextureAnalysis
        TextureAnalysis direct(32);
        direct.ProcessRectImage(DivideBy8(crop), result.distance);
        for (const auto& [type, values] : direct.Calculate(AllFeatures())) {
            if (type == Type::Mean || type == Type::Std) {
                continue;
            }
            SCOPED_TRACE(TextureAnalysis::TypeToString(type));
            ExpectFeaturesEqual(result.values.at(type), values);
        }

        // Region statistics from the original intensities (gray levels would be below 32)
        EXPECT_DOUBLE_EQ(result.values.at(Type::Mean).Avg(), original.mean);
        EXPECT_DOUBLE_EQ(result.values.at(Type::Std).Avg(), original.std);
        EXPECT_GT(original.mean, 32.0);
    }
}

TEST(AnalysisRunnerTest, PassesDirectionsAndLogBaseThrough) {
    const cv::Mat image = Pattern8(30, 30);
    const Roi roi = RectangleRegion("A", 2, 2, 20, 20);
    AnalysisSettings settings = DefaultSettings(8);
    settings.features = {Type::Mean, Type::Contrast, Type::Entropy};
    settings.directions = {Direction::V};
    settings.log_base = LogBase::Two;

    const MeasurementResult two = RunAnalysis(image, {roi}, settings).results.at(0);
    EXPECT_TRUE(std::isnan(two.values.at(Type::Contrast).H));
    EXPECT_FALSE(std::isnan(two.values.at(Type::Contrast).V));
    EXPECT_TRUE(std::isnan(two.values.at(Type::Mean).RD));
    EXPECT_EQ(two.pair_counts[0], 0);
    EXPECT_EQ(two.pair_counts[1], 20 * 19 * 2);

    settings.log_base = LogBase::Natural;
    const MeasurementResult natural = RunAnalysis(image, {roi}, settings).results.at(0);
    EXPECT_NEAR(two.values.at(Type::Entropy).V, natural.values.at(Type::Entropy).V / std::log(2.0), 1e-12);
    EXPECT_DOUBLE_EQ(two.values.at(Type::Contrast).V, natural.values.at(Type::Contrast).V);
}

TEST(AnalysisRunnerTest, SkipsAndFailsRoisIndividually) {
    const cv::Mat image = Pattern8(20, 20);
    AnalysisSettings settings = DefaultSettings(8);
    settings.features = {Type::Contrast};

    Roi broken;
    broken.id = "broken-id";
    broken.name = "broken";
    PolygonRoi polygon;
    polygon.points = {{1.0, 1.0}, {std::numeric_limits<double>::quiet_NaN(), 2.0}, {5.0, 9.0}};
    broken.shape = polygon;

    const AnalysisOutput output = RunAnalysis(image,
        {RectangleRegion("single", 3, 3, 1, 1), RectangleRegion("outside", 50, 50, 5, 5), broken, RectangleRegion("good", 2, 2, 10, 10)},
        settings);
    ASSERT_EQ(output.results.size(), 4u);

    EXPECT_EQ(output.results[0].status, MeasurementStatus::Skipped);
    EXPECT_EQ(output.results[0].pixel_count, 1);
    EXPECT_FALSE(output.results[0].error.empty());
    EXPECT_TRUE(output.results[0].values.empty());

    EXPECT_EQ(output.results[1].status, MeasurementStatus::Skipped);
    EXPECT_EQ(output.results[1].pixel_count, 0);

    EXPECT_EQ(output.results[2].status, MeasurementStatus::Failed);
    EXPECT_NE(output.results[2].error.find("non-finite"), std::string::npos);

    EXPECT_EQ(output.results[3].status, MeasurementStatus::Ok);
    EXPECT_EQ(output.results[3].values.count(Type::Contrast), 1u);
}

TEST(AnalysisRunnerTest, WarnsWhenADirectionHasNoPairs) {
    const cv::Mat image = Pattern8(20, 20);
    AnalysisSettings settings = DefaultSettings(8);
    settings.features = {Type::Contrast};

    const MeasurementResult result = RunAnalysis(image, {RectangleRegion("row", 2, 5, 10, 1)}, settings).results.at(0);
    EXPECT_EQ(result.status, MeasurementStatus::Ok);
    EXPECT_GT(result.pair_counts[0], 0);
    EXPECT_EQ(result.pair_counts[1], 0);
    EXPECT_TRUE(HasWarningContaining(result, "90°"));
    EXPECT_FALSE(HasWarningContaining(result, " 0° direction"));
    EXPECT_DOUBLE_EQ(result.values.at(Type::Contrast).V, 0.0);
}

TEST(AnalysisRunnerTest, QuantizationErrorsFailTheMeasurement) {
    AnalysisSettings settings = DefaultSettings(8);
    settings.features = {Type::Contrast};
    settings.quantization.method = QuantizationMethod::None;

    const MeasurementResult result = RunAnalysis(Pattern8(20, 20), {RectangleRegion("A", 0, 0, 20, 20)}, settings).results.at(0);
    EXPECT_EQ(result.status, MeasurementStatus::Failed);
    EXPECT_NE(result.error.find("Ng = 32"), std::string::npos);
    EXPECT_TRUE(result.values.empty());
}

TEST(AnalysisRunnerTest, ReportsProgressAndCancels) {
    const cv::Mat image = Pattern8(30, 30);
    const std::vector<Roi> rois = {
        RectangleRegion("A", 0, 0, 10, 10), RectangleRegion("B", 10, 10, 10, 10), RectangleRegion("C", 5, 5, 10, 10)};
    AnalysisSettings settings = DefaultSettings(8);
    settings.features = {Type::Contrast};
    settings.distances = {1, 2};

    std::vector<int> calls;
    const AnalysisOutput output = RunAnalysis(image, rois, settings, [&calls](int completed, int total) {
        calls.push_back(completed);
        EXPECT_EQ(total, 6);
        return true;
    });
    EXPECT_EQ(calls, (std::vector<int>{1, 2, 3, 4, 5, 6}));
    ASSERT_EQ(output.results.size(), 6u);
    EXPECT_FALSE(output.cancelled);
    EXPECT_EQ(output.results[1].roi_name, "A");
    EXPECT_EQ(output.results[1].distance, 2);
    EXPECT_EQ(output.results[2].roi_name, "B");

    const AnalysisOutput cancelled = RunAnalysis(image, rois, settings, [](int completed, int) { return completed < 2; });
    EXPECT_TRUE(cancelled.cancelled);
    EXPECT_EQ(cancelled.results.size(), 2u);
}

TEST(AnalysisRunnerTest, CalibrationScoreMatchesOriginalApplication) {
    const cv::Mat image = Pattern8(40, 50);
    AnalysisSettings settings = DefaultSettings(8);
    settings.features = {Type::Contrast};
    settings.distances = {2};
    settings.score.enabled = true;
    settings.score.age = 40.0;

    const MeasurementResult result = RunAnalysis(image, {RectangleRegion("A", 5, 4, 30, 20)}, settings).results.at(0);
    ASSERT_TRUE(result.score.has_value());
    EXPECT_TRUE(result.warnings.empty());

    // What the original application computed for this rectangle: Ng = 256, d = 1, CalculateScore
    TextureAnalysis legacy(256);
    legacy.ProcessRectImage(image(cv::Rect(5, 4, 30, 20)).clone(), 1);
    auto legacy_values = legacy.Calculate({Type::Mean, Type::Entropy, Type::Contrast});
    legacy.CalculateScore(40.0, legacy_values);
    ExpectFeaturesEqual(*result.score, legacy_values.at(Type::Score));
}

TEST(AnalysisRunnerTest, CurrentSettingsScoreUsesAnalysisSettingsAndWarns) {
    const cv::Mat image = Pattern8(40, 50);
    AnalysisSettings settings = DefaultSettings(8);
    settings.features = {Type::Contrast};
    settings.distances = {2};
    settings.score.enabled = true;
    settings.score.profile = ScoreProfile::CurrentSettings;

    const MeasurementResult result = RunAnalysis(image, {RectangleRegion("A", 5, 4, 30, 20)}, settings).results.at(0);
    ASSERT_TRUE(result.score.has_value());
    EXPECT_TRUE(HasWarningContaining(result, "calibrated"));
    EXPECT_EQ(result.values.size(), 1u); // Entropy is computed for the score but not reported

    TextureAnalysis direct(32);
    direct.ProcessRectImage(DivideBy8(image(cv::Rect(5, 4, 30, 20)).clone()), 2);
    const auto values = direct.Calculate({Type::Entropy, Type::Contrast});
    const RegionStatistics original = ComputeRegionStatistics(image, RasterizeMask(RectangleRoi{5, 4, 30, 20}, image.size()));
    const Features mean{original.mean, original.mean, original.mean, original.mean};
    ExpectFeaturesEqual(*result.score, ComputeScore(40.0, mean, values.at(Type::Entropy), values.at(Type::Contrast)));
}

TEST(AnalysisRunnerTest, SixteenBitImagesUseOriginalIntensitiesAndMappedScore) {
    cv::Mat image(30, 30, CV_16UC1);
    for (int m = 0; m < image.rows; ++m) {
        for (int n = 0; n < image.cols; ++n) {
            image.at<uint16_t>(m, n) = static_cast<uint16_t>((m * 131 + n * 57) % 4096);
        }
    }
    AnalysisSettings settings = DefaultSettings(16);
    settings.features = {Type::Mean, Type::Contrast};
    settings.quantization.range_max = 4095;
    settings.score.enabled = true;
    settings.score.intensity_min = 0;
    settings.score.intensity_max = 4095;

    const MeasurementResult result = RunAnalysis(image, {RectangleRegion("A", 3, 3, 20, 20)}, settings).results.at(0);
    ASSERT_EQ(result.status, MeasurementStatus::Ok);
    EXPECT_TRUE(HasWarningContaining(result, "8-bit"));

    const cv::Mat mask = RasterizeMask(RectangleRoi{3, 3, 20, 20}, image.size());
    const RegionStatistics original = ComputeRegionStatistics(image, mask);
    EXPECT_DOUBLE_EQ(result.values.at(Type::Mean).H, original.mean);
    EXPECT_GT(original.mean, 255.0);

    QuantizationSettings mapping;
    mapping.range_min = 0;
    mapping.range_max = 4095;
    const cv::Mat mapped = Quantize(image, mask, 256, mapping).image;
    TextureAnalysis calibration(256);
    calibration.ProcessMaskedImage(mapped, mask, 1);
    const auto values = calibration.Calculate({Type::Entropy, Type::Contrast});
    const RegionStatistics mapped_statistics = ComputeRegionStatistics(mapped, mask);
    const Features mean{mapped_statistics.mean, mapped_statistics.mean, mapped_statistics.mean, mapped_statistics.mean};
    ASSERT_TRUE(result.score.has_value());
    ExpectFeaturesEqual(*result.score, ComputeScore(40.0, mean, values.at(Type::Entropy), values.at(Type::Contrast)));
}

TEST(AnalysisRunnerTest, RejectsInvalidImagesAndSettings) {
    const Roi roi = RectangleRegion("A", 0, 0, 5, 5);
    EXPECT_THROW(RunAnalysis(cv::Mat(10, 10, CV_32FC1, cv::Scalar(0)), {roi}, DefaultSettings(8)), std::invalid_argument);

    AnalysisSettings invalid = DefaultSettings(8);
    invalid.gray_levels = 0;
    EXPECT_THROW(RunAnalysis(Pattern8(10, 10), {roi}, invalid), std::invalid_argument);

    EXPECT_TRUE(RunAnalysis(Pattern8(10, 10), {}, DefaultSettings(8)).results.empty());
}

// Only the box around each ROI is analysed; the results must not depend on the rest of the image or on the position
TEST(AnalysisRunnerTest, ResultsDoNotDependOnWhereTheRoiLiesInTheImage) {
    const cv::Mat small = Pattern8(40, 50);
    cv::Mat large(700, 900, CV_8UC1);
    cv::randu(large, 0, 256);
    const cv::Point offset(613, 402);
    small.copyTo(large(cv::Rect(offset, small.size())));

    const auto regions = [](double dx, double dy) {
        std::vector<Roi> rois = {RectangleRegion("rectangle", 3.0 + dx, 4.0 + dy, 30.0, 20.0), RectangleRegion("ellipse", 0, 0, 0, 0),
            RectangleRegion("polygon", 0, 0, 0, 0)};
        rois[1].shape = EllipseRoi{25.0 + dx, 20.0 + dy, 14.0, 9.0, 25.0};
        PolygonRoi polygon;
        polygon.points = {{2.0 + dx, 2.0 + dy}, {45.0 + dx, 6.0 + dy}, {30.0 + dx, 37.0 + dy}, {8.0 + dx, 30.0 + dy}};
        rois[2].shape = polygon;
        return rois;
    };
    const auto same = [](double a, double b) { return a == b || (std::isnan(a) && std::isnan(b)); };
    const auto same_features = [&](const Features& a, const Features& b) {
        return same(a.H, b.H) && same(a.V, b.V) && same(a.LD, b.LD) && same(a.RD, b.RD);
    };

    AnalysisSettings settings = DefaultSettings(8);
    // LBP samples the pixels around the ROI on purpose (AnalysisRunnerLbpTest), so it depends on the rest of the image
    for (Type type : AllFeatures()) {
        if (!IsLocalBinaryPatternFeature(type)) {
            settings.features.insert(type);
        }
    }
    settings.distances = {1, 3};
    settings.score.enabled = true;
    for (const QuantizationMethod method : {QuantizationMethod::FixedRange, QuantizationMethod::RoiMinMax}) {
        settings.quantization.method = method;
        const AnalysisOutput alone = RunAnalysis(small, regions(0.0, 0.0), settings);
        const AnalysisOutput embedded = RunAnalysis(large, regions(offset.x, offset.y), settings);
        ASSERT_EQ(alone.results.size(), 6u);
        ASSERT_EQ(embedded.results.size(), 6u);
        for (size_t i = 0; i < alone.results.size(); ++i) {
            SCOPED_TRACE(alone.results[i].roi_id + " d=" + std::to_string(alone.results[i].distance));
            const MeasurementResult& a = alone.results[i];
            const MeasurementResult& b = embedded.results[i];
            EXPECT_EQ(a.status, MeasurementStatus::Ok);
            EXPECT_EQ(a.status, b.status);
            EXPECT_EQ(a.pixel_count, b.pixel_count);
            EXPECT_EQ(a.pair_counts, b.pair_counts);
            EXPECT_EQ(a.quantization_lower, b.quantization_lower);
            EXPECT_EQ(a.quantization_upper, b.quantization_upper);
            EXPECT_EQ(a.warnings, b.warnings);
            ASSERT_EQ(a.values.size(), b.values.size());
            for (const auto& [type, features] : a.values) {
                EXPECT_TRUE(same_features(features, b.values.at(type))) << TextureAnalysis::TypeToString(type);
            }
            ASSERT_EQ(a.score.has_value(), b.score.has_value());
            if (a.score) {
                EXPECT_TRUE(same_features(*a.score, *b.score));
            }
        }
    }
}
