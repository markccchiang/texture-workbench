#include "pipeline/AnalysisSettings.hpp"

#include <cmath>
#include <stdexcept>
#include <string>

#include "pipeline/FeatureCatalog.hpp"

namespace glcm {

AnalysisSettings DefaultSettings(int bit_depth) {
    if (bit_depth != 8 && bit_depth != 16) {
        throw std::invalid_argument("The bit depth must be 8 or 16");
    }

    AnalysisSettings settings;
    for (const FeaturePreset& preset : FeaturePresets()) {
        if (preset.id == "haralick") {
            settings.features = preset.features;
        }
    }
    settings.quantization.method = QuantizationMethod::FixedRange;
    settings.quantization.range_min = 0;
    settings.quantization.range_max = (bit_depth == 16) ? 65535 : 255;
    settings.score.intensity_min = 0;
    settings.score.intensity_max = settings.quantization.range_max;
    return settings;
}

void ValidateSettings(const AnalysisSettings& settings) {
    if (settings.features.empty() && !settings.score.enabled) {
        throw std::invalid_argument("Select at least one feature or enable the score");
    }
    if (settings.resampling) {
        const PixelSpacing& spacing = *settings.resampling;
        if (!(spacing.x_mm > 0.0 && spacing.x_mm <= 1e6 && spacing.y_mm > 0.0 && spacing.y_mm <= 1e6)) {
            throw std::invalid_argument("The resampled pixel spacing must be positive");
        }
    }
    if (settings.filter) {
        if (settings.filter->type == ImageFilterType::LaplacianOfGaussian &&
            !(settings.filter->sigma > 0.0 && settings.filter->sigma <= 1000.0)) {
            throw std::invalid_argument("The sigma of the Laplacian of Gaussian must be above 0 and at most 1000");
        }
        // A filtered image holds real values: only binning that does not assume whole intensities applies
        if (settings.quantization.method != QuantizationMethod::FixedBinWidth &&
            settings.quantization.method != QuantizationMethod::RoiMinMax) {
            throw std::invalid_argument("A filtered image needs a fixed bin width or ROI min-max quantization");
        }
        if (settings.score.enabled) {
            throw std::invalid_argument("The score cannot be computed on a filtered image");
        }
        for (Type type : settings.features) {
            if (FindFeature(type).group == FeatureGroup::LocalBinaryPattern) {
                throw std::invalid_argument("Local binary patterns cannot be computed on a filtered image");
            }
        }
    }
    for (Type type : settings.features) {
        FindFeature(type); // throws for Score and Age
    }

    if (settings.gray_levels < MIN_GRAY_LEVELS || settings.gray_levels > MAX_GRAY_LEVELS) {
        throw std::invalid_argument(
            "The number of gray levels must be between " + std::to_string(MIN_GRAY_LEVELS) + " and " + std::to_string(MAX_GRAY_LEVELS));
    }

    if (settings.distances.empty()) {
        throw std::invalid_argument("Select at least one distance");
    }
    std::set<int> seen_distances;
    for (int distance : settings.distances) {
        if (distance < 1 || distance > MAX_DISTANCE) {
            throw std::invalid_argument("Distances must be between 1 and " + std::to_string(MAX_DISTANCE));
        }
        if (!seen_distances.insert(distance).second) {
            throw std::invalid_argument("Distance " + std::to_string(distance) + " is listed more than once");
        }
    }

    if (settings.directions.empty()) {
        throw std::invalid_argument("Select at least one direction");
    }
    if (settings.directions.count(Direction::Avg) > 0) {
        throw std::invalid_argument("Avg is not a direction that can be computed");
    }

    switch (settings.quantization.method) {
        case QuantizationMethod::FixedRange:
            if (settings.quantization.range_max < settings.quantization.range_min) {
                throw std::invalid_argument("The quantization range maximum must not be below its minimum");
            }
            break;
        case QuantizationMethod::FixedBinWidth:
            if (!std::isfinite(settings.quantization.bin_width) || settings.quantization.bin_width <= 0.0) {
                throw std::invalid_argument("The quantization bin width must be positive");
            }
            break;
        case QuantizationMethod::RoiMinMax:
        case QuantizationMethod::None:
            break;
    }

    if (settings.score.enabled) {
        const ScoreSettings& score = settings.score;
        if (!std::isfinite(score.age) || score.age <= 0.0) {
            throw std::invalid_argument("The age must be a positive number");
        }
        const ScoreCoefficients& c = score.coefficients;
        if (!std::isfinite(c.age) || !std::isfinite(c.mean) || !std::isfinite(c.entropy) || !std::isfinite(c.contrast)) {
            throw std::invalid_argument("The score coefficients must be finite numbers");
        }
        if (score.intensity_max <= score.intensity_min) {
            throw std::invalid_argument("The score intensity range maximum must be above its minimum");
        }
    }
}

} // namespace glcm
