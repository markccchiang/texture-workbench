#ifndef GLCM_RESAMPLING_HPP_
#define GLCM_RESAMPLING_HPP_

#include <climits>
#include <opencv2/core.hpp>

#include "imaging/ImageHeader.hpp"
#include "roi/Roi.hpp"

namespace glcm {

// The grid of an image resampled from one pixel spacing to another. It is aligned to the image's top left corner, as
// PyRadiomics aligns it: new pixel (k, l) covers [k * ratio_x, (k + 1) * ratio_x) x [l * ratio_y, (l + 1) * ratio_y) in
// original pixel units, with ratio = new spacing / old spacing, and the grid has ceil(size / ratio) pixels per axis.
struct ResamplingGrid {
    cv::Size size;
    double ratio_x = 1.0;
    double ratio_y = 1.0;
};

// Largest number of pixels a resampled image may have, and a resampled image that is also filtered (whole, in float32)
constexpr double MAX_RESAMPLED_PIXELS = 400.0e6;
constexpr double MAX_FILTERED_PIXELS = 64.0e6;

// Throws std::invalid_argument for spacings that are not positive and finite, and for grids larger than MAX_RESAMPLED_PIXELS
ResamplingGrid ResampledGrid(cv::Size image_size, PixelSpacing from, PixelSpacing to);

// The part of the grid on the image, from its top-left corner: the new pixels whose centres lie within the image, which
// ResampleValues interpolates (beyond it they get 0)
cv::Size ResampledValidSize(const ResamplingGrid& grid, cv::Size image_size);

// Coefficients of the cubic B-spline through the image (CV_64FC1), as ITK's BSplineDecompositionImageFilter computes them:
// mirror boundaries, pole sqrt(3) - 2, rows first and then columns. A 1-pixel axis is left as it is.
cv::Mat CubicBSplineCoefficients(const cv::Mat& gray);

// The resampled image as real values (CV_64FC1): the cubic B-spline evaluated at the centre of every new pixel, as ITK's
// BSplineInterpolateImageFunction evaluates it (SimpleITK's sitkBSpline, PyRadiomics' default interpolator). A new pixel
// whose centre lies more than half a pixel beyond the image's last pixel centre gets 0, as ITK's ResampleImageFilter gives it.
// Throws std::invalid_argument for an image that is not 8- or 16-bit single-channel, and as ResampledGrid.
// With a region (in resampled pixels), only the part of the grid inside it is returned, so memory follows the region: pixel
// (col, row) of the result is pixel (region.x + col, region.y + row) of the whole grid, with the same value.
cv::Mat ResampleValues(const cv::Mat& gray, PixelSpacing from, PixelSpacing to, const cv::Rect& region = cv::Rect(0, 0, INT_MAX, INT_MAX));

// The resampled image with the image's own depth: ResampleValues rounded to the nearest integer and clamped to the range
// of the depth. (ITK truncates instead, so SimpleITK and PyRadiomics can give 1 less where a value lies just below an integer.)
cv::Mat ResampleImage(const cv::Mat& gray, PixelSpacing from, PixelSpacing to, const cv::Rect& region = cv::Rect(0, 0, INT_MAX, INT_MAX));

// A shape in the coordinates of the resampled grid: the same region, so that a new pixel lies inside the result when its
// centre, in original pixel units, lies inside the shape. Rectangles and polygons are scaled; an ellipse becomes the ellipse
// the scaling maps it to.
RoiShape ResampleShape(const RoiShape& shape, const ResamplingGrid& grid);

} // namespace glcm

#endif // GLCM_RESAMPLING_HPP_
