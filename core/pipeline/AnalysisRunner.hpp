#ifndef GLCM_ANALYSIS_RUNNER_HPP_
#define GLCM_ANALYSIS_RUNNER_HPP_

#include <array>
#include <functional>
#include <limits>
#include <map>
#include <opencv2/core.hpp>
#include <optional>
#include <string>
#include <vector>

#include "analysis/TextureAnalysis.hpp"
#include "imaging/ImageHeader.hpp"
#include "pipeline/AnalysisSettings.hpp"
#include "roi/Roi.hpp"

namespace glcm {

// Statistics of the original (unquantized) intensities inside a mask
struct RegionStatistics {
    int pixel_count = 0;
    double mean = std::numeric_limits<double>::quiet_NaN(); // NaN for an empty mask
    double std = std::numeric_limits<double>::quiet_NaN();  // sample STD; 0 for one pixel, NaN for an empty mask
    int min = 0;
    int max = 0;
};

// 8- or 16-bit single-channel image and a CV_8UC1 mask of the same size (255 = inside)
RegionStatistics ComputeRegionStatistics(const cv::Mat& gray, const cv::Mat& mask);

enum class MeasurementStatus {
    Ok,
    Skipped, // not measurable, e.g. fewer than 2 pixels
    Failed   // an error occurred; see MeasurementResult::error
};

// Result of one ROI at one distance
struct MeasurementResult {
    std::string roi_id;
    std::string roi_name;
    std::string roi_class; // the ROI's class; empty when it has none
    int distance = 0;
    MeasurementStatus status = MeasurementStatus::Ok;
    std::string error; // reason for Skipped / Failed
    int pixel_count = 0;
    std::map<Type, Features> values;   // the requested features; unselected directions hold NaN
    std::optional<Features> score;     // when the score is enabled
    std::array<int, 4> pair_counts{};  // pixel pairs per direction (H, V, LD, RD)
    double quantization_lower = 0;     // intensity mapped to gray level 0 (real on a filtered image)
    double quantization_upper = 0;     // top of the intensity range used for quantization
    std::vector<std::string> warnings; // e.g. "No pixel pairs at distance 2 in the 90° direction ..."
};

struct AnalysisOutput {
    std::vector<MeasurementResult> results; // in the order ROI 1 (every distance), ROI 2 (every distance), ...
    bool cancelled = false;
};

// Called after each ROI x distance job with the number of finished jobs; return false to cancel the remaining jobs
using ProgressCallback = std::function<bool(int completed, int total)>;

// Measures every ROI at every distance. Settings and image are validated first (std::invalid_argument); problems with
// a single ROI (e.g. too few pixels, invalid geometry, values outside the quantization) only mark its results as
// Skipped or Failed. Shape features are in millimetres with a pixel spacing and in pixels without one; a spacing that is
// not positive and finite throws std::invalid_argument.
AnalysisOutput RunAnalysis(const cv::Mat& gray, const std::vector<Roi>& rois, const AnalysisSettings& settings,
    const ProgressCallback& progress = nullptr, const std::optional<PixelSpacing>& pixel_spacing = std::nullopt);

} // namespace glcm

#endif // GLCM_ANALYSIS_RUNNER_HPP_
