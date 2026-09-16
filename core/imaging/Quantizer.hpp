#ifndef GLCM_QUANTIZER_HPP_
#define GLCM_QUANTIZER_HPP_

#include <opencv2/core.hpp>

namespace glcm {

enum class QuantizationMethod { FixedRange, RoiMinMax, FixedBinWidth, None };

struct QuantizationSettings {
    QuantizationMethod method = QuantizationMethod::FixedRange;
    int range_min = 0;      // FixedRange: intensity mapped to level 0
    int range_max = 255;    // FixedRange: intensity mapped to level Ng - 1
    double bin_width = 1.0; // FixedBinWidth: intensity width of one gray level, starting at the ROI minimum
};

struct QuantizationResult {
    cv::Mat image;  // CV_8UC1: levels in [0, Ng) inside the mask, 0 outside
    int lower = 0;  // intensity mapped to level 0
    int upper = 0;  // top of the intensity range that was used
    int pixels = 0; // number of mask pixels
};

// Maps the pixels inside the mask (value 255) of an 8- or 16-bit single-channel image to Ng gray levels:
// - FixedRange:    level = floor((v - range_min) * Ng / (range_max - range_min + 1)), clamped to [0, Ng - 1]
// - RoiMinMax:     FixedRange with the minimum and maximum of the pixels inside the mask
// - FixedBinWidth: level = floor((v - ROI minimum) / bin_width); throws if the ROI needs more than Ng levels
// - None:          level = v; throws if a value inside the mask is Ng or more
// Throws std::invalid_argument for an invalid image, mask, Ng (2..256) or settings, or an empty mask with RoiMinMax or
// FixedBinWidth.
QuantizationResult Quantize(const cv::Mat& gray, const cv::Mat& mask, int gray_levels, const QuantizationSettings& settings);

// Gray levels of a real-valued image (a filtered image)
struct RealQuantizationResult {
    cv::Mat image;      // CV_8UC1: levels in [0, Ng) inside the mask, 0 outside
    double lower = 0.0; // lowest bin edge
    double upper = 0.0; // highest value inside the mask
    int pixels = 0;
};

// Maps the pixels inside the mask of a CV_32FC1 or CV_64FC1 image to gray levels as PyRadiomics' binImage does, with NumPy's
// arithmetic of the image's type (a Laplacian of Gaussian image is float32 there, a wavelet image float64):
// - FixedBinWidth w (binWidth): bin edges at lowBound + k·w with lowBound = min − (min mod w), so bins are aligned to
//   multiples of w, and level = (number of edges ≤ v) − 1; throws if the ROI needs more than Ng levels
// - RoiMinMax (binCount = Ng): Ng equal bins from the minimum to the maximum, the maximum in the last bin
// Other methods need whole intensities and throw. Throws std::invalid_argument for another image type, a mask of another size
// or type, an empty mask, or Ng outside 2..256.
RealQuantizationResult QuantizeReal(const cv::Mat& image, const cv::Mat& mask, int gray_levels, const QuantizationSettings& settings);

} // namespace glcm

#endif // GLCM_QUANTIZER_HPP_
