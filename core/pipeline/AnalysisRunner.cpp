#include "pipeline/AnalysisRunner.hpp"

#include <climits>
#include <cmath>
#include <stdexcept>

#include "analysis/FirstOrder.hpp"
#include "analysis/GrayToneDifference.hpp"
#include "analysis/LocalBinaryPattern.hpp"
#include "analysis/RunLength.hpp"
#include "analysis/Score.hpp"
#include "analysis/Shape.hpp"
#include "analysis/SizeZone.hpp"
#include "imaging/Quantizer.hpp"
#include "imaging/Resampling.hpp"

namespace glcm {

namespace {

const double NAN_VALUE = std::numeric_limits<double>::quiet_NaN();
const uchar INSIDE = 255;
const Direction DIRECTIONS[] = {Direction::H, Direction::V, Direction::LD, Direction::RD};
const std::set<Direction> ALL_DIRECTIONS{Direction::H, Direction::V, Direction::LD, Direction::RD};

void RequireAnalysableImage(const cv::Mat& gray) {
    if (gray.empty() || gray.channels() != 1 || (gray.depth() != CV_8U && gray.depth() != CV_16U)) {
        throw std::invalid_argument("The image must be a non-empty 8- or 16-bit single-channel image");
    }
}

std::string DirectionLabel(Direction direction) {
    switch (direction) {
        case Direction::H:
            return "0°";
        case Direction::V:
            return "90°";
        case Direction::LD:
            return "135°";
        case Direction::RD:
            return "45°";
        default:
            return "average";
    }
}

// The same value for the given directions, NaN for the others
Features Uniform(double value, const std::set<Direction>& directions) {
    Features features{NAN_VALUE, NAN_VALUE, NAN_VALUE, NAN_VALUE};
    for (Direction direction : directions) {
        switch (direction) {
            case Direction::H:
                features.H = value;
                break;
            case Direction::V:
                features.V = value;
                break;
            case Direction::LD:
                features.LD = value;
                break;
            case Direction::RD:
                features.RD = value;
                break;
            default:
                break;
        }
    }
    return features;
}

struct ScoreOutcome {
    Features score;
    std::vector<std::string> warnings;
};

// Score with the settings the coefficients were fitted with: Ng = 256 over 0-255, d = 1, all directions, natural log
ScoreOutcome CalibrationScore(const cv::Mat& gray, const cv::Mat& mask, const ScoreSettings& score) {
    ScoreOutcome outcome;
    cv::Mat mapped = gray;
    if (gray.depth() == CV_16U) {
        QuantizationSettings mapping;
        mapping.method = QuantizationMethod::FixedRange;
        mapping.range_min = score.intensity_min;
        mapping.range_max = score.intensity_max;
        mapped = Quantize(gray, mask, 256, mapping).image;
        outcome.warnings.push_back("The score was calibrated on 8-bit images; intensities " + std::to_string(score.intensity_min) + "–" +
                                   std::to_string(score.intensity_max) + " were mapped to 0–255 for it");
    }

    const RegionStatistics statistics = ComputeRegionStatistics(mapped, mask);
    TextureAnalysis analysis(256);
    analysis.ProcessMaskedImage(mapped, mask, 1);
    const auto values = analysis.Calculate({Type::Entropy, Type::Contrast});
    outcome.score = ComputeScore(
        score.age, Uniform(statistics.mean, ALL_DIRECTIONS), values.at(Type::Entropy), values.at(Type::Contrast), score.coefficients);
    return outcome;
}

bool MatchesScoreCalibration(const AnalysisSettings& settings, int distance, int bit_depth) {
    return bit_depth == 8 && settings.gray_levels == 256 && distance == 1 &&
           settings.quantization.method == QuantizationMethod::FixedRange && settings.quantization.range_min == 0 &&
           settings.quantization.range_max == 255 && settings.log_base == LogBase::Natural && settings.directions == ALL_DIRECTIONS;
}

// A shape moved by (dx, dy) pixels
RoiShape TranslateShape(const RoiShape& shape, double dx, double dy) {
    if (const auto* rectangle = std::get_if<RectangleRoi>(&shape)) {
        return RectangleRoi{rectangle->x + dx, rectangle->y + dy, rectangle->width, rectangle->height};
    }
    if (const auto* ellipse = std::get_if<EllipseRoi>(&shape)) {
        return EllipseRoi{ellipse->cx + dx, ellipse->cy + dy, ellipse->rx, ellipse->ry, ellipse->angle_deg};
    }
    PolygonRoi polygon = std::get<PolygonRoi>(shape);
    for (auto& point : polygon.points) {
        point = {point[0] + dx, point[1] + dy};
    }
    return polygon;
}

// Everything about an ROI that does not depend on the distance, computed once per ROI
struct PreparedRegion {
    RegionStatistics statistics;
    QuantizationResult quantized;
    std::map<Type, double> first_order;  // the requested first-order statistics
    std::map<Type, Features> run_length; // the requested run length features: they do not depend on the distance
    std::map<Type, double> size_zone;    // the requested size zone features: no direction, no distance
    std::map<Type, double> shape;        // the requested shape features: no gray levels, direction or distance
};

PreparedRegion Prepare(const cv::Mat& gray, const cv::Mat& mask, const AnalysisSettings& settings, cv::Point2d spacing) {
    PreparedRegion prepared{
        ComputeRegionStatistics(gray, mask), Quantize(gray, mask, settings.gray_levels, settings.quantization), {}, {}, {}, {}};
    std::set<Type> first_order;
    for (Type type : settings.features) {
        if (IsFirstOrderStatistic(type)) {
            first_order.insert(type);
        }
    }
    if (!first_order.empty()) {
        prepared.first_order =
            ComputeFirstOrderStatistics(gray, mask, prepared.quantized.image, settings.gray_levels, settings.log_base, first_order);
    }
    std::set<Type> run_length;
    for (Type type : settings.features) {
        if (IsRunLengthFeature(type)) {
            run_length.insert(type);
        }
    }
    if (!run_length.empty()) {
        prepared.run_length = ComputeRunLengthFeatures(
            prepared.quantized.image, mask, settings.gray_levels, settings.directions, settings.log_base, run_length);
    }
    std::set<Type> size_zone;
    for (Type type : settings.features) {
        if (IsSizeZoneFeature(type)) {
            size_zone.insert(type);
        }
    }
    if (!size_zone.empty()) {
        prepared.size_zone = ComputeSizeZoneFeatures(prepared.quantized.image, mask, settings.gray_levels, settings.log_base, size_zone);
    }
    std::set<Type> shape;
    for (Type type : settings.features) {
        if (IsShapeFeature(type)) {
            shape.insert(type);
        }
    }
    if (!shape.empty()) {
        prepared.shape = ComputeShapeFeatures(mask, spacing, shape);
    }
    return prepared;
}

void Measure(const cv::Mat& gray, const cv::Mat& mask, const PreparedRegion& prepared, int distance, const AnalysisSettings& settings,
    MeasurementResult& result) {
    const RegionStatistics& statistics = prepared.statistics;
    const QuantizationResult& quantized = prepared.quantized;
    result.quantization_lower = quantized.lower;
    result.quantization_upper = quantized.upper;

    TextureOptions options;
    options.directions = settings.directions;
    options.log_base = settings.log_base;
    TextureAnalysis analysis(settings.gray_levels, options);
    analysis.ProcessMaskedImage(quantized.image, mask, distance);

    for (int index = 0; index < 4; ++index) {
        result.pair_counts[index] = analysis.PairCount(DIRECTIONS[index]);
    }
    for (Direction direction : settings.directions) {
        if (analysis.PairCount(direction) == 0) {
            result.warnings.push_back("No pixel pairs at distance " + std::to_string(distance) + " in the " + DirectionLabel(direction) +
                                      " direction; its values come from an empty co-occurrence matrix");
        }
    }

    std::set<Type> texture_types;
    for (Type type : settings.features) {
        if (type != Type::Mean && type != Type::Std && !IsFirstOrderStatistic(type) && !IsRunLengthFeature(type) &&
            !IsSizeZoneFeature(type) && !IsGrayToneDifferenceFeature(type) && !IsLocalBinaryPatternFeature(type) && !IsShapeFeature(type)) {
            texture_types.insert(type);
        }
    }
    const bool current_settings_score = settings.score.enabled && settings.score.profile == ScoreProfile::CurrentSettings;
    std::set<Type> computed = texture_types;
    if (current_settings_score) {
        computed.insert(Type::Entropy);
        computed.insert(Type::Contrast);
    }
    const auto values = analysis.Calculate(computed);

    // Region statistics use the original intensities, not the gray levels
    if (settings.features.count(Type::Mean) > 0) {
        result.values[Type::Mean] = Uniform(statistics.mean, settings.directions);
    }
    if (settings.features.count(Type::Std) > 0) {
        result.values[Type::Std] = Uniform(statistics.std, settings.directions);
    }
    for (const auto& [type, value] : prepared.first_order) {
        result.values[type] = Uniform(value, settings.directions);
    }
    for (const auto& [type, features] : prepared.run_length) {
        result.values[type] = features;
    }
    for (const auto& [type, value] : prepared.size_zone) {
        result.values[type] = Uniform(value, settings.directions);
    }
    for (const auto& [type, value] : prepared.shape) {
        result.values[type] = Uniform(value, settings.directions);
    }
    // Gray tone difference features take their neighbourhood from the distance, but have no direction
    std::set<Type> gray_tone;
    for (Type type : settings.features) {
        if (IsGrayToneDifferenceFeature(type)) {
            gray_tone.insert(type);
        }
    }
    if (!gray_tone.empty()) {
        for (const auto& [type, value] :
            ComputeGrayToneDifferenceFeatures(quantized.image, mask, settings.gray_levels, distance, gray_tone)) {
            result.values[type] = Uniform(value, settings.directions);
        }
    }
    for (Type type : texture_types) {
        result.values[type] = values.at(type);
    }

    if (current_settings_score) {
        const ScoreSettings& score = settings.score;
        result.score = ComputeScore(score.age, Uniform(statistics.mean, settings.directions), values.at(Type::Entropy),
            values.at(Type::Contrast), score.coefficients);
        const int bit_depth = (gray.depth() == CV_16U) ? 16 : 8;
        if (!MatchesScoreCalibration(settings, distance, bit_depth)) {
            result.warnings.push_back(
                "The score coefficients were calibrated with Ng = 256, d = 1, all four directions and 8-bit images; "
                "they may not apply to the current settings");
        }
    }
}

// LBP samples the pixels around the ROI too, so it needs the whole image and the ROI's box; the radius is the distance
void AddLocalBinaryPatternFeatures(const cv::Mat& gray, const cv::Rect& box, const cv::Mat& mask, int distance,
    const AnalysisSettings& settings, MeasurementResult& result) {
    std::set<Type> types;
    for (Type type : settings.features) {
        if (IsLocalBinaryPatternFeature(type)) {
            types.insert(type);
        }
    }
    if (types.empty()) {
        return;
    }
    for (const auto& [type, value] : ComputeLocalBinaryPatternFeatures(gray, box, mask, distance, settings.log_base, types)) {
        result.values[type] = Uniform(value, settings.directions);
    }
}

} // namespace

RegionStatistics ComputeRegionStatistics(const cv::Mat& gray, const cv::Mat& mask) {
    RequireAnalysableImage(gray);
    if (mask.type() != CV_8UC1 || mask.size() != gray.size()) {
        throw std::invalid_argument("The mask must be an 8-bit single-channel image of the same size as the image");
    }

    const bool sixteen_bit = gray.depth() == CV_16U;
    auto value_at = [&](int row, int col) -> int { return sixteen_bit ? gray.at<uint16_t>(row, col) : gray.at<uchar>(row, col); };

    RegionStatistics statistics;
    double sum = 0.0;
    int min_value = INT_MAX;
    int max_value = INT_MIN;
    for (int row = 0; row < gray.rows; ++row) {
        const uchar* mask_line = mask.ptr<uchar>(row);
        for (int col = 0; col < gray.cols; ++col) {
            if (mask_line[col] == INSIDE) {
                const int value = value_at(row, col);
                sum += value;
                min_value = std::min(min_value, value);
                max_value = std::max(max_value, value);
                ++statistics.pixel_count;
            }
        }
    }
    if (statistics.pixel_count == 0) {
        return statistics;
    }

    statistics.min = min_value;
    statistics.max = max_value;
    statistics.mean = sum / statistics.pixel_count;
    if (statistics.pixel_count < 2) {
        statistics.std = 0.0;
        return statistics;
    }

    double squared_deviations = 0.0;
    for (int row = 0; row < gray.rows; ++row) {
        const uchar* mask_line = mask.ptr<uchar>(row);
        for (int col = 0; col < gray.cols; ++col) {
            if (mask_line[col] == INSIDE) {
                const double deviation = value_at(row, col) - statistics.mean;
                squared_deviations += deviation * deviation;
            }
        }
    }
    statistics.std = std::sqrt(squared_deviations / (statistics.pixel_count - 1.0));
    return statistics;
}

AnalysisOutput RunAnalysis(const cv::Mat& gray, const std::vector<Roi>& rois, const AnalysisSettings& settings,
    const ProgressCallback& progress, const std::optional<PixelSpacing>& pixel_spacing) {
    RequireAnalysableImage(gray);
    ValidateSettings(settings);
    cv::Point2d spacing = pixel_spacing ? cv::Point2d(pixel_spacing->x_mm, pixel_spacing->y_mm) : cv::Point2d(1.0, 1.0);
    if (!std::isfinite(spacing.x) || !std::isfinite(spacing.y) || spacing.x <= 0.0 || spacing.y <= 0.0) {
        throw std::invalid_argument("The pixel spacing must be positive");
    }
    if (settings.resampling) {
        if (!pixel_spacing) {
            throw std::invalid_argument("Resampling needs the image's pixel spacing");
        }
        // Measure the resampled image and the ROIs on its grid, with the new spacing
        const ResamplingGrid grid = ResampledGrid(gray.size(), *pixel_spacing, *settings.resampling);
        std::vector<Roi> resampled_rois = rois;
        // Only the pixels a measurement reads: the ROIs' boxes, and around them the local binary patterns' samples (the
        // distance, plus a pixel for interpolation). Invalid shapes are left to fail in the measurement below.
        cv::Rect needed;
        const int margin = *std::max_element(settings.distances.begin(), settings.distances.end()) + 2;
        for (Roi& roi : resampled_rois) {
            roi.shape = ResampleShape(roi.shape, grid);
            try {
                const cv::Rect box = RasterizeCroppedMask(roi.shape, grid.size).box;
                if (box.area() > 0) {
                    const cv::Rect widened(box.x - margin, box.y - margin, box.width + 2 * margin, box.height + 2 * margin);
                    needed = needed.area() > 0 ? (needed | widened) : widened;
                }
            } catch (const std::exception&) {
            }
        }
        // Measure the needed part of the grid only, with the ROIs moved onto it: it holds every pixel of every ROI on the grid
        needed &= cv::Rect(cv::Point(0, 0), grid.size);
        if (needed.area() == 0) {
            needed = cv::Rect(0, 0, 1, 1);
        }
        for (Roi& roi : resampled_rois) {
            roi.shape = TranslateShape(roi.shape, -needed.x, -needed.y);
        }
        AnalysisSettings measured = settings;
        measured.resampling.reset();
        return RunAnalysis(
            ResampleImage(gray, *pixel_spacing, *settings.resampling, needed), resampled_rois, measured, progress, settings.resampling);
    }

    AnalysisOutput output;
    const int total = static_cast<int>(rois.size() * settings.distances.size());
    int completed = 0;

    for (const Roi& roi : rois) {
        // Only the box around the ROI is rasterized and analysed: pixels outside it are outside the ROI, so gray(box) with
        // the cropped mask gives the same results as the whole image with a full-size mask
        CroppedMask cropped;
        std::string roi_error;
        try {
            cropped = RasterizeCroppedMask(roi.shape, gray.size());
        } catch (const std::exception& error) {
            roi_error = error.what();
        }
        const int pixel_count = CountMaskPixels(cropped.mask);
        const cv::Mat region = cropped.mask.empty() ? cv::Mat() : gray(cropped.box);
        const cv::Mat& mask = cropped.mask;
        std::optional<PreparedRegion> prepared;        // statistics and quantization, shared by every distance
        std::optional<ScoreOutcome> calibration_score; // computed once per ROI, shared by every distance

        for (int distance : settings.distances) {
            MeasurementResult result;
            result.roi_id = roi.id;
            result.roi_name = roi.name;
            result.roi_class = roi.class_name;
            result.distance = distance;
            result.pixel_count = pixel_count;

            if (!roi_error.empty()) {
                result.status = MeasurementStatus::Failed;
                result.error = roi_error;
            } else if (pixel_count < 2) {
                result.status = MeasurementStatus::Skipped;
                result.error = "The ROI contains fewer than 2 pixels";
            } else {
                try {
                    if (!prepared) {
                        prepared = Prepare(region, mask, settings, spacing);
                    }
                    Measure(region, mask, *prepared, distance, settings, result);
                    AddLocalBinaryPatternFeatures(gray, cropped.box, mask, distance, settings, result);
                    if (settings.score.enabled && settings.score.profile == ScoreProfile::Calibration) {
                        if (!calibration_score) {
                            calibration_score = CalibrationScore(region, mask, settings.score);
                        }
                        result.score = calibration_score->score;
                        result.warnings.insert(
                            result.warnings.end(), calibration_score->warnings.begin(), calibration_score->warnings.end());
                    }
                } catch (const std::exception& error) {
                    result.status = MeasurementStatus::Failed;
                    result.error = error.what();
                    result.values.clear();
                    result.score.reset();
                }
            }

            output.results.push_back(std::move(result));
            ++completed;
            if (progress && !progress(completed, total)) {
                output.cancelled = completed < total;
                return output;
            }
        }
    }
    return output;
}

} // namespace glcm
