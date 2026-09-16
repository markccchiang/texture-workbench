#include "analysis/Shape.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <vector>

namespace glcm {

namespace {

const uchar INSIDE = 255;
const double NaN = std::numeric_limits<double>::quiet_NaN();

// PyRadiomics' marching squares tables (radiomics/src/cshape.c). A square's corners, as (row, col) offsets, give bits 0-3.
const std::array<std::array<int, 2>, 4> GRID_ANGLES = {{{0, 0}, {0, 1}, {1, 1}, {1, 0}}};
// Lines of each square index as pairs of edges, -1 terminated
const std::array<std::array<int, 5>, 16> LINE_TABLE = {{
    {-1, -1, -1, -1, -1},
    {3, 0, -1, -1, -1},
    {0, 1, -1, -1, -1},
    {3, 1, -1, -1, -1},
    {1, 2, -1, -1, -1},
    {1, 2, 3, 0, -1},
    {0, 2, -1, -1, -1},
    {3, 2, -1, -1, -1},
    {2, 3, -1, -1, -1},
    {2, 0, -1, -1, -1},
    {0, 1, 2, 3, -1},
    {2, 1, -1, -1, -1},
    {1, 3, -1, -1, -1},
    {1, 0, -1, -1, -1},
    {0, 3, -1, -1, -1},
    {-1, -1, -1, -1, -1},
}};
// Midpoint of each edge of the square, as (row, col) offsets; in half units the offsets are integers
const std::array<std::array<double, 2>, 4> VERTICES = {{{0, 0.5}, {0.5, 1}, {1, 0.5}, {0.5, 0}}};
const std::array<std::array<int, 2>, 4> HALF_VERTICES = {{{0, 1}, {1, 2}, {2, 1}, {1, 0}}};

struct Mesh {
    double perimeter = 0.0;
    double surface = 0.0;
    double diameter = 0.0;
};

// Andrew's monotone chain on integer points: the hull of the mesh vertices, found without rounding. Points on hull edges are
// left out; the largest distance is always between two hull vertices.
std::vector<std::array<std::int64_t, 2>> ConvexHull(std::vector<std::array<std::int64_t, 2>> points) {
    std::sort(points.begin(), points.end());
    points.erase(std::unique(points.begin(), points.end()), points.end());
    if (points.size() < 3) {
        return points;
    }
    const auto cross = [](const auto& o, const auto& a, const auto& b) {
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    };
    std::vector<std::array<std::int64_t, 2>> hull(points.size() * 2);
    size_t k = 0;
    for (const auto& point : points) {
        while (k >= 2 && cross(hull[k - 2], hull[k - 1], point) <= 0) {
            --k;
        }
        hull[k++] = point;
    }
    for (size_t i = points.size() - 1, lower = k + 1; i-- > 0;) {
        while (k >= lower && cross(hull[k - 2], hull[k - 1], points[i]) <= 0) {
            --k;
        }
        hull[k++] = points[i];
    }
    hull.resize(k - 1);
    return hull;
}

// calculate_coefficients2D: the mask is padded with a ring of outside pixels, as PyRadiomics pads it
Mesh ComputeMesh(const cv::Mat& mask, cv::Point2d spacing) {
    const int rows = mask.rows + 2;
    const int cols = mask.cols + 2;
    const auto inside = [&mask](int row, int col) {
        return row >= 1 && col >= 1 && row <= mask.rows && col <= mask.cols && mask.at<uchar>(row - 1, col - 1) == INSIDE;
    };
    const double spacing_y = spacing.y;
    const double spacing_x = spacing.x;

    Mesh mesh;
    std::vector<std::array<std::int64_t, 2>> vertices; // in half units: (2 * row + offset, 2 * col + offset)
    for (int iy = 0; iy < rows - 1; ++iy) {
        for (int ix = 0; ix < cols - 1; ++ix) {
            unsigned square = 0;
            for (unsigned corner = 0; corner < 4; ++corner) {
                if (inside(iy + GRID_ANGLES[corner][0], ix + GRID_ANGLES[corner][1])) {
                    square |= 1u << corner;
                }
            }
            if (square == 0 || square == 0xF) {
                continue;
            }
            const auto& lines = LINE_TABLE[square];
            for (int t = 0; lines[static_cast<size_t>(t) * 2] >= 0; ++t) {
                const auto& from = VERTICES[static_cast<size_t>(lines[static_cast<size_t>(t) * 2])];
                const auto& to = VERTICES[static_cast<size_t>(lines[static_cast<size_t>(t) * 2 + 1])];
                std::array<double, 2> a = {static_cast<double>(iy), static_cast<double>(ix)};
                std::array<double, 2> b = a;
                const std::array<double, 2> steps = {spacing_y, spacing_x};
                for (size_t d = 0; d < 2; ++d) {
                    a[d] += from[d];
                    b[d] += to[d];
                    a[d] *= steps[d];
                    b[d] *= steps[d];
                }
                mesh.surface += (a[0] * b[1]) - (b[0] * a[1]);
                for (size_t d = 0; d < 2; ++d) {
                    a[d] -= b[d];
                    a[d] = a[d] * a[d];
                }
                mesh.perimeter += std::sqrt(a[0] + a[1]);
            }
            // Each square stores the vertices on its edges 3 and 2, so every vertex is stored once
            if (square > 7) {
                square ^= 0xF;
            }
            if ((square & 1u) != 0) {
                vertices.push_back(
                    {2 * static_cast<std::int64_t>(iy) + HALF_VERTICES[3][0], 2 * static_cast<std::int64_t>(ix) + HALF_VERTICES[3][1]});
            }
            if ((square & 4u) != 0) {
                vertices.push_back(
                    {2 * static_cast<std::int64_t>(iy) + HALF_VERTICES[2][0], 2 * static_cast<std::int64_t>(ix) + HALF_VERTICES[2][1]});
            }
        }
    }
    mesh.surface /= 2.0;

    // The largest squared distance between vertices, computed as calculate_meshDiameter2D computes it, on the hull vertices
    const std::vector<std::array<std::int64_t, 2>> hull = ConvexHull(std::move(vertices));
    double largest = 0.0;
    for (size_t i = 0; i < hull.size(); ++i) {
        const double ay = (static_cast<double>(hull[i][0]) / 2.0) * spacing_y;
        const double ax = (static_cast<double>(hull[i][1]) / 2.0) * spacing_x;
        for (size_t j = 0; j < i; ++j) {
            double dy = ay - (static_cast<double>(hull[j][0]) / 2.0) * spacing_y;
            double dx = ax - (static_cast<double>(hull[j][1]) / 2.0) * spacing_x;
            dy *= dy;
            dx *= dx;
            largest = std::max(largest, dy + dx);
        }
    }
    mesh.diameter = std::sqrt(largest);
    return mesh;
}

// Eigenvalues (smallest first) of the covariance of the physical pixel-centre coordinates, divided by the pixel count
std::array<double, 2> PrincipalComponents(const cv::Mat& mask, cv::Point2d spacing) {
    double count = 0.0;
    double sum_y = 0.0;
    double sum_x = 0.0;
    for (int row = 0; row < mask.rows; ++row) {
        const uchar* line = mask.ptr<uchar>(row);
        for (int col = 0; col < mask.cols; ++col) {
            if (line[col] == INSIDE) {
                count += 1.0;
                sum_y += row * spacing.y;
                sum_x += col * spacing.x;
            }
        }
    }
    const double mean_y = sum_y / count;
    const double mean_x = sum_x / count;
    const double scale = std::sqrt(count);
    double yy = 0.0;
    double xy = 0.0;
    double xx = 0.0;
    for (int row = 0; row < mask.rows; ++row) {
        const uchar* line = mask.ptr<uchar>(row);
        for (int col = 0; col < mask.cols; ++col) {
            if (line[col] == INSIDE) {
                const double y = (row * spacing.y - mean_y) / scale;
                const double x = (col * spacing.x - mean_x) / scale;
                yy += y * y;
                xy += y * x;
                xx += x * x;
            }
        }
    }
    // A symmetric 2 x 2 matrix: half the trace plus and minus the half-distance between the eigenvalues
    const double half_trace = (yy + xx) / 2.0;
    const double half_gap = std::hypot((yy - xx) / 2.0, xy);
    std::array<double, 2> eigenvalues = {half_trace - half_gap, half_trace + half_gap};
    for (double& value : eigenvalues) {
        // PyRadiomics rounds tiny negative eigenvalues to 0
        if (value < 0.0 && value > -1e-10) {
            value = 0.0;
        }
    }
    return eigenvalues;
}

} // namespace

bool IsShapeFeature(Type type) {
    switch (type) {
        case Type::ShapeMeshSurface:
        case Type::ShapePixelSurface:
        case Type::ShapePerimeter:
        case Type::ShapePerimeterSurfaceRatio:
        case Type::ShapeSphericity:
        case Type::ShapeMaximumDiameter:
        case Type::ShapeMajorAxisLength:
        case Type::ShapeMinorAxisLength:
        case Type::ShapeElongation:
            return true;
        default:
            return false;
    }
}

std::map<Type, double> ComputeShapeFeatures(const cv::Mat& mask, cv::Point2d spacing, const std::set<Type>& types) {
    if (mask.type() != CV_8UC1) {
        throw std::invalid_argument("The mask must be an 8-bit single-channel image (CV_8UC1)");
    }
    if (!std::isfinite(spacing.x) || !std::isfinite(spacing.y) || spacing.x <= 0.0 || spacing.y <= 0.0) {
        throw std::invalid_argument("The pixel spacing must be positive");
    }
    for (Type type : types) {
        if (!IsShapeFeature(type)) {
            throw std::invalid_argument("Not a shape feature: " + TextureAnalysis::TypeToString(type));
        }
    }
    std::map<Type, double> values;
    const int pixels = cv::countNonZero(mask == INSIDE);
    if (pixels == 0) {
        for (Type type : types) {
            values[type] = NaN;
        }
        return values;
    }

    const Mesh mesh = ComputeMesh(mask, spacing);
    const std::array<double, 2> eigenvalues = PrincipalComponents(mask, spacing);
    const auto axis = [](double eigenvalue) { return eigenvalue < 0.0 ? NaN : std::sqrt(eigenvalue) * 4.0; };
    for (Type type : types) {
        switch (type) {
            case Type::ShapeMeshSurface:
                values[type] = mesh.surface;
                break;
            case Type::ShapePixelSurface:
                values[type] = pixels * (spacing.x * spacing.y);
                break;
            case Type::ShapePerimeter:
                values[type] = mesh.perimeter;
                break;
            case Type::ShapePerimeterSurfaceRatio:
                values[type] = mesh.perimeter / mesh.surface;
                break;
            case Type::ShapeSphericity:
                values[type] = (2.0 * std::sqrt(CV_PI * mesh.surface)) / mesh.perimeter;
                break;
            case Type::ShapeMaximumDiameter:
                values[type] = mesh.diameter;
                break;
            case Type::ShapeMajorAxisLength:
                values[type] = axis(eigenvalues[1]);
                break;
            case Type::ShapeMinorAxisLength:
                values[type] = axis(eigenvalues[0]);
                break;
            case Type::ShapeElongation:
                values[type] = eigenvalues[0] < 0.0 || eigenvalues[1] < 0.0 ? NaN : std::sqrt(eigenvalues[0] / eigenvalues[1]);
                break;
            default:
                break;
        }
    }
    return values;
}

} // namespace glcm
