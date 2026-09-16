#include "imaging/ImageFilters.hpp"

#include <array>
#include <cmath>
#include <cstddef>
#include <initializer_list>
#include <stdexcept>
#include <vector>

namespace glcm {

namespace {

enum class GaussianOrder { Zero, Second };

// The coefficients of itk::RecursiveGaussianImageFilter for one axis (SetUp, ComputeNCoefficients, ComputeDCoefficients and
// ComputeRemainingCoefficients of ITK 5.4)
struct RecursiveGaussian {
    double n0 = 1.0, n1 = 1.0, n2 = 1.0, n3 = 1.0;
    double d1 = 0.0, d2 = 0.0, d3 = 0.0, d4 = 0.0;
    double m1 = 0.0, m2 = 0.0, m3 = 0.0, m4 = 0.0;
    double bn1 = 0.0, bn2 = 0.0, bn3 = 0.0, bn4 = 0.0;
    double bm1 = 0.0, bm2 = 0.0, bm3 = 0.0, bm4 = 0.0;
};

void NCoefficients(double sigmad, double a1, double b1, double w1, double l1, double a2, double b2, double w2, double l2, double& n0,
    double& n1, double& n2, double& n3, double& sn, double& dn, double& en) {
    const double sin1 = std::sin(w1 / sigmad);
    const double sin2 = std::sin(w2 / sigmad);
    const double cos1 = std::cos(w1 / sigmad);
    const double cos2 = std::cos(w2 / sigmad);
    const double exp1 = std::exp(l1 / sigmad);
    const double exp2 = std::exp(l2 / sigmad);

    n0 = a1 + a2;
    n1 = exp2 * (b2 * sin2 - (a2 + 2 * a1) * cos2);
    n1 += exp1 * (b1 * sin1 - (a1 + 2 * a2) * cos1);
    n2 = (a1 + a2) * cos2 * cos1;
    n2 -= b1 * cos2 * sin1 + b2 * cos1 * sin2;
    n2 *= 2 * exp1 * exp2;
    n2 += a2 * exp1 * exp1 + a1 * exp2 * exp2;
    n3 = exp2 * exp1 * exp1 * (b2 * sin2 - a2 * cos2);
    n3 += exp1 * exp2 * exp2 * (b1 * sin1 - a1 * cos1);

    sn = n0 + n1 + n2 + n3;
    dn = n1 + 2 * n2 + 3 * n3;
    en = n1 + 4 * n2 + 9 * n3;
}

RecursiveGaussian SetUp(double sigma, double spacing, GaussianOrder order) {
    const double sigmad = sigma / spacing;
    // Parameters of the exponential series (Deriche)
    const double a1_0 = 1.3530, b1_0 = 1.8151, w1 = 0.6681, l1 = -1.3932;
    const double a2_0 = -0.3531, b2_0 = 0.0902, w2 = 2.0787, l2 = -1.3732;
    const double a1_2 = -1.3563, b1_2 = 5.2318, a2_2 = 0.3446, b2_2 = -2.2355;

    RecursiveGaussian g;
    // ComputeDCoefficients
    const double cos1 = std::cos(w1 / sigmad);
    const double cos2 = std::cos(w2 / sigmad);
    const double exp1 = std::exp(l1 / sigmad);
    const double exp2 = std::exp(l2 / sigmad);
    g.d4 = exp1 * exp1 * exp2 * exp2;
    g.d3 = -2 * cos1 * exp1 * exp2 * exp2;
    g.d3 += -2 * cos2 * exp2 * exp1 * exp1;
    g.d2 = 4 * cos2 * cos1 * exp1 * exp2;
    g.d2 += exp1 * exp1 + exp2 * exp2;
    g.d1 = -2 * (exp2 * cos2 + exp1 * cos1);
    const double sd = 1.0 + g.d1 + g.d2 + g.d3 + g.d4;
    const double dd = g.d1 + 2 * g.d2 + 3 * g.d3 + 4 * g.d4;
    const double ed = g.d1 + 4 * g.d2 + 9 * g.d3 + 16 * g.d4;

    if (order == GaussianOrder::Zero) {
        double sn = 0, dn = 0, en = 0;
        NCoefficients(sigmad, a1_0, b1_0, w1, l1, a2_0, b2_0, w2, l2, g.n0, g.n1, g.n2, g.n3, sn, dn, en);
        const double alpha0 = 2 * sn / sd - g.n0;
        const double across_scale_normalization = 1.0;
        g.n0 *= across_scale_normalization / alpha0;
        g.n1 *= across_scale_normalization / alpha0;
        g.n2 *= across_scale_normalization / alpha0;
        g.n3 *= across_scale_normalization / alpha0;
    } else {
        // Normalized across scale, as PyRadiomics sets it
        const double across_scale_normalization = sigma * sigma;
        double n0_0 = 0, n1_0 = 0, n2_0 = 0, n3_0 = 0, sn0 = 0, dn0 = 0, en0 = 0;
        double n0_2 = 0, n1_2 = 0, n2_2 = 0, n3_2 = 0, sn2 = 0, dn2 = 0, en2 = 0;
        NCoefficients(sigmad, a1_0, b1_0, w1, l1, a2_0, b2_0, w2, l2, n0_0, n1_0, n2_0, n3_0, sn0, dn0, en0);
        NCoefficients(sigmad, a1_2, b1_2, w1, l1, a2_2, b2_2, w2, l2, n0_2, n1_2, n2_2, n3_2, sn2, dn2, en2);
        const double beta = -(2 * sn2 - sd * n0_2) / (2 * sn0 - sd * n0_0);
        g.n0 = n0_2 + beta * n0_0;
        g.n1 = n1_2 + beta * n1_0;
        g.n2 = n2_2 + beta * n2_0;
        g.n3 = n3_2 + beta * n3_0;
        const double sn = sn2 + beta * sn0;
        const double dn = dn2 + beta * dn0;
        const double en = en2 + beta * en0;
        double alpha2 = en * sd * sd - ed * sn * sd - 2 * dn * dd * sd + 2 * dd * dd * sn;
        alpha2 /= sd * sd * sd;
        g.n0 *= across_scale_normalization / alpha2;
        g.n1 *= across_scale_normalization / alpha2;
        g.n2 *= across_scale_normalization / alpha2;
        g.n3 *= across_scale_normalization / alpha2;
    }

    // ComputeRemainingCoefficients: both orders are symmetric
    g.m1 = g.n1 - g.d1 * g.n0;
    g.m2 = g.n2 - g.d2 * g.n0;
    g.m3 = g.n3 - g.d3 * g.n0;
    g.m4 = -g.d4 * g.n0;
    const double sn = g.n0 + g.n1 + g.n2 + g.n3;
    const double sm = g.m1 + g.m2 + g.m3 + g.m4;
    const double sd2 = 1.0 + g.d1 + g.d2 + g.d3 + g.d4;
    g.bn1 = g.d1 * sn / sd2;
    g.bn2 = g.d2 * sn / sd2;
    g.bn3 = g.d3 * sn / sd2;
    g.bn4 = g.d4 * sn / sd2;
    g.bm1 = g.d1 * sm / sd2;
    g.bm2 = g.d2 * sm / sd2;
    g.bm3 = g.d3 * sm / sd2;
    g.bm4 = g.d4 * sm / sd2;
    return g;
}

// RecursiveSeparableImageFilter::FilterDataArray: a causal and an anti-causal pass, with the edge values extended
inline double Ema(double a1, double b1, double a2, double b2, double a3, double b3, double a4, double b4) {
    return a1 * b1 + a2 * b2 + a3 * b3 + a4 * b4;
}

void FilterLine(const RecursiveGaussian& g, const std::vector<double>& data, std::vector<double>& outs, std::vector<double>& scratch) {
    const size_t ln = data.size();
    const double v1 = data[0];
    outs[0] = Ema(v1, g.n0, v1, g.n1, v1, g.n2, v1, g.n3);
    outs[1] = Ema(data[1], g.n0, v1, g.n1, v1, g.n2, v1, g.n3);
    outs[2] = Ema(data[2], g.n0, data[1], g.n1, v1, g.n2, v1, g.n3);
    outs[3] = Ema(data[3], g.n0, data[2], g.n1, data[1], g.n2, v1, g.n3);
    outs[0] -= Ema(v1, g.bn1, v1, g.bn2, v1, g.bn3, v1, g.bn4);
    outs[1] -= Ema(outs[0], g.d1, v1, g.bn2, v1, g.bn3, v1, g.bn4);
    outs[2] -= Ema(outs[1], g.d1, outs[0], g.d2, v1, g.bn3, v1, g.bn4);
    outs[3] -= Ema(outs[2], g.d1, outs[1], g.d2, outs[0], g.d3, v1, g.bn4);
    for (size_t i = 4; i < ln; ++i) {
        outs[i] = Ema(data[i], g.n0, data[i - 1], g.n1, data[i - 2], g.n2, data[i - 3], g.n3);
        outs[i] -= Ema(outs[i - 1], g.d1, outs[i - 2], g.d2, outs[i - 3], g.d3, outs[i - 4], g.d4);
    }

    const double v2 = data[ln - 1];
    scratch[ln - 1] = Ema(v2, g.m1, v2, g.m2, v2, g.m3, v2, g.m4);
    scratch[ln - 2] = Ema(data[ln - 1], g.m1, v2, g.m2, v2, g.m3, v2, g.m4);
    scratch[ln - 3] = Ema(data[ln - 2], g.m1, data[ln - 1], g.m2, v2, g.m3, v2, g.m4);
    scratch[ln - 4] = Ema(data[ln - 3], g.m1, data[ln - 2], g.m2, data[ln - 1], g.m3, v2, g.m4);
    scratch[ln - 1] -= Ema(v2, g.bm1, v2, g.bm2, v2, g.bm3, v2, g.bm4);
    scratch[ln - 2] -= Ema(scratch[ln - 1], g.d1, v2, g.bm2, v2, g.bm3, v2, g.bm4);
    scratch[ln - 3] -= Ema(scratch[ln - 2], g.d1, scratch[ln - 1], g.d2, v2, g.bm3, v2, g.bm4);
    scratch[ln - 4] -= Ema(scratch[ln - 3], g.d1, scratch[ln - 2], g.d2, scratch[ln - 1], g.d3, v2, g.bm4);
    for (size_t i = ln - 4; i > 0; --i) {
        scratch[i - 1] = Ema(data[i], g.m1, data[i + 1], g.m2, data[i + 2], g.m3, data[i + 3], g.m4);
        scratch[i - 1] -= Ema(scratch[i], g.d1, scratch[i + 1], g.d2, scratch[i + 2], g.d3, scratch[i + 3], g.d4);
    }
    for (size_t i = 0; i < ln; ++i) {
        outs[i] += scratch[i];
    }
}

// One recursive Gaussian along an axis (0: along rows, 1: along columns) of a CV_64F image, stored as float32 like ITK's output
cv::Mat FilterAxis(const cv::Mat& input, int axis, const RecursiveGaussian& g) {
    const int lines = axis == 0 ? input.rows : input.cols;
    const int length = axis == 0 ? input.cols : input.rows;
    cv::Mat output(input.size(), CV_32FC1);
    std::vector<double> data(static_cast<size_t>(length));
    std::vector<double> outs(static_cast<size_t>(length));
    std::vector<double> scratch(static_cast<size_t>(length));
    for (int line = 0; line < lines; ++line) {
        for (int i = 0; i < length; ++i) {
            data[static_cast<size_t>(i)] = axis == 0 ? input.at<double>(line, i) : input.at<double>(i, line);
        }
        FilterLine(g, data, outs, scratch);
        for (int i = 0; i < length; ++i) {
            const float value = static_cast<float>(outs[static_cast<size_t>(i)]);
            if (axis == 0) {
                output.at<float>(line, i) = value;
            } else {
                output.at<float>(i, line) = value;
            }
        }
    }
    return output;
}

} // namespace

cv::Mat LaplacianOfGaussian(const cv::Mat& image, cv::Point2d spacing, double sigma) {
    const int depth = image.depth();
    if (image.empty() || image.channels() != 1 || (depth != CV_8U && depth != CV_16U && depth != CV_32F && depth != CV_64F)) {
        throw std::invalid_argument("The Laplacian of Gaussian needs a single-channel 8-, 16-, 32- or 64-bit image");
    }
    if (image.rows < 4 || image.cols < 4) {
        throw std::invalid_argument("The Laplacian of Gaussian needs an image of at least 4 pixels along each axis");
    }
    if (!std::isfinite(sigma) || sigma <= 0.0) {
        throw std::invalid_argument("The sigma of the Laplacian of Gaussian must be positive");
    }
    if (!std::isfinite(spacing.x) || !std::isfinite(spacing.y) || spacing.x < 1e-8 || spacing.y < 1e-8) {
        throw std::invalid_argument("The pixel spacing must be positive");
    }

    cv::Mat input;
    image.convertTo(input, CV_64F);
    const std::array<double, 2> spacings = {spacing.x, spacing.y};
    cv::Mat cumulative = cv::Mat::zeros(image.size(), CV_32FC1);
    for (int dim = 0; dim < 2; ++dim) {
        const int other = 1 - dim;
        const RecursiveGaussian derivative = SetUp(sigma, spacings[static_cast<size_t>(dim)], GaussianOrder::Second);
        const RecursiveGaussian smoothing = SetUp(sigma, spacings[static_cast<size_t>(other)], GaussianOrder::Zero);
        cv::Mat derived;
        FilterAxis(input, dim, derivative).convertTo(derived, CV_64F);
        const cv::Mat smoothed = FilterAxis(derived, other, smoothing);
        const double spacing2 = spacings[static_cast<size_t>(dim)] * spacings[static_cast<size_t>(dim)];
        for (int row = 0; row < image.rows; ++row) {
            float* sum = cumulative.ptr<float>(row);
            const float* add = smoothed.ptr<float>(row);
            for (int col = 0; col < image.cols; ++col) {
                sum[col] = static_cast<float>(sum[col] + add[col] * (1.0 / spacing2));
            }
        }
    }
    return cumulative;
}

namespace {

// PyWavelets' Coiflet 1 decomposition filters (wavelets_coeffs.template.h)
const std::array<double, 6> COIF1_LOW = {
    -0.015655728135791993, -0.07273261951252645, 0.3848648468648578, 0.8525720202116004, 0.3378976624574818, -0.07273261951252645};
const std::array<double, 6> COIF1_HIGH = {
    0.07273261951252645, 0.3378976624574818, -0.8525720202116004, 0.3848648468648578, 0.07273261951252645, -0.015655728135791993};

// s += f * x as two statements, so the compiler does not fuse them into one fused multiply-add as PyWavelets' separate
// functions do not either
inline void AddProduct(double& sum, double f, double x) {
    const double product = f * x;
    sum = sum + product;
}

// downsampling_convolution_periodization of PyWavelets 1.10 with step 1 and fstep 1 (level 1 of swt_): output[o] is the
// sum of filter[j] · input[(o + F/2 − j) mod N], added up in PyWavelets' order
void PeriodicConvolution(const double* input, size_t n, const std::array<double, 6>& filter, double* output) {
    const size_t f = filter.size();
    size_t i = f / 2;
    size_t o = 0;
    for (; i < f && i < n; ++i, ++o) {
        double sum = 0.0;
        size_t j = 0;
        for (; j <= i; ++j) {
            AddProduct(sum, filter[j], input[i - j]);
        }
        while (j < f) {
            for (size_t k = 0; k < n && j < f; ++k, ++j) {
                AddProduct(sum, filter[j], input[n - 1 - k]);
            }
        }
        output[o] = sum;
    }
    for (; i < n; ++i, ++o) {
        double sum = 0.0;
        for (size_t j = 0; j < f; ++j) {
            AddProduct(sum, filter[j], input[i - j]);
        }
        output[o] = sum;
    }
    for (; i < f && i < n + f / 2; ++i, ++o) {
        double sum = 0.0;
        size_t j = 0;
        while (i - j >= n) {
            for (size_t k = 0; k < n && i - j >= n; ++k, ++j) {
                AddProduct(sum, filter[i - n - j], input[k]);
            }
        }
        for (; j <= i; ++j) {
            AddProduct(sum, filter[j], input[i - j]);
        }
        while (j < f) {
            for (size_t k = 0; k < n && j < f; ++k, ++j) {
                AddProduct(sum, filter[j], input[n - 1 - k]);
            }
        }
        output[o] = sum;
    }
    for (; i < n + f / 2; ++i, ++o) {
        double sum = 0.0;
        size_t j = 0;
        while (i - j >= n) {
            for (size_t k = 0; k < n && i - j >= n; ++k, ++j) {
                AddProduct(sum, filter[i - n - j], input[k]);
            }
        }
        for (; j < f; ++j) {
            AddProduct(sum, filter[j], input[i - j]);
        }
        output[o] = sum;
    }
}

// The filter along one axis (0: along rows, between columns; 1: along columns) of a CV_64F image
cv::Mat ConvolveAxis(const cv::Mat& input, int axis, const std::array<double, 6>& filter) {
    const int lines = axis == 0 ? input.rows : input.cols;
    const auto length = static_cast<size_t>(axis == 0 ? input.cols : input.rows);
    cv::Mat output(input.size(), CV_64FC1);
    std::vector<double> data(length);
    std::vector<double> result(length);
    for (int line = 0; line < lines; ++line) {
        for (size_t i = 0; i < length; ++i) {
            data[i] = axis == 0 ? input.at<double>(line, static_cast<int>(i)) : input.at<double>(static_cast<int>(i), line);
        }
        PeriodicConvolution(data.data(), length, filter, result.data());
        for (size_t i = 0; i < length; ++i) {
            if (axis == 0) {
                output.at<double>(line, static_cast<int>(i)) = result[i];
            } else {
                output.at<double>(static_cast<int>(i), line) = result[i];
            }
        }
    }
    return output;
}

} // namespace

const char* WaveletBandName(WaveletBand band) {
    switch (band) {
        case WaveletBand::LL:
            return "LL";
        case WaveletBand::LH:
            return "LH";
        case WaveletBand::HL:
            return "HL";
        case WaveletBand::HH:
            return "HH";
    }
    return "LL";
}

std::optional<WaveletBand> WaveletBandFromName(const std::string& name) {
    for (WaveletBand band : {WaveletBand::LL, WaveletBand::LH, WaveletBand::HL, WaveletBand::HH}) {
        if (name == WaveletBandName(band)) {
            return band;
        }
    }
    return std::nullopt;
}

cv::Mat WaveletImage(const cv::Mat& image, WaveletBand band) {
    const int depth = image.depth();
    if (image.empty() || image.channels() != 1 || (depth != CV_8U && depth != CV_16U && depth != CV_32F && depth != CV_64F)) {
        throw std::invalid_argument("The wavelet transform needs a single-channel 8-, 16-, 32- or 64-bit image");
    }
    cv::Mat values;
    image.convertTo(values, CV_64F);
    // numpy.pad(..., 'wrap') by one pixel at the end of an axis of odd length
    cv::Mat padded;
    cv::copyMakeBorder(values, padded, 0, image.rows % 2, 0, image.cols % 2, cv::BORDER_WRAP);
    const bool low_x = band == WaveletBand::LL || band == WaveletBand::LH;
    const bool low_y = band == WaveletBand::LL || band == WaveletBand::HL;
    const cv::Mat along_x = ConvolveAxis(padded, 0, low_x ? COIF1_LOW : COIF1_HIGH);
    const cv::Mat along_y = ConvolveAxis(along_x, 1, low_y ? COIF1_LOW : COIF1_HIGH);
    return along_y(cv::Rect(0, 0, image.cols, image.rows)).clone();
}

} // namespace glcm
