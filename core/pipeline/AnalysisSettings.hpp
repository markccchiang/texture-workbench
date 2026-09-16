#ifndef GLCM_ANALYSIS_SETTINGS_HPP_
#define GLCM_ANALYSIS_SETTINGS_HPP_

#include <optional>
#include <set>
#include <vector>

#include "analysis/Score.hpp"
#include "analysis/TextureAnalysis.hpp"
#include "imaging/ImageHeader.hpp"
#include "imaging/Quantizer.hpp"

namespace glcm {

constexpr int MIN_GRAY_LEVELS = 2;
constexpr int MAX_GRAY_LEVELS = 256;
constexpr int MAX_DISTANCE = 64;

// How per-direction values are reported in exports (the values themselves are always kept per direction)
enum class Aggregation { PerDirectionAndMean, MeanOnly, MeanAndRange };

enum class ScoreProfile {
    Calibration,    // inputs computed with the settings the coefficients were fitted with (Ng = 256, d = 1, all directions)
    CurrentSettings // inputs computed with the analysis settings
};

struct ScoreSettings {
    bool enabled = false;
    double age = 40.0;
    ScoreCoefficients coefficients;
    ScoreProfile profile = ScoreProfile::Calibration;
    // Calibration profile on 16-bit images: this intensity range is mapped linearly to 0-255 (usually the display window)
    int intensity_min = 0;
    int intensity_max = 65535;
};

struct AnalysisSettings {
    std::set<Type> features;
    int gray_levels = 32;
    QuantizationSettings quantization;
    std::vector<int> distances{1};
    std::set<Direction> directions{Direction::H, Direction::V, Direction::LD, Direction::RD};
    Aggregation aggregation = Aggregation::PerDirectionAndMean;
    LogBase log_base = LogBase::Natural;
    ScoreSettings score;
    // Resample the image and the ROIs to this pixel spacing (mm) before measuring (imaging/Resampling); needs the image's
    // pixel spacing. Absent: measure the pixels as they are.
    std::optional<PixelSpacing> resampling;
};

// Defaults for an image of the given bit depth (8 or 16): Haralick preset, Ng = 32, fixed range over the full
// intensity range of the bit depth
AnalysisSettings DefaultSettings(int bit_depth);

// Throws std::invalid_argument with a message describing the first problem found
void ValidateSettings(const AnalysisSettings& settings);

} // namespace glcm

#endif // GLCM_ANALYSIS_SETTINGS_HPP_
