#include "imaging/Resampling.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>
#include <vector>

namespace glcm {

namespace {

// BSplineDecompositionImageFilter: the pole of the cubic B-spline and the tolerance of its initial causal coefficient
const double POLE = std::sqrt(3.0) - 2.0;
const double TOLERANCE = 1e-10;

void RequireSpacing(PixelSpacing spacing, const char* what) {
    if (!std::isfinite(spacing.x_mm) || !std::isfinite(spacing.y_mm) || spacing.x_mm <= 0.0 || spacing.y_mm <= 0.0) {
        throw std::invalid_argument(std::string(what) + " must be positive");
    }
}

// DataToCoefficients1D on one line, in place
void LineToCoefficients(std::vector<double>& line) {
    const size_t length = line.size();
    if (length == 1) {
        return;
    }
    const double gain = (1.0 - POLE) * (1.0 - 1.0 / POLE);
    for (double& value : line) {
        value *= gain;
    }

    // Initial causal coefficient, mirror boundaries (SetInitialCausalCoefficient)
    const auto horizon = static_cast<size_t>(std::ceil(std::log(TOLERANCE) / std::log(std::abs(POLE))));
    double zn = POLE;
    if (horizon < length) {
        double sum = line[0];
        for (size_t n = 1; n < horizon; ++n) {
            sum += zn * line[n];
            zn *= POLE;
        }
        line[0] = sum;
    } else {
        const double iz = 1.0 / POLE;
        double z2n = std::pow(POLE, static_cast<double>(length - 1));
        double sum = line[0] + z2n * line[length - 1];
        z2n *= z2n * iz;
        for (size_t n = 1; n <= length - 2; ++n) {
            sum += (zn + z2n) * line[n];
            zn *= POLE;
            z2n *= iz;
        }
        line[0] = sum / (1.0 - zn * zn);
    }
    for (size_t n = 1; n < length; ++n) {
        line[n] += POLE * line[n - 1];
    }
    // Initial anti-causal coefficient (SetInitialAntiCausalCoefficient)
    line[length - 1] = (POLE / (POLE * POLE - 1.0)) * (POLE * line[length - 2] + line[length - 1]);
    for (size_t n = length - 1; n-- > 0;) {
        line[n] = POLE * (line[n + 1] - line[n]);
    }
}

// DetermineRegionOfSupport, SetInterpolationWeights and ApplyMirrorBoundaryConditions for one axis of a cubic B-spline
struct Support {
    std::array<int, 4> index{};
    std::array<double, 4> weight{};
};

Support SupportAt(double x, int length) {
    Support support;
    const long start = static_cast<long>(std::floor(static_cast<float>(x))) - 1;
    for (int k = 0; k < 4; ++k) {
        support.index[static_cast<size_t>(k)] = static_cast<int>(start + k);
    }
    const double w = x - static_cast<double>(support.index[1]);
    support.weight[3] = (1.0 / 6.0) * w * w * w;
    support.weight[0] = (1.0 / 6.0) + 0.5 * w * (w - 1.0) - support.weight[3];
    support.weight[2] = w + support.weight[0] - 2.0 * support.weight[3];
    support.weight[1] = 1.0 - support.weight[0] - support.weight[2] - support.weight[3];
    const int end = length - 1;
    for (int& index : support.index) {
        if (length == 1) {
            index = 0;
            continue;
        }
        if (index < 0) {
            index = -index;
        }
        if (index >= end) {
            index = end - (index - end);
        }
        // Only images of 2 or 3 pixels along an axis can still be outside; ITK would read beyond its buffer there
        index = std::clamp(index, 0, end);
    }
    return support;
}

void RequireImage(const cv::Mat& gray) {
    if (gray.empty() || gray.channels() != 1 || (gray.depth() != CV_8U && gray.depth() != CV_16U)) {
        throw std::invalid_argument("Resampling needs an 8- or 16-bit single-channel image");
    }
}

} // namespace

ResamplingGrid ResampledGrid(cv::Size image_size, PixelSpacing from, PixelSpacing to) {
    RequireSpacing(from, "The image's pixel spacing");
    RequireSpacing(to, "The resampled pixel spacing");
    ResamplingGrid grid;
    grid.ratio_x = to.x_mm / from.x_mm;
    grid.ratio_y = to.y_mm / from.y_mm;
    // PyRadiomics: ceil(size * old spacing / new spacing)
    const double width = std::ceil(image_size.width * (from.x_mm / to.x_mm));
    const double height = std::ceil(image_size.height * (from.y_mm / to.y_mm));
    if (!(width * height <= MAX_RESAMPLED_PIXELS)) {
        throw std::invalid_argument("The resampled image would be too large; choose a larger pixel spacing");
    }
    grid.size = cv::Size(std::max(1, static_cast<int>(width)), std::max(1, static_cast<int>(height)));
    return grid;
}

cv::Mat CubicBSplineCoefficients(const cv::Mat& gray) {
    RequireImage(gray);
    cv::Mat coefficients;
    gray.convertTo(coefficients, CV_64F);
    std::vector<double> line;
    // ITK's first dimension is x: every row, then every column
    line.resize(static_cast<size_t>(coefficients.cols));
    for (int row = 0; row < coefficients.rows; ++row) {
        const double* values = coefficients.ptr<double>(row);
        std::copy(values, values + coefficients.cols, line.begin());
        LineToCoefficients(line);
        std::copy(line.begin(), line.end(), coefficients.ptr<double>(row));
    }
    line.resize(static_cast<size_t>(coefficients.rows));
    for (int col = 0; col < coefficients.cols; ++col) {
        for (int row = 0; row < coefficients.rows; ++row) {
            line[static_cast<size_t>(row)] = coefficients.at<double>(row, col);
        }
        LineToCoefficients(line);
        for (int row = 0; row < coefficients.rows; ++row) {
            coefficients.at<double>(row, col) = line[static_cast<size_t>(row)];
        }
    }
    return coefficients;
}

namespace {

// Evaluates the cubic B-spline at the centres of the grid's pixels inside `area`, calling out(row, col, value) with positions
// relative to the area; pixels outside the input buffer get 0
template <typename Out>
void EvaluateResampled(const cv::Mat& gray, const ResamplingGrid& grid, const cv::Rect& area, Out out) {
    const cv::Mat coefficients = CubicBSplineCoefficients(gray);
    // The centre of new pixel k lies at (k + 0.5) * ratio in original pixel units, the continuous index (k + 0.5) * ratio - 0.5
    const auto supports = [](int first, int count, double ratio, int length) {
        std::vector<Support> result;
        std::vector<bool> inside;
        for (int k = first; k < first + count; ++k) {
            const double x = (k + 0.5) * ratio - 0.5;
            inside.push_back(x >= -0.5 && x < length - 0.5);
            result.push_back(SupportAt(x, length));
        }
        return std::make_pair(result, inside);
    };
    const auto [columns, columns_inside] = supports(area.x, area.width, grid.ratio_x, gray.cols);
    const auto [rows, rows_inside] = supports(area.y, area.height, grid.ratio_y, gray.rows);

    for (int l = 0; l < area.height; ++l) {
        const Support& row = rows[static_cast<size_t>(l)];
        for (int k = 0; k < area.width; ++k) {
            if (!rows_inside[static_cast<size_t>(l)] || !columns_inside[static_cast<size_t>(k)]) {
                out(l, k, 0.0);
                continue;
            }
            const Support& column = columns[static_cast<size_t>(k)];
            double sum = 0.0;
            for (size_t j = 0; j < 4; ++j) {
                const double* line = coefficients.ptr<double>(row.index[j]);
                double partial = 0.0;
                for (size_t i = 0; i < 4; ++i) {
                    partial += column.weight[i] * line[column.index[i]];
                }
                sum += row.weight[j] * partial;
            }
            out(l, k, sum);
        }
    }
}

} // namespace

cv::Mat ResampleValues(const cv::Mat& gray, PixelSpacing from, PixelSpacing to, const cv::Rect& region) {
    RequireImage(gray);
    const ResamplingGrid grid = ResampledGrid(gray.size(), from, to);
    const cv::Rect area = region & cv::Rect(cv::Point(0, 0), grid.size);
    cv::Mat values = cv::Mat::zeros(area.size(), CV_64FC1);
    EvaluateResampled(gray, grid, area, [&values](int row, int col, double value) { values.at<double>(row, col) = value; });
    return values;
}

cv::Mat ResampleImage(const cv::Mat& gray, PixelSpacing from, PixelSpacing to, const cv::Rect& region) {
    RequireImage(gray);
    const ResamplingGrid grid = ResampledGrid(gray.size(), from, to);
    const cv::Rect area = region & cv::Rect(cv::Point(0, 0), grid.size);
    cv::Mat image = cv::Mat::zeros(area.size(), gray.type());
    const bool sixteen = gray.depth() == CV_16U;
    const double maximum = sixteen ? 65535.0 : 255.0;
    EvaluateResampled(gray, grid, area, [&](int row, int col, double value) {
        const double stored = std::clamp(std::round(value), 0.0, maximum);
        if (sixteen) {
            image.at<uint16_t>(row, col) = static_cast<uint16_t>(stored);
        } else {
            image.at<uchar>(row, col) = static_cast<uchar>(stored);
        }
    });
    return image;
}

RoiShape ResampleShape(const RoiShape& shape, const ResamplingGrid& grid) {
    const double sx = 1.0 / grid.ratio_x;
    const double sy = 1.0 / grid.ratio_y;
    if (const auto* rectangle = std::get_if<RectangleRoi>(&shape)) {
        return RectangleRoi{rectangle->x * sx, rectangle->y * sy, rectangle->width * sx, rectangle->height * sy};
    }
    if (const auto* polygon = std::get_if<PolygonRoi>(&shape)) {
        PolygonRoi scaled = *polygon;
        for (auto& point : scaled.points) {
            point = {point[0] * sx, point[1] * sy};
        }
        return scaled;
    }
    const auto& ellipse = std::get<EllipseRoi>(shape);
    // The ellipse is the unit circle under M = S R D (D: semi-axes, R: rotation, S: scaling). Its image under S has the
    // singular values of S R D as semi-axes and the direction of the first left singular vector as its angle.
    const double theta = ellipse.angle_deg * CV_PI / 180.0;
    const double c = std::cos(theta);
    const double s = std::sin(theta);
    const double a = sx * c * ellipse.rx;
    const double b = -sx * s * ellipse.ry;
    const double d = sy * s * ellipse.rx;
    const double e = sy * c * ellipse.ry;
    if (b == 0.0 && d == 0.0) {
        // Axis-aligned: scale the semi-axes directly, keeping the angle
        return EllipseRoi{ellipse.cx * sx, ellipse.cy * sy, std::abs(a), std::abs(e), ellipse.angle_deg};
    }
    if (a == 0.0 && e == 0.0) {
        return EllipseRoi{ellipse.cx * sx, ellipse.cy * sy, std::abs(d), std::abs(b), ellipse.angle_deg};
    }
    // M M^T = [[p, q], [q, r]]: its eigenvalues are the squared semi-axes, its first eigenvector the major axis
    const double p = a * a + b * b;
    const double q = a * d + b * e;
    const double r = d * d + e * e;
    const double half_trace = (p + r) / 2.0;
    const double half_gap = std::hypot((p - r) / 2.0, q);
    const double major = std::sqrt(half_trace + half_gap);
    const double minor = std::sqrt(std::max(0.0, half_trace - half_gap));
    const double angle = 0.5 * std::atan2(2.0 * q, p - r) * 180.0 / CV_PI;
    return EllipseRoi{ellipse.cx * sx, ellipse.cy * sy, major, minor, angle};
}

} // namespace glcm
