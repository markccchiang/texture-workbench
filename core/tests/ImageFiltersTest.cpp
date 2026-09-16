#include <gtest/gtest.h>

#include <algorithm>
#include <cmath>
#include <fstream>
#include <functional>
#include <nlohmann/json.hpp>
#include <opencv2/core.hpp>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "imaging/ImageFilters.hpp"
#include "imaging/ImageLoader.hpp"
#include "io/Json.hpp"
#include "io/ResultsCsv.hpp"
#include "pipeline/AnalysisRunner.hpp"
#include "pipeline/FeatureCatalog.hpp"

using namespace glcm;

TEST(ImageFiltersTest, LaplacianOfGaussianMatchesSimpleItk) {
    // Written by scripts/radiomics-reference.py: SimpleITK's LaplacianRecursiveGaussianImageFilter as PyRadiomics sets it up
    std::ifstream stream(GLCM_SOURCE_DIR "/core/tests/data/simpleitk-log.json");
    ASSERT_TRUE(stream) << "missing core/tests/data/simpleitk-log.json";
    const nlohmann::json document = nlohmann::json::parse(stream);
    ASSERT_EQ(document.at("cases").size(), 5u);

    for (const nlohmann::json& reference : document.at("cases")) {
        const std::string image_path = reference.at("image");
        const double sigma = reference.at("sigma");
        const cv::Point2d spacing(reference.at("spacing").at(0), reference.at("spacing").at(1));
        SCOPED_TRACE(image_path + " sigma " + std::to_string(sigma));
        const LoadedImage image = LoadImageFile(GLCM_SOURCE_DIR "/samples/" + image_path);
        const auto& crop = reference.at("crop");
        const cv::Mat gray = image.gray(cv::Rect(crop.at(0), crop.at(1), crop.at(2), crop.at(3))).clone();

        const cv::Mat log = LaplacianOfGaussian(gray, spacing, sigma);
        ASSERT_EQ(log.type(), CV_32FC1);
        ASSERT_EQ(log.size(), gray.size());
        const auto& expected = reference.at("values");
        double scale = 0.0;
        for (const auto& value : expected) {
            scale = std::max(scale, std::abs(value.get<double>()));
        }
        for (int row = 0; row < log.rows; ++row) {
            for (int col = 0; col < log.cols; ++col) {
                const double want = expected.at(static_cast<size_t>(row) * log.cols + col);
                // Identical on macOS arm64; a few float32 steps of room for compilers that fuse operations differently
                ASSERT_NEAR(log.at<float>(row, col), want, 1e-6 * std::max(1.0, scale)) << "pixel " << col << ", " << row;
            }
        }
    }
}

TEST(ImageFiltersTest, LaplacianOfGaussianRejectsInvalidInput) {
    const cv::Mat image(10, 10, CV_8UC1, cv::Scalar(5));
    // A constant image has no second derivative
    EXPECT_LE(cv::norm(LaplacianOfGaussian(image, {1, 1}, 2.0), cv::NORM_INF), 1e-4);
    EXPECT_THROW(LaplacianOfGaussian(cv::Mat(3, 10, CV_8UC1), {1, 1}, 1.0), std::invalid_argument);
    EXPECT_THROW(LaplacianOfGaussian(image, {1, 1}, 0.0), std::invalid_argument);
    EXPECT_THROW(LaplacianOfGaussian(image, {0, 1}, 1.0), std::invalid_argument);
    EXPECT_THROW(LaplacianOfGaussian(cv::Mat(10, 10, CV_8UC3), {1, 1}, 1.0), std::invalid_argument);
}

namespace {

// Compares features measured on a filtered image with a document written by scripts/radiomics-reference.py: PyRadiomics'
// filter on the whole image, then first-order, GLRLM, GLSZM and NGTDM features in a rectangle with binWidth or binCount (log2)
void ExpectFeaturesOfFilteredImages(
    const std::string& file, size_t cases, const std::function<ImageFilterSettings(const nlohmann::json&)>& filter_of) {
    std::ifstream stream(GLCM_SOURCE_DIR "/core/tests/data/" + file);
    ASSERT_TRUE(stream) << "missing core/tests/data/" << file;
    const nlohmann::json document = nlohmann::json::parse(stream);
    ASSERT_EQ(document.at("cases").size(), cases);

    for (const nlohmann::json& reference : document.at("cases")) {
        const std::string image_path = reference.at("image");
        SCOPED_TRACE(image_path + " " + reference.value("imageType", reference.value("band", "")) + " " + reference.at("binning").dump());
        const LoadedImage image = LoadImageFile(GLCM_SOURCE_DIR "/samples/" + image_path);
        const auto& rectangle = reference.at("rectangle");

        AnalysisSettings settings = DefaultSettings(image.gray.depth() == CV_16U ? 16 : 8);
        settings.features.clear();
        for (const auto& [id, value] : reference.at("features").items()) {
            const std::optional<Type> type = FeatureTypeFromId(id);
            ASSERT_TRUE(type.has_value()) << id;
            settings.features.insert(*type);
        }
        const auto& binning = reference.at("binning");
        if (binning.contains("binWidth")) {
            settings.quantization.method = QuantizationMethod::FixedBinWidth;
            settings.quantization.bin_width = binning.at("binWidth");
            settings.gray_levels = 256;
        } else {
            settings.quantization.method = QuantizationMethod::RoiMinMax;
            settings.gray_levels = binning.at("binCount");
        }
        settings.distances = {1};
        settings.log_base = LogBase::Two;
        settings.filter = filter_of(reference);
        std::optional<PixelSpacing> spacing;
        if (reference.contains("spacing")) {
            spacing = PixelSpacing{reference.at("spacing").at(0), reference.at("spacing").at(1)};
        }
        const std::vector<Roi> rois = {
            Roi{"r", "Rectangle", "", RectangleRoi{rectangle.at(0), rectangle.at(1), rectangle.at(2), rectangle.at(3)}, ""}};

        const AnalysisOutput output = RunAnalysis(image.gray, rois, settings, nullptr, spacing);
        ASSERT_EQ(output.results.size(), 1u);
        const MeasurementResult& result = output.results[0];
        ASSERT_EQ(result.status, MeasurementStatus::Ok) << result.error;
        for (const auto& [id, value] : reference.at("features").items()) {
            const double expected = value.get<double>();
            EXPECT_NEAR(result.values.at(*FeatureTypeFromId(id)).Avg(), expected, 1e-9 * std::max(1.0, std::abs(expected))) << id;
        }
    }
}

} // namespace

TEST(ImageFiltersTest, FeaturesOfLaplacianOfGaussianImagesMatchPyRadiomics) {
    ExpectFeaturesOfFilteredImages("pyradiomics-log-features.json", 4,
        [](const nlohmann::json& reference) { return ImageFilterSettings{ImageFilterType::LaplacianOfGaussian, reference.at("sigma")}; });
}

TEST(ImageFiltersTest, WaveletImagesMatchPyWavelets) {
    // Written by scripts/radiomics-reference.py: the four sub-bands of PyRadiomics' getWaveletImage (PyWavelets' swtn, coif1)
    std::ifstream stream(GLCM_SOURCE_DIR "/core/tests/data/pywavelets-wavelet.json");
    ASSERT_TRUE(stream) << "missing core/tests/data/pywavelets-wavelet.json";
    const nlohmann::json document = nlohmann::json::parse(stream);
    ASSERT_EQ(document.at("cases").size(), 5u);

    for (const nlohmann::json& reference : document.at("cases")) {
        const std::string image_path = reference.at("image");
        const auto& crop = reference.at("crop");
        SCOPED_TRACE(image_path + " " + crop.dump());
        const LoadedImage image = LoadImageFile(GLCM_SOURCE_DIR "/samples/" + image_path);
        const cv::Mat gray = image.gray(cv::Rect(crop.at(0), crop.at(1), crop.at(2), crop.at(3))).clone();
        ASSERT_EQ(reference.at("bands").size(), 4u);
        for (const auto& [name, expected] : reference.at("bands").items()) {
            SCOPED_TRACE(name);
            const std::optional<WaveletBand> band = WaveletBandFromName(name);
            ASSERT_TRUE(band.has_value());
            const cv::Mat wavelet = WaveletImage(gray, *band);
            ASSERT_EQ(wavelet.type(), CV_64FC1);
            ASSERT_EQ(wavelet.size(), gray.size());
            for (int row = 0; row < wavelet.rows; ++row) {
                for (int col = 0; col < wavelet.cols; ++col) {
                    const double want = expected.at(static_cast<size_t>(row) * wavelet.cols + col);
                    // Identical on macOS arm64; room for compilers that fuse the multiply-adds
                    ASSERT_NEAR(wavelet.at<double>(row, col), want, 1e-9 * std::max(1.0, std::abs(want))) << "pixel " << col << ", " << row;
                }
            }
        }
    }
    EXPECT_THROW(WaveletImage(cv::Mat(), WaveletBand::LL), std::invalid_argument);
    EXPECT_THROW(WaveletImage(cv::Mat(4, 4, CV_8UC3), WaveletBand::LL), std::invalid_argument);
}

TEST(ImageFiltersTest, FeaturesOfWaveletImagesMatchPyRadiomics) {
    ExpectFeaturesOfFilteredImages("pyradiomics-wavelet-features.json", 4, [](const nlohmann::json& reference) {
        ImageFilterSettings filter;
        filter.type = ImageFilterType::Wavelet;
        filter.band = *WaveletBandFromName(reference.at("band"));
        return filter;
    });
}

TEST(ImageFiltersTest, FilteredSettingsAreValidatedAndRecorded) {
    AnalysisSettings settings = DefaultSettings(8);
    settings.features = {Type::Contrast, Type::Mean};
    settings.filter = ImageFilterSettings{ImageFilterType::LaplacianOfGaussian, 2.0};
    // The default fixed range assumes whole intensities
    EXPECT_THROW(ValidateSettings(settings), std::invalid_argument);
    settings.quantization.method = QuantizationMethod::FixedBinWidth;
    settings.quantization.bin_width = 10;
    EXPECT_NO_THROW(ValidateSettings(settings));
    AnalysisSettings with_lbp = settings;
    with_lbp.features.insert(Type::LbpEntropy);
    EXPECT_THROW(ValidateSettings(with_lbp), std::invalid_argument);
    AnalysisSettings with_score = settings;
    with_score.score.enabled = true;
    EXPECT_THROW(ValidateSettings(with_score), std::invalid_argument);
    AnalysisSettings no_sigma = settings;
    no_sigma.filter->sigma = 0;
    EXPECT_THROW(ValidateSettings(no_sigma), std::invalid_argument);

    const std::string json = SettingsToJson(settings);
    EXPECT_EQ(nlohmann::json::parse(json).at("filter"), nlohmann::json::parse(R"({"type": "laplacianOfGaussian", "sigma": 2.0})"));
    EXPECT_EQ(SettingsToJson(SettingsFromJson(json)), json);

    // Real quantization bounds are written as numbers, whole ones still as integers
    cv::Mat gray(40, 40, CV_8UC1);
    cv::randu(gray, 0, 256);
    const std::vector<Roi> rois = {Roi{"r", "R", "", RectangleRoi{5, 5, 30, 30}, ""}};
    const AnalysisOutput output = RunAnalysis(gray, rois, settings);
    ASSERT_EQ(output.results[0].status, MeasurementStatus::Ok) << output.results[0].error;
    const std::string results = ResultsToJson(output.results, settings, ExportContext{});
    EXPECT_EQ(ResultsToJson(ResultsFromJson(results).results, settings, ExportContext{}), results);
    EXPECT_NE(ResultsToCsv(output.results, settings, ExportContext{}).find("# filter=laplacianOfGaussian;sigma=2\n"), std::string::npos);
}

TEST(ImageFiltersTest, WaveletSettingsAreValidatedAndRecorded) {
    AnalysisSettings settings = DefaultSettings(16);
    settings.features = {Type::Contrast, Type::Mean, Type::FirstOrderEntropy};
    ImageFilterSettings wavelet;
    wavelet.type = ImageFilterType::Wavelet;
    wavelet.band = WaveletBand::HL;
    wavelet.sigma = 0; // not used by the wavelet
    settings.filter = wavelet;
    EXPECT_THROW(ValidateSettings(settings), std::invalid_argument);
    settings.quantization.method = QuantizationMethod::RoiMinMax;
    EXPECT_NO_THROW(ValidateSettings(settings));

    const std::string json = SettingsToJson(settings);
    EXPECT_EQ(nlohmann::json::parse(json).at("filter"), nlohmann::json::parse(R"({"type": "wavelet", "band": "HL"})"));
    EXPECT_EQ(SettingsToJson(SettingsFromJson(json)), json);
    nlohmann::json wrong = nlohmann::json::parse(json);
    wrong["filter"]["band"] = "LX";
    EXPECT_THROW(SettingsFromJson(wrong.dump()), std::invalid_argument);
    wrong["filter"] = {{"type", "wavelet"}, {"wavelet", "haar"}, {"band", "LL"}};
    EXPECT_THROW(SettingsFromJson(wrong.dump()), std::invalid_argument);

    cv::Mat gray(33, 27, CV_16UC1);
    cv::randu(gray, 0, 4096);
    const std::vector<Roi> rois = {Roi{"r", "R", "", EllipseRoi{13, 16, 10, 12, 20}, ""}};
    const AnalysisOutput output = RunAnalysis(gray, rois, settings);
    ASSERT_EQ(output.results[0].status, MeasurementStatus::Ok) << output.results[0].error;
    const std::string results = ResultsToJson(output.results, settings, ExportContext{});
    EXPECT_EQ(ResultsToJson(ResultsFromJson(results).results, settings, ExportContext{}), results);
    EXPECT_NE(ResultsToCsv(output.results, settings, ExportContext{}).find("# filter=wavelet;wavelet=coif1;band=HL\n"), std::string::npos);
}
