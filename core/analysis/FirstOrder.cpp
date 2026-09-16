#include "analysis/FirstOrder.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <vector>

namespace glcm {

namespace {

const double NAN_VALUE = std::numeric_limits<double>::quiet_NaN();
const uchar INSIDE = 255;
// NumPy's np.spacing(1), which PyRadiomics adds inside the logarithm of the entropy
const double EPSILON = std::numeric_limits<double>::epsilon();

// Percentile with linear interpolation between the order statistics of sorted values (NumPy's default method)
double Percentile(const std::vector<double>& sorted, double percent) {
    const double position = static_cast<double>(sorted.size() - 1) * (percent / 100.0);
    const auto lower = static_cast<size_t>(std::floor(position));
    const size_t upper = std::min(lower + 1, sorted.size() - 1);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - static_cast<double>(lower));
}

} // namespace

bool IsFirstOrderStatistic(Type type) {
    switch (type) {
        case Type::Minimum:
        case Type::Maximum:
        case Type::Range:
        case Type::Median:
        case Type::Percentile10:
        case Type::Percentile90:
        case Type::InterquartileRange:
        case Type::MeanAbsoluteDeviation:
        case Type::RobustMeanAbsoluteDeviation:
        case Type::RootMeanSquared:
        case Type::FirstOrderEnergy:
        case Type::Variance:
        case Type::Skewness:
        case Type::Kurtosis:
        case Type::FirstOrderEntropy:
        case Type::Uniformity:
            return true;
        default:
            return false;
    }
}

std::map<Type, double> ComputeFirstOrderStatistics(
    const cv::Mat& gray, const cv::Mat& mask, const cv::Mat& levels, int gray_levels, LogBase log_base, const std::set<Type>& types) {
    if (gray.empty() || gray.channels() != 1 ||
        (gray.depth() != CV_8U && gray.depth() != CV_16U && gray.depth() != CV_32F && gray.depth() != CV_64F)) {
        throw std::invalid_argument("The image must be a non-empty 8-, 16-bit or floating point single-channel image");
    }
    if (mask.type() != CV_8UC1 || mask.size() != gray.size() || levels.type() != CV_8UC1 || levels.size() != gray.size()) {
        throw std::invalid_argument("The mask and the gray levels must be 8-bit single-channel images of the same size as the image");
    }
    if (gray_levels < 1) {
        throw std::invalid_argument("The number of gray levels must be positive");
    }
    for (Type type : types) {
        if (!IsFirstOrderStatistic(type)) {
            throw std::invalid_argument(TextureAnalysis::TypeToString(type) + " is not computed by ComputeFirstOrderStatistics");
        }
    }

    const bool sixteen_bit = gray.depth() == CV_16U;
    std::vector<double> values;
    std::vector<int> histogram(static_cast<size_t>(gray_levels), 0);
    for (int row = 0; row < gray.rows; ++row) {
        const uchar* mask_line = mask.ptr<uchar>(row);
        const uchar* level_line = levels.ptr<uchar>(row);
        for (int col = 0; col < gray.cols; ++col) {
            if (mask_line[col] != INSIDE) {
                continue;
            }
            if (gray.depth() == CV_32F) {
                // A filtered image: its real values (float32 or float64, as PyRadiomics has them)
                values.push_back(gray.at<float>(row, col));
            } else if (gray.depth() == CV_64F) {
                values.push_back(gray.at<double>(row, col));
            } else {
                values.push_back(sixteen_bit ? gray.at<uint16_t>(row, col) : gray.at<uchar>(row, col));
            }
            if (level_line[col] >= gray_levels) {
                throw std::invalid_argument("A gray level inside the mask is not below the number of gray levels");
            }
            ++histogram[level_line[col]];
        }
    }

    std::map<Type, double> result;
    if (values.empty()) {
        for (Type type : types) {
            result[type] = NAN_VALUE;
        }
        return result;
    }

    const auto count = static_cast<double>(values.size());
    double sum = 0.0;
    double sum_of_squares = 0.0;
    for (double value : values) {
        sum += value;
        sum_of_squares += value * value;
    }
    const double mean = sum / count;
    double second = 0.0;
    double third = 0.0;
    double fourth = 0.0;
    double absolute = 0.0;
    for (double value : values) {
        const double deviation = value - mean;
        const double squared = deviation * deviation;
        second += squared;
        third += squared * deviation;
        fourth += squared * squared;
        absolute += std::abs(deviation);
    }
    second /= count;
    third /= count;
    fourth /= count;
    absolute /= count;

    std::vector<double> sorted = values;
    std::sort(sorted.begin(), sorted.end());
    const double p10 = Percentile(sorted, 10);
    const double p90 = Percentile(sorted, 90);

    // Mean absolute deviation of the values between the 10th and 90th percentile (inclusive), from their own mean
    double robust_sum = 0.0;
    size_t robust_count = 0;
    for (double value : values) {
        if (value >= p10 && value <= p90) {
            robust_sum += value;
            ++robust_count;
        }
    }
    const double robust_mean = robust_sum / static_cast<double>(robust_count);
    double robust_absolute = 0.0;
    for (double value : values) {
        if (value >= p10 && value <= p90) {
            robust_absolute += std::abs(value - robust_mean);
        }
    }
    robust_absolute /= static_cast<double>(robust_count);

    double entropy = 0.0;
    double uniformity = 0.0;
    for (int bin_count : histogram) {
        if (bin_count == 0) {
            continue;
        }
        const double probability = bin_count / count;
        entropy -= probability * (log_base == LogBase::Two ? std::log2(probability + EPSILON) : std::log(probability + EPSILON));
        uniformity += probability * probability;
    }

    for (Type type : types) {
        switch (type) {
            case Type::Minimum:
                result[type] = sorted.front();
                break;
            case Type::Maximum:
                result[type] = sorted.back();
                break;
            case Type::Range:
                result[type] = sorted.back() - sorted.front();
                break;
            case Type::Median:
                result[type] = Percentile(sorted, 50);
                break;
            case Type::Percentile10:
                result[type] = p10;
                break;
            case Type::Percentile90:
                result[type] = p90;
                break;
            case Type::InterquartileRange:
                result[type] = Percentile(sorted, 75) - Percentile(sorted, 25);
                break;
            case Type::MeanAbsoluteDeviation:
                result[type] = absolute;
                break;
            case Type::RobustMeanAbsoluteDeviation:
                result[type] = robust_absolute;
                break;
            case Type::RootMeanSquared:
                result[type] = std::sqrt(sum_of_squares / count);
                break;
            case Type::FirstOrderEnergy:
                result[type] = sum_of_squares;
                break;
            case Type::Variance:
                result[type] = second;
                break;
            case Type::Skewness:
                result[type] = second == 0.0 ? 0.0 : third / std::pow(second, 1.5);
                break;
            case Type::Kurtosis:
                result[type] = second == 0.0 ? 0.0 : fourth / (second * second);
                break;
            case Type::FirstOrderEntropy:
                result[type] = entropy;
                break;
            case Type::Uniformity:
                result[type] = uniformity;
                break;
            default:
                break;
        }
    }
    return result;
}

} // namespace glcm
