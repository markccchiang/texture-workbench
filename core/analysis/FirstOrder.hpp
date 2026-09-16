#ifndef GLCM_FIRST_ORDER_HPP_
#define GLCM_FIRST_ORDER_HPP_

#include <map>
#include <opencv2/core.hpp>
#include <set>

#include "analysis/TextureAnalysis.hpp"

namespace glcm {

// The feature types computed by ComputeFirstOrderStatistics. Mean and Std are first-order statistics too, but the
// analysis pipeline computes them with the region statistics (pipeline/AnalysisRunner).
bool IsFirstOrderStatistic(Type type);

// First-order statistics of the pixels inside the mask (255), defined as in PyRadiomics (doc/equations.rst,
// "First-order statistics"): FirstOrderEntropy and Uniformity from the histogram of the quantized gray levels in levels
// (each below gray_levels), all others from the original 8- or 16-bit intensities in gray, or the values of a filtered
// CV_32F image. Percentiles interpolate
// linearly between order statistics; Variance, Skewness and Kurtosis use population moments, and Skewness and Kurtosis
// are 0 for a constant region. Every value is NaN for an empty mask.
// Throws std::invalid_argument for images of the wrong type or size, a gray level of gray_levels or more, or a type
// that IsFirstOrderStatistic does not accept.
std::map<Type, double> ComputeFirstOrderStatistics(const cv::Mat& gray, const cv::Mat& mask, const cv::Mat& levels, int gray_levels,
    LogBase log_base, const std::set<Type>& types);

} // namespace glcm

#endif // GLCM_FIRST_ORDER_HPP_
