#ifndef GLCM_IMAGE_FILTERS_HPP_
#define GLCM_IMAGE_FILTERS_HPP_

#include <opencv2/core.hpp>
#include <optional>
#include <string>

namespace glcm {

// Laplacian of Gaussian of a single-channel image, as PyRadiomics' getLoGImage computes it: ITK's
// LaplacianRecursiveGaussianImageFilter with NormalizeAcrossScale, a sum over both axes of the second derivative of a Gaussian
// along the axis and the Gaussian along the other, each a fourth-order recursive (Deriche) approximation with the edge value
// extended beyond the image, and the results kept as float32 between the passes as ITK keeps them. `sigma` and `spacing`
// (spacing.x between columns, spacing.y between rows) use the same unit: millimetres, or pixels with (1, 1). The result is
// CV_32FC1 and has the image's size. Throws std::invalid_argument for an image that is not single-channel with 8, 16, 32 or
// 64 bits, fewer than 4 pixels along an axis, or a sigma or spacing that is not positive and finite.
cv::Mat LaplacianOfGaussian(const cv::Mat& image, cv::Point2d spacing, double sigma);

// The sub-bands of a one-level wavelet decomposition; the first letter is the filter along x (between columns), the second along
// y (between rows): L low-pass, H high-pass
enum class WaveletBand { LL, LH, HL, HH };

// "LL", "LH", "HL" or "HH"
const char* WaveletBandName(WaveletBand band);
std::optional<WaveletBand> WaveletBandFromName(const std::string& name);

// One sub-band of the stationary (undecimated) wavelet transform of a single-channel image with the Coiflet 1 wavelet, as
// PyRadiomics' getWaveletImage computes it with PyWavelets' swtn (level 1, start level 0): an axis of odd length is first
// extended periodically by one pixel, each axis is convolved with the decomposition filter (x first, then y) with periodic
// boundaries, and the extra pixel is removed again. The result is CV_64FC1 and has the image's size. Throws
// std::invalid_argument for an image that is not single-channel with 8, 16, 32 or 64 bits.
cv::Mat WaveletImage(const cv::Mat& image, WaveletBand band);

} // namespace glcm

#endif // GLCM_IMAGE_FILTERS_HPP_
