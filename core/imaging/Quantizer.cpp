#include "imaging/Quantizer.hpp"

#include <algorithm>
#include <climits>
#include <cmath>
#include <cstdint>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace glcm {

namespace {

const uchar INSIDE = 255;

int PixelValue(const cv::Mat& gray, int row, int col) {
    return (gray.depth() == CV_16U) ? gray.at<uint16_t>(row, col) : gray.at<uchar>(row, col);
}

template <typename Fn>
void ForEachMaskPixel(const cv::Mat& gray, const cv::Mat& mask, Fn fn) {
    for (int row = 0; row < gray.rows; ++row) {
        const uchar* mask_line = mask.ptr<uchar>(row);
        for (int col = 0; col < gray.cols; ++col) {
            if (mask_line[col] == INSIDE) {
                fn(row, col, PixelValue(gray, row, col));
            }
        }
    }
}

} // namespace

QuantizationResult Quantize(const cv::Mat& gray, const cv::Mat& mask, int gray_levels, const QuantizationSettings& settings) {
    if (gray.empty() || gray.channels() != 1 || (gray.depth() != CV_8U && gray.depth() != CV_16U)) {
        throw std::invalid_argument("The image must be an 8- or 16-bit single-channel image");
    }
    if (mask.type() != CV_8UC1 || mask.size() != gray.size()) {
        throw std::invalid_argument("The mask must be an 8-bit single-channel image of the same size as the image");
    }
    if (gray_levels < 2 || gray_levels > 256) {
        throw std::invalid_argument("The number of gray levels must be between 2 and 256");
    }

    QuantizationResult result;
    int roi_min = INT_MAX;
    int roi_max = INT_MIN;
    ForEachMaskPixel(gray, mask, [&](int, int, int value) {
        roi_min = std::min(roi_min, value);
        roi_max = std::max(roi_max, value);
        ++result.pixels;
    });

    const bool needs_pixels = settings.method == QuantizationMethod::RoiMinMax || settings.method == QuantizationMethod::FixedBinWidth;
    if (needs_pixels && result.pixels == 0) {
        throw std::invalid_argument("The ROI contains no pixels");
    }

    switch (settings.method) {
        case QuantizationMethod::FixedRange:
            if (settings.range_max < settings.range_min) {
                throw std::invalid_argument("The quantization range maximum must not be below its minimum");
            }
            result.lower = settings.range_min;
            result.upper = settings.range_max;
            break;
        case QuantizationMethod::RoiMinMax:
            result.lower = roi_min;
            result.upper = roi_max;
            break;
        case QuantizationMethod::FixedBinWidth: {
            if (!std::isfinite(settings.bin_width) || settings.bin_width <= 0.0) {
                throw std::invalid_argument("The quantization bin width must be positive");
            }
            result.lower = roi_min;
            result.upper = roi_max;
            const double levels_needed = std::floor((roi_max - roi_min) / settings.bin_width) + 1.0;
            if (levels_needed > gray_levels) {
                std::ostringstream message;
                message << "A bin width of " << settings.bin_width << " needs ";
                // For tiny bin widths the count exceeds every integer type (and is infinite for the smallest ones)
                if (levels_needed < 1e15) {
                    message << static_cast<long long>(levels_needed);
                } else {
                    message << "more than 10^15";
                }
                message << " gray levels for this ROI, more than Ng = " << gray_levels;
                throw std::invalid_argument(message.str());
            }
            break;
        }
        case QuantizationMethod::None:
            if (result.pixels > 0 && roi_max >= gray_levels) {
                throw std::invalid_argument("Pixel value " + std::to_string(roi_max) + " is not below Ng = " + std::to_string(gray_levels) +
                                            "; choose a quantization method");
            }
            result.lower = 0;
            result.upper = gray_levels - 1;
            break;
    }

    result.image = cv::Mat::zeros(gray.size(), CV_8UC1);
    const int64_t span = static_cast<int64_t>(result.upper) - result.lower + 1;
    ForEachMaskPixel(gray, mask, [&](int row, int col, int value) {
        int level = 0;
        switch (settings.method) {
            case QuantizationMethod::FixedRange:
            case QuantizationMethod::RoiMinMax:
                if (value > result.lower) {
                    const int64_t scaled = (static_cast<int64_t>(value) - result.lower) * gray_levels / span;
                    level = static_cast<int>(std::min<int64_t>(scaled, gray_levels - 1));
                }
                break;
            case QuantizationMethod::FixedBinWidth:
                level = static_cast<int>(std::floor((value - result.lower) / settings.bin_width));
                break;
            case QuantizationMethod::None:
                level = value;
                break;
        }
        result.image.at<uchar>(row, col) = static_cast<uchar>(level);
    });

    return result;
}

namespace {

// numpy's remainder (npy_remainderf, npy_remainder): the sign of the divisor
template <typename Real>
Real Remainder(Real a, Real b) {
    Real mod = std::fmod(a, b);
    if (mod != Real(0)) {
        if ((b < Real(0)) != (mod < Real(0))) {
            mod += b;
        }
    } else {
        mod = std::copysign(Real(0), b);
    }
    return mod;
}

// PyRadiomics' getBinEdges and binImage in NumPy's arithmetic of the image's type (float32 or float64)
template <typename Real>
RealQuantizationResult QuantizeValues(const cv::Mat& image, const cv::Mat& mask, int gray_levels, const QuantizationSettings& settings) {
    RealQuantizationResult result;
    Real minimum = std::numeric_limits<Real>::infinity();
    Real maximum = -std::numeric_limits<Real>::infinity();
    for (int row = 0; row < image.rows; ++row) {
        const uchar* inside = mask.ptr<uchar>(row);
        const Real* values = image.ptr<Real>(row);
        for (int col = 0; col < image.cols; ++col) {
            if (inside[col] == INSIDE) {
                if (!std::isfinite(values[col])) {
                    throw std::invalid_argument("The image has a value that is not finite inside the ROI");
                }
                minimum = std::min(minimum, values[col]);
                maximum = std::max(maximum, values[col]);
                ++result.pixels;
            }
        }
    }
    if (result.pixels == 0) {
        throw std::invalid_argument("The ROI contains no pixels");
    }

    std::vector<Real> edges;
    switch (settings.method) {
        case QuantizationMethod::FixedBinWidth: {
            if (!std::isfinite(settings.bin_width) || settings.bin_width <= 0.0) {
                throw std::invalid_argument("The quantization bin width must be positive");
            }
            // getBinEdges: numpy.arange(lowBound, maximum + 2 w, w)
            const auto width = static_cast<Real>(settings.bin_width);
            const Real low = minimum - Remainder(minimum, width);
            const Real high = maximum + Real(2) * width;
            const double length = std::ceil(static_cast<double>((high - low) / width));
            if (!(length <= 1.0e6)) {
                throw std::invalid_argument("A bin width of " + std::to_string(settings.bin_width) +
                                            " needs more gray levels than Ng = " + std::to_string(gray_levels) + " for this ROI");
            }
            const auto count = static_cast<size_t>(length);
            // PyArray_Arange: the first two values, then start + i * delta
            const Real second = low + width;
            const Real delta = second - low;
            for (size_t i = 0; i < count; ++i) {
                edges.push_back(i == 0 ? low : i == 1 ? second : low + static_cast<Real>(i) * delta);
            }
            result.lower = low;
            break;
        }
        case QuantizationMethod::RoiMinMax: {
            // numpy.histogram(values, Ng): linspace in float64 over the range, cast to the type of the values; the last edge + 1
            double first = minimum;
            double last = maximum;
            if (first == last) {
                first -= 0.5;
                last += 0.5;
            }
            const double step = (last - first) / gray_levels;
            for (int k = 0; k <= gray_levels; ++k) {
                edges.push_back(static_cast<Real>(k == gray_levels ? last : k * step + first));
            }
            edges.back() += Real(1);
            result.lower = minimum;
            break;
        }
        default:
            throw std::invalid_argument("A real-valued image needs a fixed bin width or ROI min-max quantization");
    }
    result.upper = maximum;

    // numpy.digitize: the number of edges at or below the value; levels count from 0 here
    const auto level_of = [&edges](Real value) {
        return static_cast<int>(std::upper_bound(edges.begin(), edges.end(), value) - edges.begin()) - 1;
    };
    const int top = level_of(maximum);
    if (top >= gray_levels) {
        throw std::invalid_argument("A bin width of " + std::to_string(settings.bin_width) + " needs " + std::to_string(top + 1) +
                                    " gray levels for this ROI, more than Ng = " + std::to_string(gray_levels));
    }
    result.image = cv::Mat::zeros(image.size(), CV_8UC1);
    for (int row = 0; row < image.rows; ++row) {
        const uchar* inside = mask.ptr<uchar>(row);
        const Real* values = image.ptr<Real>(row);
        uchar* levels = result.image.ptr<uchar>(row);
        for (int col = 0; col < image.cols; ++col) {
            if (inside[col] == INSIDE) {
                levels[col] = static_cast<uchar>(std::max(0, level_of(values[col])));
            }
        }
    }
    return result;
}

} // namespace

RealQuantizationResult QuantizeReal(const cv::Mat& image, const cv::Mat& mask, int gray_levels, const QuantizationSettings& settings) {
    if (image.empty() || (image.type() != CV_32FC1 && image.type() != CV_64FC1)) {
        throw std::invalid_argument("The image must be a non-empty 32- or 64-bit floating point single-channel image");
    }
    if (mask.type() != CV_8UC1 || mask.size() != image.size()) {
        throw std::invalid_argument("The mask must be an 8-bit single-channel image of the same size as the image");
    }
    if (gray_levels < 2 || gray_levels > 256) {
        throw std::invalid_argument("The number of gray levels must be between 2 and 256");
    }
    return image.type() == CV_32FC1 ? QuantizeValues<float>(image, mask, gray_levels, settings)
                                    : QuantizeValues<double>(image, mask, gray_levels, settings);
}

} // namespace glcm
