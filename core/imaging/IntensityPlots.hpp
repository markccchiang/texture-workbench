#ifndef GLCM_INTENSITY_PLOTS_HPP_
#define GLCM_INTENSITY_PLOTS_HPP_

#include <cstdint>
#include <opencv2/core.hpp>
#include <vector>

#include "roi/Roi.hpp"

namespace glcm {

// The intensities along a straight line of an 8- or 16-bit image (ImageJ's Plot Profile)
struct LineProfile {
    // round(L) + 1 samples evenly spaced from the start to the end (one for a line of length L < 0.5), each interpolated
    // bilinearly between the four nearest pixel centres; NaN where the sample lies outside the image
    std::vector<double> values;
    double length = 0; // L, in pixels
    double step = 0;   // the distance between samples, in pixels: L / round(L) (0 for a single sample)
};

// Line profile between two points in image coordinates (pixel (c, r) covers [c, c + 1) × [r, r + 1), its centre is
// (c + 0.5, r + 0.5)). Between the outermost pixel centres and the image edge the nearest centre's value is used.
// Throws std::invalid_argument for another image type, non-finite points, or a line longer than MAX_PROFILE_LENGTH.
LineProfile ComputeLineProfile(const cv::Mat& gray, cv::Point2d from, cv::Point2d to);

inline constexpr double MAX_PROFILE_LENGTH = 100000;

// The histogram of the pixels of an ROI
struct RoiHistogram {
    int pixel_count = 0;
    int min = 0;
    int max = 0;
    double mean = 0;
    double std = 0; // sample standard deviation, 0 for one pixel
    int mode = 0;   // the most frequent value (the lowest of equally frequent ones)
    // counts[i] is the number of pixels with bin_start + i · bin_width <= value < bin_start + (i + 1) · bin_width; the
    // bins cover min–max with the smallest whole bin width that needs at most the requested number of bins
    int bin_start = 0;
    int bin_width = 1;
    std::vector<int64_t> counts;
};

// Histogram of the pixels whose centres lie inside the shape (RasterizeMask's rule), in at most `bins` bins (1–65536).
// An ROI without pixels gives pixel_count 0 and no counts. Throws std::invalid_argument for another image type, an
// invalid shape or bin count.
RoiHistogram ComputeRoiHistogram(const cv::Mat& gray, const RoiShape& shape, int bins);

} // namespace glcm

#endif // GLCM_INTENSITY_PLOTS_HPP_
