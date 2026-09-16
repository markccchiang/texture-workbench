#include "TextureAnalysis.hpp"

#include <Eigen/Eigenvalues>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <functional>
#include <stdexcept>

#include "analysis/Score.hpp"

using namespace glcm;

namespace {

const int white_color = 255;
const double NAN_VALUE = std::numeric_limits<double>::quiet_NaN();

struct Offset {
    int row;
    int col;
};

// The two neighbors of a central pixel at distance d, in the order H (0), V (90), LD (135) and RD (45 degrees)
std::array<std::array<Offset, 2>, 4> NeighborOffsets(int d) {
    return {{
        {{{0, d}, {0, -d}}},
        {{{d, 0}, {-d, 0}}},
        {{{d, d}, {-d, -d}}},
        {{{d, -d}, {-d, d}}},
    }};
}

// Shannon entropy -sum v ln(v) over the positive entries
double EntropyOf(const std::vector<double>& values) {
    double entropy = 0.0;
    for (double value : values) {
        if (value > 0) {
            entropy -= value * log(value);
        }
    }
    return entropy;
}

// Correlation-type ratio. It is undefined when a standard deviation is zero (e.g. a constant region); 1 is returned
// then, as in PyRadiomics
double CorrelationRatio(double numerator, double denominator) {
    return (denominator == 0.0) ? 1.0 : numerator / denominator;
}

} // namespace

TextureAnalysis::TextureAnalysis(int Ng, const TextureOptions& options) : _Ng(Ng), _options(options) {
    if (Ng <= 0) {
        throw std::invalid_argument("Invalid Ng assignment (Ng <= 0)");
    }
    if (options.directions.empty()) {
        throw std::invalid_argument("At least one direction must be selected");
    }
    for (Direction direction : options.directions) {
        if (direction == Direction::Avg) {
            throw std::invalid_argument("Avg is not a direction that can be computed");
        }
        _enabled[static_cast<int>(direction)] = true;
    }
    _entropy_scale = (options.log_base == LogBase::Two) ? 1.0 / std::log(2.0) : 1.0;

    for (DirectionData& data : _directions) {
        data.p.assign(_Ng * _Ng, 0.0);
        data.px.assign(_Ng, 0.0);
        data.py.assign(_Ng, 0.0);
        data.p_xpy.assign(2 * _Ng - 1, 0.0);
        data.p_xny.assign(_Ng, 0.0);
    }
}

template <typename Fn>
Features TextureAnalysis::ForEachDirection(Fn fn) const {
    auto value = [&](int direction) -> double { return _enabled[direction] ? fn(_directions[direction]) : NAN_VALUE; };
    return {value(0), value(1), value(2), value(3)};
}

Features TextureAnalysis::Directional(double value) const {
    return ForEachDirection([value](const DirectionData&) { return value; });
}

void TextureAnalysis::ProcessRectImage(const cv::Mat& image, int distance) {
    Process(image, nullptr, distance);
}

void TextureAnalysis::ProcessMaskedImage(const cv::Mat& image, const cv::Mat& mask, int distance) {
    if (mask.type() != CV_8UC1 || mask.size() != image.size()) {
        throw std::invalid_argument("The mask must be an 8-bit single-channel image of the same size as the image");
    }
    Process(image, &mask, distance);
}

void TextureAnalysis::ProcessPolygonImage(const cv::Mat& original_image, const cv::Mat& mask_image, int distance) {
    ProcessMaskedImage(original_image, mask_image, distance);
}

int TextureAnalysis::PairCount(Direction direction) const {
    if (direction == Direction::Avg) {
        throw std::invalid_argument("Avg has no pair count");
    }
    return _pair_counts[static_cast<int>(direction)];
}

void TextureAnalysis::Process(const cv::Mat& image, const cv::Mat* mask, int distance) {
    if (image.type() != CV_8UC1) {
        throw std::invalid_argument("The image must be an 8-bit single-channel image (CV_8UC1)");
    }
    if (distance < 1) {
        throw std::invalid_argument("The neighborhood distance must be at least 1");
    }

    // A pixel belongs to the region if there is no mask, or its mask value is white
    auto inside = [mask](int row, int col) { return (mask == nullptr) || (mask->at<uchar>(row, col) == white_color); };

    const auto offsets = NeighborOffsets(distance);
    std::array<std::vector<int>, 4> counts;
    std::array<int, 4> totals{}; // normalization factor R of each direction
    for (int direction = 0; direction < 4; ++direction) {
        if (_enabled[direction]) {
            counts[direction].assign(_Ng * _Ng, 0);
        }
    }
    std::vector<double> pixel_values;

    // Count pairs of the central pixel (m, n) and its neighbor (k, l); both pixels must be inside the region
    for (int m = 0; m < image.rows; ++m) {
        for (int n = 0; n < image.cols; ++n) {
            if (!inside(m, n)) {
                continue;
            }

            int j = image.at<uchar>(m, n); // I(m,n)
            if (j >= _Ng) {
                throw std::out_of_range(
                    "Pixel value " + std::to_string(j) + " is out of the gray level range (Ng = " + std::to_string(_Ng) + ")");
            }
            pixel_values.push_back(j);

            for (int direction = 0; direction < 4; ++direction) {
                if (!_enabled[direction]) {
                    continue;
                }
                for (const Offset& offset : offsets[direction]) {
                    int k = m + offset.row;
                    int l = n + offset.col;
                    if (k < 0 || l < 0 || k >= image.rows || l >= image.cols || !inside(k, l)) {
                        continue;
                    }
                    int i = image.at<uchar>(k, l); // I(k,l)
                    if (i >= _Ng) {
                        continue; // reported when (k, l) is visited as a central pixel
                    }
                    ++counts[direction][i * _Ng + j];
                    ++totals[direction];
                }
            }
        }
    }

    _pair_counts = totals;
    for (int direction = 0; direction < 4; ++direction) {
        if (_enabled[direction]) {
            Normalize(_directions[direction], counts[direction], totals[direction]);
        }
    }
    CalculatePixelStatistics(pixel_values);
}

void TextureAnalysis::Normalize(DirectionData& data, const std::vector<int>& counts, int total) const {
    // A direction without any pixel pair (e.g. V in a one-row region) leaves an all-zero matrix instead of NaNs
    for (int k = 0; k < _Ng * _Ng; ++k) {
        data.p[k] = (total > 0) ? (double)counts[k] / (double)total : 0.0;
    }

    std::fill(data.px.begin(), data.px.end(), 0.0);
    std::fill(data.py.begin(), data.py.end(), 0.0);
    std::fill(data.p_xpy.begin(), data.p_xpy.end(), 0.0);
    std::fill(data.p_xny.begin(), data.p_xny.end(), 0.0);

    data.glcm_mu_i = 0.0;
    data.glcm_mu_j = 0.0;
    for (int i = 0; i < _Ng; ++i) {
        for (int j = 0; j < _Ng; ++j) {
            double value = P(data, i, j);
            data.px[i] += value;
            data.py[j] += value;
            data.p_xpy[i + j] += value;
            data.p_xny[std::abs(i - j)] += value;
            data.glcm_mu_i += i * value;
            data.glcm_mu_j += j * value;
        }
    }

    data.glcm_sigma_i = 0.0;
    data.glcm_sigma_j = 0.0;
    for (int i = 0; i < _Ng; ++i) {
        for (int j = 0; j < _Ng; ++j) {
            data.glcm_sigma_i += (i - data.glcm_mu_i) * (i - data.glcm_mu_i) * P(data, i, j);
            data.glcm_sigma_j += (j - data.glcm_mu_j) * (j - data.glcm_mu_j) * P(data, i, j);
        }
    }
    data.glcm_sigma_i = sqrt(data.glcm_sigma_i);
    data.glcm_sigma_j = sqrt(data.glcm_sigma_j);

    data.mu_x = 0.0;
    data.mu_y = 0.0;
    for (int i = 0; i < _Ng; ++i) {
        data.mu_x += i * data.px[i];
        data.mu_y += i * data.py[i];
    }

    data.sigma_x = 0.0;
    data.sigma_y = 0.0;
    for (int i = 0; i < _Ng; ++i) {
        data.sigma_x += (i - data.mu_x) * (i - data.mu_x) * data.px[i];
        data.sigma_y += (i - data.mu_y) * (i - data.mu_y) * data.py[i];
    }
    data.sigma_x = sqrt(data.sigma_x);
    data.sigma_y = sqrt(data.sigma_y);
}

void TextureAnalysis::CalculatePixelStatistics(const std::vector<double>& pixel_values) {
    if (pixel_values.empty()) {
        _pixel_values_mean = std::numeric_limits<double>::quiet_NaN();
        _pixel_values_STD = std::numeric_limits<double>::quiet_NaN();
        return;
    }

    _pixel_values_mean = 0.0;
    for (double value : pixel_values) {
        _pixel_values_mean += value;
    }
    _pixel_values_mean /= pixel_values.size();

    if (pixel_values.size() < 2) { // the sample STD needs at least two pixels
        _pixel_values_STD = 0.0;
        return;
    }

    _pixel_values_STD = 0.0;
    for (double value : pixel_values) {
        _pixel_values_STD += (value - _pixel_values_mean) * (value - _pixel_values_mean);
    }
    _pixel_values_STD = sqrt(_pixel_values_STD / (pixel_values.size() - 1.0));
}

//===============================================================================================================
// Calculate texture feature coefficients
//===============================================================================================================

void TextureAnalysis::GetMean(Features& f) const {
    f = Directional(_pixel_values_mean);
}

void TextureAnalysis::GetStd(Features& f) const {
    f = Directional(_pixel_values_STD);
}

void TextureAnalysis::GetEnergy(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) {
        double sum = 0.0;
        for (int i = 0; i < _Ng; ++i) {
            for (int j = 0; j < _Ng; ++j) {
                sum += P(d, i, j) * P(d, i, j);
            }
        }
        return sum;
    });
}

void TextureAnalysis::GetContrast(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) {
        double sum = 0.0;
        for (int n = 0; n < _Ng; ++n) {
            sum += (n * n) * d.p_xny[n];
        }
        return sum;
    });
}

void TextureAnalysis::GetContrastAnotherWay(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) {
        double sum = 0.0;
        for (int i = 0; i < _Ng; ++i) {
            for (int j = 0; j < _Ng; ++j) {
                sum += (i - j) * (i - j) * P(d, i, j);
            }
        }
        return sum;
    });
}

void TextureAnalysis::GetCorrelationI(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) {
        double sum = 0.0;
        for (int i = 0; i < _Ng; ++i) {
            for (int j = 0; j < _Ng; ++j) {
                sum += (i - d.mu_x) * (j - d.mu_y) * P(d, i, j);
            }
        }
        return CorrelationRatio(sum, d.sigma_x * d.sigma_y);
    });
}

void TextureAnalysis::GetCorrelationIAnotherWay(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) {
        double sum = 0.0;
        for (int i = 0; i < _Ng; ++i) {
            for (int j = 0; j < _Ng; ++j) {
                sum += (i - d.glcm_mu_i) * (j - d.glcm_mu_j) * P(d, i, j);
            }
        }
        return CorrelationRatio(sum, d.glcm_sigma_i * d.glcm_sigma_j);
    });
}

void TextureAnalysis::GetCorrelationII(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) {
        double sum = 0.0;
        for (int i = 0; i < _Ng; ++i) {
            for (int j = 0; j < _Ng; ++j) {
                sum += (i * j) * P(d, i, j);
            }
        }
        return CorrelationRatio(sum - (d.mu_x * d.mu_y), d.sigma_x * d.sigma_y);
    });
}

void TextureAnalysis::GetCorrelationIIAnotherWay(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) {
        double sum = 0.0;
        for (int i = 0; i < _Ng; ++i) {
            for (int j = 0; j < _Ng; ++j) {
                sum += (i * j) * P(d, i, j);
            }
        }
        return CorrelationRatio(sum - (d.glcm_mu_i * d.glcm_mu_j), d.glcm_sigma_i * d.glcm_sigma_j);
    });
}

void TextureAnalysis::GetCorrelationIII(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) {
        double sum = 0.0;
        for (int i = 0; i < _Ng; ++i) {
            for (int j = 0; j < _Ng; ++j) {
                sum += (i * j) * P(d, i, j);
            }
        }
        return CorrelationRatio(sum - (d.mu_x * d.mu_y), d.sigma_x * d.sigma_y * d.sigma_x * d.sigma_y);
    });
}

void TextureAnalysis::GetSumOfSquares(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) {
        double sum = 0.0;
        for (int i = 0; i < _Ng; ++i) {
            for (int j = 0; j < _Ng; ++j) {
                sum += (i - d.glcm_mu_i) * (i - d.glcm_mu_i) * P(d, i, j) + (j - d.glcm_mu_j) * (j - d.glcm_mu_j) * P(d, i, j);
            }
        }
        return sum;
    });
}

void TextureAnalysis::GetSumOfSquares_i(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) {
        double sum = 0.0;
        for (int i = 0; i < _Ng; ++i) {
            for (int j = 0; j < _Ng; ++j) {
                sum += (i - d.glcm_mu_i) * (i - d.glcm_mu_i) * P(d, i, j);
            }
        }
        return sum;
    });
}

void TextureAnalysis::GetSumOfSquares_j(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) {
        double sum = 0.0;
        for (int i = 0; i < _Ng; ++i) {
            for (int j = 0; j < _Ng; ++j) {
                sum += (j - d.glcm_mu_j) * (j - d.glcm_mu_j) * P(d, i, j);
            }
        }
        return sum;
    });
}

void TextureAnalysis::GetHomogeneityII(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) {
        double sum = 0.0;
        for (int i = 0; i < _Ng; ++i) {
            for (int j = 0; j < _Ng; ++j) {
                sum += P(d, i, j) / (1 + (i - j) * (i - j));
            }
        }
        return sum;
    });
}

void TextureAnalysis::GetSumAverage(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) {
        double sum = 0.0;
        for (int k = 0; k < (2 * _Ng - 1); ++k) {
            sum += k * d.p_xpy[k];
        }
        return sum;
    });
}

void TextureAnalysis::GetSumVariance(Features& f) const {
    // Center on the Sum Average (Haralick's paper prints Sum Entropy here, which is a known typo)
    f = ForEachDirection([this](const DirectionData& d) {
        double sum_average = 0.0;
        for (int k = 0; k < (2 * _Ng - 1); ++k) {
            sum_average += k * d.p_xpy[k];
        }
        double variance = 0.0;
        for (int k = 0; k < (2 * _Ng - 1); ++k) {
            variance += (k - sum_average) * (k - sum_average) * d.p_xpy[k];
        }
        return variance;
    });
}

void TextureAnalysis::GetSumEntropy(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) { return EntropyOf(d.p_xpy) * _entropy_scale; });
}

void TextureAnalysis::GetEntropy(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) { return EntropyOf(d.p) * _entropy_scale; });
}

void TextureAnalysis::GetDifferenceVariance(Features& f) const {
    // Variance of p_{x-y}: sum_k (k - mu_{x-y})^2 p_{x-y}(k)
    f = ForEachDirection([this](const DirectionData& d) {
        double mean = 0.0;
        for (int k = 0; k < _Ng; ++k) {
            mean += k * d.p_xny[k];
        }
        double variance = 0.0;
        for (int k = 0; k < _Ng; ++k) {
            variance += (k - mean) * (k - mean) * d.p_xny[k];
        }
        return variance;
    });
}

void TextureAnalysis::GetDifferenceEntropy(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) { return EntropyOf(d.p_xny) * _entropy_scale; });
}

void TextureAnalysis::GetInformationMeasuresOfCorrelation(Features& f1, Features& f2) const {
    struct Entropies {
        double HX;
        double HY;
        double HXY;
        double HXY1;
        double HXY2;
    };

    // Undefined cases return 0, as in PyRadiomics: a single gray level (HX = HY = 0) for IMC1, and a negative value under
    // the square root, which only comes from rounding, for IMC2
    auto first = [](const Entropies& e) {
        double max_entropy = std::max(e.HX, e.HY);
        return (max_entropy == 0.0) ? 0.0 : (e.HXY - e.HXY1) / max_entropy;
    };
    auto second = [](const Entropies& e) {
        double value = 1.0 - exp(-2.0 * (e.HXY2 - e.HXY));
        return (value < 0.0) ? 0.0 : sqrt(value);
    };

    std::array<double, 4> imc1{};
    std::array<double, 4> imc2{};
    for (int direction = 0; direction < 4; ++direction) {
        if (!_enabled[direction]) {
            imc1[direction] = NAN_VALUE;
            imc2[direction] = NAN_VALUE;
            continue;
        }

        const DirectionData& d = _directions[direction];
        Entropies e{EntropyOf(d.px), EntropyOf(d.py), EntropyOf(d.p), 0.0, 0.0};
        for (int i = 0; i < _Ng; ++i) {
            for (int j = 0; j < _Ng; ++j) {
                double pxpy = d.px[i] * d.py[j];
                if (pxpy > 0) {
                    e.HXY1 -= P(d, i, j) * log(pxpy);
                    e.HXY2 -= pxpy * log(pxpy);
                }
            }
        }

        // Entropies in the selected log base
        e.HX *= _entropy_scale;
        e.HY *= _entropy_scale;
        e.HXY *= _entropy_scale;
        e.HXY1 *= _entropy_scale;
        e.HXY2 *= _entropy_scale;

        imc1[direction] = first(e);
        imc2[direction] = second(e);
    }

    f1 = {imc1[0], imc1[1], imc1[2], imc1[3]};
    f2 = {imc2[0], imc2[1], imc2[2], imc2[3]};
}

void TextureAnalysis::GetMaximalCorrelationCoefficient(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) {
        if (_Ng < 2) {
            return std::numeric_limits<double>::quiet_NaN();
        }

        // Q(i, j) = sum_k p(i, k) p(j, k) / (p_x(i) p_y(k))
        Eigen::MatrixXd Q(_Ng, _Ng);
        for (int i = 0; i < _Ng; ++i) {
            for (int j = 0; j < _Ng; ++j) {
                double q = 0.0;
                for (int k = 0; k < _Ng; ++k) {
                    if ((d.px[i] * d.py[k]) != 0) {
                        q += (P(d, i, k) * P(d, j, k)) / (d.px[i] * d.py[k]);
                    }
                }
                Q(i, j) = q;
            }
        }

        Eigen::EigenSolver<Eigen::MatrixXd> eigen_solver(Q);
        std::vector<double> eigens;
        for (int i = 0; i < _Ng; ++i) {
            eigens.push_back(eigen_solver.eigenvalues()[i].real());
        }

        // square root of the second largest eigenvalue; a negative eigenvalue can only come from rounding
        std::nth_element(eigens.begin(), eigens.begin() + 1, eigens.end(), std::greater<double>());
        return sqrt(std::max(eigens[1], 0.0));
    });
}

void TextureAnalysis::GetAutoCorrelation(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) {
        double sum = 0.0;
        for (int i = 0; i < _Ng; ++i) {
            for (int j = 0; j < _Ng; ++j) {
                sum += i * j * P(d, i, j);
            }
        }
        return sum;
    });
}

void TextureAnalysis::GetClusterProminence(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) {
        double sum = 0.0;
        for (int i = 0; i < _Ng; ++i) {
            for (int j = 0; j < _Ng; ++j) {
                sum += pow((i + j - d.mu_x - d.mu_y), 4) * P(d, i, j);
            }
        }
        return sum;
    });
}

void TextureAnalysis::GetClusterShade(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) {
        double sum = 0.0;
        for (int i = 0; i < _Ng; ++i) {
            for (int j = 0; j < _Ng; ++j) {
                sum += pow((i + j - d.mu_x - d.mu_y), 3) * P(d, i, j);
            }
        }
        return sum;
    });
}

void TextureAnalysis::GetDissimilarity(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) {
        double sum = 0.0;
        for (int i = 0; i < _Ng; ++i) {
            for (int j = 0; j < _Ng; ++j) {
                sum += fabs(i - j) * P(d, i, j);
            }
        }
        return sum;
    });
}

void TextureAnalysis::GetHomogeneityI(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) {
        double sum = 0.0;
        for (int i = 0; i < _Ng; ++i) {
            for (int j = 0; j < _Ng; ++j) {
                sum += P(d, i, j) / (1 + fabs(i - j));
            }
        }
        return sum;
    });
}

void TextureAnalysis::GetMaximumProbability(Features& f) const {
    f = ForEachDirection([](const DirectionData& d) { return *std::max_element(d.p.begin(), d.p.end()); });
}

void TextureAnalysis::GetInverseDifferenceNormalized(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) {
        // IDN = sum p(i,j) / (1 + |i - j| / Ng)
        double sum = 0.0;
        for (int i = 0; i < _Ng; ++i) {
            for (int j = 0; j < _Ng; ++j) {
                sum += P(d, i, j) / (1.0 + std::abs(i - j) / (double)_Ng);
            }
        }
        return sum;
    });
}

void TextureAnalysis::GetInverseDifferenceMomentNormalized(Features& f) const {
    f = ForEachDirection([this](const DirectionData& d) {
        // IDMN = sum p(i,j) / (1 + (i - j)^2 / Ng^2)
        double sum = 0.0;
        for (int i = 0; i < _Ng; ++i) {
            for (int j = 0; j < _Ng; ++j) {
                sum += P(d, i, j) / (1.0 + (i - j) * (i - j) / ((double)_Ng * _Ng));
            }
        }
        return sum;
    });
}

std::map<Type, Features> TextureAnalysis::Calculate(const std::set<Type>& types) const {
    std::map<Type, Features> results;
    for (auto type : types) {
        switch (type) {
            case Type::Mean:
                GetMean(results[Type::Mean]);
                break;
            case Type::Std:
                GetStd(results[Type::Std]);
                break;
            case Type::AutoCorrelation:
                GetAutoCorrelation(results[Type::AutoCorrelation]);
                break;
            case Type::Contrast:
                GetContrast(results[Type::Contrast]);
                break;
            case Type::ContrastAnotherWay:
                GetContrastAnotherWay(results[Type::ContrastAnotherWay]);
                break;
            case Type::CorrelationI:
                GetCorrelationI(results[Type::CorrelationI]);
                break;
            case Type::CorrelationIAnotherWay:
                GetCorrelationIAnotherWay(results[Type::CorrelationIAnotherWay]);
                break;
            case Type::CorrelationII:
                GetCorrelationII(results[Type::CorrelationII]);
                break;
            case Type::CorrelationIIAnotherWay:
                GetCorrelationIIAnotherWay(results[Type::CorrelationIIAnotherWay]);
                break;
            case Type::CorrelationIII:
                GetCorrelationIII(results[Type::CorrelationIII]);
                break;
            case Type::ClusterProminence:
                GetClusterProminence(results[Type::ClusterProminence]);
                break;
            case Type::ClusterShade:
                GetClusterShade(results[Type::ClusterShade]);
                break;
            case Type::Dissimilarity:
                GetDissimilarity(results[Type::Dissimilarity]);
                break;
            case Type::Energy:
                GetEnergy(results[Type::Energy]);
                break;
            case Type::Entropy:
                GetEntropy(results[Type::Entropy]);
                break;
            case Type::HomogeneityI:
                GetHomogeneityI(results[Type::HomogeneityI]);
                break;
            case Type::HomogeneityII:
                GetHomogeneityII(results[Type::HomogeneityII]);
                break;
            case Type::MaximumProbability:
                GetMaximumProbability(results[Type::MaximumProbability]);
                break;
            case Type::SumOfSquares:
                GetSumOfSquares(results[Type::SumOfSquares]);
                break;
            case Type::SumOfSquaresI:
                GetSumOfSquares_i(results[Type::SumOfSquaresI]);
                break;
            case Type::SumOfSquaresJ:
                GetSumOfSquares_j(results[Type::SumOfSquaresJ]);
                break;
            case Type::SumAverage:
                GetSumAverage(results[Type::SumAverage]);
                break;
            case Type::SumEntropy:
                GetSumEntropy(results[Type::SumEntropy]);
                break;
            case Type::SumVariance:
                GetSumVariance(results[Type::SumVariance]);
                break;
            case Type::DifferenceVariance:
                GetDifferenceVariance(results[Type::DifferenceVariance]);
                break;
            case Type::DifferenceEntropy:
                GetDifferenceEntropy(results[Type::DifferenceEntropy]);
                break;
            case Type::InformationMeasuresOfCorrelationI:
            case Type::InformationMeasuresOfCorrelationII:
                // both measures come from one calculation
                GetInformationMeasuresOfCorrelation(
                    results[Type::InformationMeasuresOfCorrelationI], results[Type::InformationMeasuresOfCorrelationII]);
                break;
            case Type::InverseDifferenceNormalized:
                GetInverseDifferenceNormalized(results[Type::InverseDifferenceNormalized]);
                break;
            case Type::InverseDifferenceMomentNormalized:
                GetInverseDifferenceMomentNormalized(results[Type::InverseDifferenceMomentNormalized]);
                break;
            case Type::MaximalCorrelationCoefficient:
                GetMaximalCorrelationCoefficient(results[Type::MaximalCorrelationCoefficient]);
                break;
            default:
                std::cerr << "Unknown feature type!\n";
                break;
        }
    }

    return results;
}

void TextureAnalysis::CalculateScore(double age, std::map<Type, Features>& features_map) const {
    if ((age > 0) && features_map.count(Type::Mean) && features_map.count(Type::Entropy) && features_map.count(Type::Contrast)) {
        features_map[Type::Score] =
            ComputeScore(age, features_map.at(Type::Mean), features_map.at(Type::Entropy), features_map.at(Type::Contrast));
        features_map[Type::Age] = Directional(age);
    } else {
        std::cerr << "Can not calculate the Score!\n";
    }
}

std::string TextureAnalysis::TypeToString(Type type) {
    switch (type) {
        case Type::Mean:
            return "Mean";
        case Type::Std:
            return "STD";
        case Type::AutoCorrelation:
            return "Auto Correlation";
        case Type::Contrast:
            return "Contrast";
        case Type::ContrastAnotherWay:
            return "Contrast (Check)";
        case Type::CorrelationI:
            return "Correlation I";
        case Type::CorrelationIAnotherWay:
            return "Correlation I (Check)";
        case Type::CorrelationII:
            return "Correlation II";
        case Type::CorrelationIIAnotherWay:
            return "Correlation II (Check)";
        case Type::CorrelationIII:
            return "Correlation III";
        case Type::ClusterProminence:
            return "Cluster Prominence";
        case Type::ClusterShade:
            return "Cluster Shade";
        case Type::Dissimilarity:
            return "Dissimilarity";
        case Type::Energy:
            return "Energy";
        case Type::Entropy:
            return "Entropy";
        case Type::HomogeneityI:
            return "Homogeneity I";
        case Type::HomogeneityII:
            return "Homogeneity II (Inverse Difference Moment)";
        case Type::MaximumProbability:
            return "Maximum Probability";
        case Type::SumOfSquares:
            return "Sum of Squares (in x and y)";
        case Type::SumOfSquaresI:
            return "Sum of Squares (in x)";
        case Type::SumOfSquaresJ:
            return "Sum of Squares (in y)";
        case Type::SumAverage:
            return "Sum Average";
        case Type::SumEntropy:
            return "Sum Entropy";
        case Type::SumVariance:
            return "Sum Variance";
        case Type::DifferenceVariance:
            return "Difference Variance";
        case Type::DifferenceEntropy:
            return "Difference Entropy";
        case Type::InformationMeasuresOfCorrelationI:
            return "Information Measures of Correlation I";
        case Type::InformationMeasuresOfCorrelationII:
            return "Information Measures of Correlation II";
        case Type::InverseDifferenceNormalized:
            return "Inverse Difference Normalized";
        case Type::InverseDifferenceMomentNormalized:
            return "Inverse Difference Moment Normalized";
        case Type::MaximalCorrelationCoefficient:
            return "Maximal Correlation Coefficient";
        case Type::Minimum:
            return "Minimum";
        case Type::Maximum:
            return "Maximum";
        case Type::Range:
            return "Range";
        case Type::Median:
            return "Median";
        case Type::Percentile10:
            return "10th Percentile";
        case Type::Percentile90:
            return "90th Percentile";
        case Type::InterquartileRange:
            return "Interquartile Range";
        case Type::MeanAbsoluteDeviation:
            return "Mean Absolute Deviation";
        case Type::RobustMeanAbsoluteDeviation:
            return "Robust Mean Absolute Deviation";
        case Type::RootMeanSquared:
            return "Root Mean Squared";
        case Type::FirstOrderEnergy:
            return "Energy (first-order)";
        case Type::Variance:
            return "Variance";
        case Type::Skewness:
            return "Skewness";
        case Type::Kurtosis:
            return "Kurtosis";
        case Type::FirstOrderEntropy:
            return "Entropy (first-order)";
        case Type::Uniformity:
            return "Uniformity";
        case Type::GlrlmShortRunEmphasis:
            return "Short Run Emphasis";
        case Type::GlrlmLongRunEmphasis:
            return "Long Run Emphasis";
        case Type::GlrlmGrayLevelNonUniformity:
            return "Gray Level Non-Uniformity (GLRLM)";
        case Type::GlrlmGrayLevelNonUniformityNormalized:
            return "Gray Level Non-Uniformity Normalized (GLRLM)";
        case Type::GlrlmRunLengthNonUniformity:
            return "Run Length Non-Uniformity";
        case Type::GlrlmRunLengthNonUniformityNormalized:
            return "Run Length Non-Uniformity Normalized";
        case Type::GlrlmRunPercentage:
            return "Run Percentage";
        case Type::GlrlmGrayLevelVariance:
            return "Gray Level Variance (GLRLM)";
        case Type::GlrlmRunVariance:
            return "Run Variance";
        case Type::GlrlmRunEntropy:
            return "Run Entropy";
        case Type::GlrlmLowGrayLevelRunEmphasis:
            return "Low Gray Level Run Emphasis";
        case Type::GlrlmHighGrayLevelRunEmphasis:
            return "High Gray Level Run Emphasis";
        case Type::GlrlmShortRunLowGrayLevelEmphasis:
            return "Short Run Low Gray Level Emphasis";
        case Type::GlrlmShortRunHighGrayLevelEmphasis:
            return "Short Run High Gray Level Emphasis";
        case Type::GlrlmLongRunLowGrayLevelEmphasis:
            return "Long Run Low Gray Level Emphasis";
        case Type::GlrlmLongRunHighGrayLevelEmphasis:
            return "Long Run High Gray Level Emphasis";
        case Type::GlszmSmallAreaEmphasis:
            return "Small Area Emphasis";
        case Type::GlszmLargeAreaEmphasis:
            return "Large Area Emphasis";
        case Type::GlszmGrayLevelNonUniformity:
            return "Gray Level Non-Uniformity (GLSZM)";
        case Type::GlszmGrayLevelNonUniformityNormalized:
            return "Gray Level Non-Uniformity Normalized (GLSZM)";
        case Type::GlszmSizeZoneNonUniformity:
            return "Size Zone Non-Uniformity";
        case Type::GlszmSizeZoneNonUniformityNormalized:
            return "Size Zone Non-Uniformity Normalized";
        case Type::GlszmZonePercentage:
            return "Zone Percentage";
        case Type::GlszmGrayLevelVariance:
            return "Gray Level Variance (GLSZM)";
        case Type::GlszmZoneVariance:
            return "Zone Variance";
        case Type::GlszmZoneEntropy:
            return "Zone Entropy";
        case Type::GlszmLowGrayLevelZoneEmphasis:
            return "Low Gray Level Zone Emphasis";
        case Type::GlszmHighGrayLevelZoneEmphasis:
            return "High Gray Level Zone Emphasis";
        case Type::GlszmSmallAreaLowGrayLevelEmphasis:
            return "Small Area Low Gray Level Emphasis";
        case Type::GlszmSmallAreaHighGrayLevelEmphasis:
            return "Small Area High Gray Level Emphasis";
        case Type::GlszmLargeAreaLowGrayLevelEmphasis:
            return "Large Area Low Gray Level Emphasis";
        case Type::GlszmLargeAreaHighGrayLevelEmphasis:
            return "Large Area High Gray Level Emphasis";
        case Type::NgtdmCoarseness:
            return "Coarseness";
        case Type::NgtdmContrast:
            return "Contrast (NGTDM)";
        case Type::NgtdmBusyness:
            return "Busyness";
        case Type::NgtdmComplexity:
            return "Complexity";
        case Type::NgtdmStrength:
            return "Strength";
        case Type::LbpUniform0:
            return "LBP Uniform 0";
        case Type::LbpUniform1:
            return "LBP Uniform 1";
        case Type::LbpUniform2:
            return "LBP Uniform 2";
        case Type::LbpUniform3:
            return "LBP Uniform 3";
        case Type::LbpUniform4:
            return "LBP Uniform 4";
        case Type::LbpUniform5:
            return "LBP Uniform 5";
        case Type::LbpUniform6:
            return "LBP Uniform 6";
        case Type::LbpUniform7:
            return "LBP Uniform 7";
        case Type::LbpUniform8:
            return "LBP Uniform 8";
        case Type::LbpNonUniform:
            return "LBP Non-Uniform";
        case Type::LbpEntropy:
            return "LBP Entropy";
        case Type::LbpEnergy:
            return "LBP Energy";
        case Type::ShapeMeshSurface:
            return "Mesh Surface";
        case Type::ShapePixelSurface:
            return "Pixel Surface";
        case Type::ShapePerimeter:
            return "Perimeter";
        case Type::ShapePerimeterSurfaceRatio:
            return "Perimeter to Surface Ratio";
        case Type::ShapeSphericity:
            return "Sphericity";
        case Type::ShapeMaximumDiameter:
            return "Maximum 2D Diameter";
        case Type::ShapeMajorAxisLength:
            return "Major Axis Length";
        case Type::ShapeMinorAxisLength:
            return "Minor Axis Length";
        case Type::ShapeElongation:
            return "Elongation";
        case Type::Score:
            return "Score";
        case Type::Age:
            return "Age";
    }
    std::cerr << "Unknown feature type!\n";
    return "";
}

std::string TextureAnalysis::DirectionToString(Direction direction) {
    switch (direction) {
        case Direction::H:
            return "H (0 deg)";
        case Direction::V:
            return "V (90 deg)";
        case Direction::LD:
            return "LD (135 deg)";
        case Direction::RD:
            return "RD (45 deg)";
        case Direction::Avg:
            return "Average";
    }
    std::cerr << "Unknown direction!\n";
    return "";
}
