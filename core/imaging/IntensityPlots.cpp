#include "imaging/IntensityPlots.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace glcm {

namespace {

void RequireImage(const cv::Mat& gray) {
    if (gray.empty() || (gray.type() != CV_8UC1 && gray.type() != CV_16UC1)) {
        throw std::invalid_argument("The image must be a non-empty 8- or 16-bit single-channel image");
    }
}

double Pixel(const cv::Mat& gray, int row, int col) {
    return gray.depth() == CV_16U ? gray.at<uint16_t>(row, col) : gray.at<uchar>(row, col);
}

// Bilinear interpolation between pixel centres, clamped to the outermost centres; NaN outside the image
double Interpolated(const cv::Mat& gray, double x, double y) {
    if (!(x >= 0 && y >= 0 && x <= gray.cols && y <= gray.rows)) {
        return std::numeric_limits<double>::quiet_NaN();
    }
    const double u = std::clamp(x - 0.5, 0.0, static_cast<double>(gray.cols - 1));
    const double v = std::clamp(y - 0.5, 0.0, static_cast<double>(gray.rows - 1));
    const int c0 = std::min(static_cast<int>(std::floor(u)), gray.cols - 1);
    const int r0 = std::min(static_cast<int>(std::floor(v)), gray.rows - 1);
    const int c1 = std::min(c0 + 1, gray.cols - 1);
    const int r1 = std::min(r0 + 1, gray.rows - 1);
    const double fx = u - c0;
    const double fy = v - r0;
    const double top = Pixel(gray, r0, c0) * (1 - fx) + Pixel(gray, r0, c1) * fx;
    const double bottom = Pixel(gray, r1, c0) * (1 - fx) + Pixel(gray, r1, c1) * fx;
    return top * (1 - fy) + bottom * fy;
}

} // namespace

LineProfile ComputeLineProfile(const cv::Mat& gray, cv::Point2d from, cv::Point2d to) {
    RequireImage(gray);
    if (!std::isfinite(from.x) || !std::isfinite(from.y) || !std::isfinite(to.x) || !std::isfinite(to.y)) {
        throw std::invalid_argument("The line's end points must be finite");
    }
    LineProfile profile;
    profile.length = std::hypot(to.x - from.x, to.y - from.y);
    if (profile.length > MAX_PROFILE_LENGTH) {
        throw std::invalid_argument("The line is longer than " + std::to_string(static_cast<int>(MAX_PROFILE_LENGTH)) + " pixels");
    }
    const auto steps = static_cast<int>(std::lround(profile.length));
    profile.step = steps > 0 ? profile.length / steps : 0;
    profile.values.reserve(static_cast<size_t>(steps) + 1);
    for (int k = 0; k <= steps; ++k) {
        const double t = steps > 0 ? static_cast<double>(k) / steps : 0;
        profile.values.push_back(Interpolated(gray, from.x + t * (to.x - from.x), from.y + t * (to.y - from.y)));
    }
    return profile;
}

RoiHistogram ComputeRoiHistogram(const cv::Mat& gray, const RoiShape& shape, int bins) {
    RequireImage(gray);
    if (bins < 1 || bins > 65536) {
        throw std::invalid_argument("The number of bins must be between 1 and 65536");
    }
    RoiHistogram histogram;
    const CroppedMask cropped = RasterizeCroppedMask(shape, gray.size());
    if (cropped.mask.empty()) {
        return histogram;
    }
    const cv::Mat region = gray(cropped.box);
    std::vector<int64_t> frequencies(gray.depth() == CV_16U ? 65536 : 256, 0);
    double sum = 0;
    for (int row = 0; row < region.rows; ++row) {
        const uchar* inside = cropped.mask.ptr<uchar>(row);
        for (int col = 0; col < region.cols; ++col) {
            if (inside[col] == 255) {
                const auto value = static_cast<int>(Pixel(region, row, col));
                ++frequencies[static_cast<size_t>(value)];
                sum += value;
                ++histogram.pixel_count;
            }
        }
    }
    if (histogram.pixel_count == 0) {
        return histogram;
    }
    const auto first = std::find_if(frequencies.begin(), frequencies.end(), [](int64_t count) { return count > 0; });
    const auto last = std::find_if(frequencies.rbegin(), frequencies.rend(), [](int64_t count) { return count > 0; });
    histogram.min = static_cast<int>(first - frequencies.begin());
    histogram.max = static_cast<int>(frequencies.rend() - last) - 1;
    histogram.mode = static_cast<int>(std::max_element(frequencies.begin(), frequencies.end()) - frequencies.begin());
    const double n = histogram.pixel_count;
    histogram.mean = sum / n;
    double deviations = 0;
    for (int value = histogram.min; value <= histogram.max; ++value) {
        const double deviation = value - histogram.mean;
        deviations += static_cast<double>(frequencies[static_cast<size_t>(value)]) * deviation * deviation;
    }
    histogram.std = histogram.pixel_count < 2 ? 0 : std::sqrt(deviations / (n - 1));

    const int range = histogram.max - histogram.min + 1;
    histogram.bin_start = histogram.min;
    histogram.bin_width = (range + bins - 1) / bins;
    const int used = (range + histogram.bin_width - 1) / histogram.bin_width;
    histogram.counts.assign(static_cast<size_t>(used), 0);
    for (int value = histogram.min; value <= histogram.max; ++value) {
        histogram.counts[static_cast<size_t>((value - histogram.min) / histogram.bin_width)] += frequencies[static_cast<size_t>(value)];
    }
    return histogram;
}

} // namespace glcm
