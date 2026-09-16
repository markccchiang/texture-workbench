#include "roi/RoiOperations.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <opencv2/imgproc.hpp>
#include <stdexcept>
#include <tuple>

#include "roi/Outline.hpp"

namespace glcm {

namespace {

const uchar INSIDE = 255;

struct Loop {
    std::vector<std::array<double, 2>> points;
    int start_x = 0;
    int start_y = 0;
};

// First pixel in raster order of every label 1..count-1 (labels without pixels keep x = -1)
std::vector<cv::Point> FirstPixels(const cv::Mat& labels, int count) {
    std::vector<cv::Point> first(static_cast<size_t>(count), cv::Point(-1, -1));
    int remaining = count - 1;
    for (int y = 0; y < labels.rows && remaining > 0; ++y) {
        const int* row = labels.ptr<int>(y);
        for (int x = 0; x < labels.cols; ++x) {
            const int label = row[x];
            if (label > 0 && first[static_cast<size_t>(label)].x < 0) {
                first[static_cast<size_t>(label)] = cv::Point(x, y);
                --remaining;
            }
        }
    }
    return first;
}

OperationResult FromMask(const cv::Mat& mask, cv::Point offset) {
    OperationResult result;
    result.pixel_count = cv::countNonZero(mask);
    if (result.pixel_count == 0) {
        return result;
    }
    const cv::Rect box = MaskBoundingBox(mask);
    result.box = box + offset;
    result.polygon.points = MaskOutline(mask(box), offset + box.tl());
    return result;
}

// The pixels of a mask of the size of `features` whose centres lie within `distance` of the centre of a non-zero pixel of
// `features`, with steps of spacing.x between columns and spacing.y between rows. Exact: the squared Euclidean distance
// transform of Felzenszwalb and Huttenlocher (2012), done column by column (distances in rows, kept as integers) and then row
// by row as the lower envelope of parabolas. Memory is one int per pixel.
cv::Mat WithinDistance(const cv::Mat& features, double distance, cv::Point2d spacing) {
    const int rows = features.rows;
    const int cols = features.cols;
    const int none = std::numeric_limits<int>::max();

    // Rows to the nearest feature in the same column
    cv::Mat vertical(rows, cols, CV_32SC1, cv::Scalar(none));
    for (int col = 0; col < cols; ++col) {
        int last = -1;
        for (int row = 0; row < rows; ++row) {
            if (features.at<uchar>(row, col) != 0) {
                last = row;
            }
            if (last >= 0) {
                vertical.at<int>(row, col) = row - last;
            }
        }
        last = -1;
        for (int row = rows - 1; row >= 0; --row) {
            if (features.at<uchar>(row, col) != 0) {
                last = row;
            }
            if (last >= 0) {
                vertical.at<int>(row, col) = std::min(vertical.at<int>(row, col), last - row);
            }
        }
    }

    const double limit = distance * distance;
    const double sx2 = spacing.x * spacing.x;
    cv::Mat within = cv::Mat::zeros(rows, cols, CV_8UC1);
    std::vector<double> height(static_cast<size_t>(cols));
    std::vector<int> apex(static_cast<size_t>(cols));
    std::vector<double> boundary(static_cast<size_t>(cols) + 1);
    for (int row = 0; row < rows; ++row) {
        const int* line = vertical.ptr<int>(row);
        // Parabola q: sx2 * (c - q)^2 + height[q], where height is the squared distance within the column
        int count = 0;
        const auto crossing = [&](int q, int p) {
            return ((height[static_cast<size_t>(q)] + sx2 * q * q) - (height[static_cast<size_t>(p)] + sx2 * p * p)) /
                   (2.0 * sx2 * (q - p));
        };
        for (int q = 0; q < cols; ++q) {
            if (line[q] == none) {
                continue;
            }
            const double step = line[q] * spacing.y;
            height[static_cast<size_t>(q)] = step * step;
            if (count == 0) {
                apex[0] = q;
                boundary[0] = -std::numeric_limits<double>::infinity();
                boundary[1] = std::numeric_limits<double>::infinity();
                count = 1;
                continue;
            }
            double s = crossing(q, apex[static_cast<size_t>(count - 1)]);
            while (count > 1 && s <= boundary[static_cast<size_t>(count - 1)]) {
                --count;
                s = crossing(q, apex[static_cast<size_t>(count - 1)]);
            }
            apex[static_cast<size_t>(count)] = q;
            boundary[static_cast<size_t>(count)] = s;
            boundary[static_cast<size_t>(count) + 1] = std::numeric_limits<double>::infinity();
            ++count;
        }
        if (count == 0) {
            continue;
        }
        uchar* out = within.ptr<uchar>(row);
        int k = 0;
        for (int col = 0; col < cols; ++col) {
            while (boundary[static_cast<size_t>(k) + 1] < col) {
                ++k;
            }
            const int q = apex[static_cast<size_t>(k)];
            const double value = sx2 * (col - q) * (col - q) + height[static_cast<size_t>(q)];
            if (value <= limit) {
                out[col] = INSIDE;
            }
        }
    }
    return within;
}

void RequireRadius(double radius) {
    if (!std::isfinite(radius) || radius <= 0.0) {
        throw std::invalid_argument("The brush radius must be a positive number");
    }
}

// Pixels of the image whose centres lie within `radius` of the polyline, in the box `area` (image coordinates)
cv::Mat StrokeMask(const std::vector<std::array<double, 2>>& path, double radius, cv::Rect area) {
    cv::Mat mask = cv::Mat::zeros(area.size(), CV_8UC1);
    const double radius2 = radius * radius;
    for (size_t i = 0; i < path.size(); ++i) {
        const auto& a = path[i];
        const auto& b = path[std::min(i + 1, path.size() - 1)];
        const double dx = b[0] - a[0];
        const double dy = b[1] - a[1];
        const double length2 = dx * dx + dy * dy;
        const int first_col = std::max(area.x, static_cast<int>(std::floor(std::min(a[0], b[0]) - radius)));
        const int end_col = std::min(area.x + area.width, static_cast<int>(std::ceil(std::max(a[0], b[0]) + radius)) + 1);
        const int first_row = std::max(area.y, static_cast<int>(std::floor(std::min(a[1], b[1]) - radius)));
        const int end_row = std::min(area.y + area.height, static_cast<int>(std::ceil(std::max(a[1], b[1]) + radius)) + 1);
        for (int row = first_row; row < end_row; ++row) {
            uchar* line = mask.ptr<uchar>(row - area.y);
            const double py = row + 0.5;
            for (int col = first_col; col < end_col; ++col) {
                const double px = col + 0.5;
                // Distance to the segment: project onto it and clamp to its end points
                const double t = length2 > 0.0 ? std::clamp(((px - a[0]) * dx + (py - a[1]) * dy) / length2, 0.0, 1.0) : 0.0;
                const double ex = px - (a[0] + t * dx);
                const double ey = py - (a[1] + t * dy);
                if (ex * ex + ey * ey <= radius2) {
                    line[col - area.x] = INSIDE;
                }
            }
        }
    }
    return mask;
}

} // namespace

std::vector<std::array<double, 2>> MaskOutline(const cv::Mat& mask, cv::Point offset) {
    if (mask.type() != CV_8UC1) {
        throw std::invalid_argument("The mask must be an 8-bit single-channel image (CV_8UC1)");
    }
    const cv::Mat foreground = mask != 0;
    if (cv::countNonZero(foreground) == 0) {
        return {};
    }
    std::vector<Loop> loops;

    // Outer outline of every 8-connected part
    cv::Mat labels;
    const int parts = cv::connectedComponents(foreground, labels, 8, CV_32S);
    const std::vector<cv::Point> part_starts = FirstPixels(labels, parts);
    for (int label = 1; label < parts; ++label) {
        const cv::Point start = part_starts[static_cast<size_t>(label)];
        const auto inside = [&labels, label](int x, int y) {
            return x >= 0 && y >= 0 && x < labels.cols && y < labels.rows && labels.at<int>(y, x) == label;
        };
        loops.push_back({outline_detail::TraceOutline(start.x, start.y, inside, true), start.x, start.y});
    }

    // Outline of every hole: 4-connected background inside the mask, found in a copy with a background border that
    // connects all outside background
    cv::Mat background;
    cv::copyMakeBorder(foreground == 0, background, 1, 1, 1, 1, cv::BORDER_CONSTANT, cv::Scalar(INSIDE));
    cv::Mat hole_labels;
    const int holes = cv::connectedComponents(background, hole_labels, 4, CV_32S);
    const int outside = hole_labels.at<int>(0, 0);
    const std::vector<cv::Point> hole_starts = FirstPixels(hole_labels, holes);
    for (int label = 1; label < holes; ++label) {
        if (label == outside) {
            continue;
        }
        // In mask coordinates (the border shifts the labels by one pixel)
        const cv::Point start = hole_starts[static_cast<size_t>(label)] - cv::Point(1, 1);
        const auto inside = [&hole_labels, label](int x, int y) {
            return x >= -1 && y >= -1 && x + 1 < hole_labels.cols && y + 1 < hole_labels.rows && hole_labels.at<int>(y + 1, x + 1) == label;
        };
        loops.push_back({outline_detail::TraceOutline(start.x, start.y, inside, false), start.x, start.y});
    }

    std::sort(loops.begin(), loops.end(),
        [](const Loop& a, const Loop& b) { return std::tie(a.start_y, a.start_x) < std::tie(b.start_y, b.start_x); });

    // Loop 0, then a cut to each next loop in turn, each loop closed at its start, and the cuts walked back at the end:
    // L0 .. s0, L1 .. s1, L2 .. s2, s1, (closing edge to s0)
    std::vector<std::array<double, 2>> polygon;
    for (size_t i = 0; i < loops.size(); ++i) {
        polygon.insert(polygon.end(), loops[i].points.begin(), loops[i].points.end());
        if (loops.size() > 1) {
            polygon.push_back(loops[i].points.front());
        }
    }
    // Back from the last loop's start through the starts of loops k-1 .. 1; the closing edge then returns to s0
    for (size_t i = loops.size(); i-- > 1;) {
        if (i + 1 < loops.size()) {
            polygon.push_back(loops[i].points.front());
        }
    }
    for (auto& point : polygon) {
        point[0] += offset.x;
        point[1] += offset.y;
    }
    return polygon;
}

OperationResult CombineShapes(const std::vector<RoiShape>& shapes, RoiOperation operation, cv::Size image_size) {
    if (shapes.empty()) {
        throw std::invalid_argument("Combining ROIs needs at least one shape");
    }
    std::vector<CroppedMask> masks;
    masks.reserve(shapes.size());
    for (const RoiShape& shape : shapes) {
        masks.push_back(RasterizeCroppedMask(shape, image_size));
    }

    // The pixels the result can have: all boxes for union and exclusive or, the first box for subtraction, their overlap
    // for intersection
    cv::Rect area = masks[0].box;
    for (size_t i = 1; i < masks.size(); ++i) {
        const cv::Rect box = masks[i].box;
        if (operation == RoiOperation::Union || operation == RoiOperation::Xor) {
            if (box.area() > 0) {
                area = area.area() > 0 ? (area | box) : box;
            }
        } else if (operation == RoiOperation::Intersect) {
            area &= box;
        }
    }
    if (area.area() == 0) {
        return {};
    }

    cv::Mat result = cv::Mat::zeros(area.size(), CV_8UC1);
    switch (operation) {
        case RoiOperation::Union:
        case RoiOperation::Xor:
            for (const CroppedMask& cropped : masks) {
                if (cropped.box.area() > 0) {
                    cv::Mat target = result(cropped.box - area.tl());
                    if (operation == RoiOperation::Union) {
                        cv::bitwise_or(target, cropped.mask, target);
                    } else {
                        cv::bitwise_xor(target, cropped.mask, target);
                    }
                }
            }
            break;
        case RoiOperation::Intersect:
            result.setTo(cv::Scalar(INSIDE));
            for (const CroppedMask& cropped : masks) {
                cv::bitwise_and(result, cropped.mask(area - cropped.box.tl()), result);
            }
            break;
        case RoiOperation::Subtract:
            masks[0].mask.copyTo(result);
            for (size_t i = 1; i < masks.size(); ++i) {
                const cv::Rect overlap = masks[i].box & area;
                if (overlap.area() > 0) {
                    result(overlap - area.tl()).setTo(cv::Scalar(0), masks[i].mask(overlap - masks[i].box.tl()));
                }
            }
            break;
    }
    return FromMask(result, area.tl());
}

OperationResult GrowShape(const RoiShape& shape, GrowOperation operation, double distance, cv::Point2d spacing, cv::Size image_size) {
    if (!std::isfinite(distance) || distance <= 0.0) {
        throw std::invalid_argument("The distance must be a positive number");
    }
    if (!std::isfinite(spacing.x) || !std::isfinite(spacing.y) || spacing.x <= 0.0 || spacing.y <= 0.0) {
        throw std::invalid_argument("The pixel spacing must be positive");
    }
    const CroppedMask base = RasterizeCroppedMask(shape, image_size);
    if (base.box.area() == 0) {
        return {};
    }

    if (operation == GrowOperation::Shrink) {
        // The outside of the shape, with a ring of outside pixels around its box: every pixel outside the shape, also beyond
        // the image, is at least as far from a pixel of the shape as the nearest pixel of that ring or of the box
        const cv::Rect area(base.box.x - 1, base.box.y - 1, base.box.width + 2, base.box.height + 2);
        cv::Mat outside(area.size(), CV_8UC1, cv::Scalar(INSIDE));
        outside(cv::Rect(1, 1, base.box.width, base.box.height)).setTo(cv::Scalar(0), base.mask);
        cv::Mat result = cv::Mat::zeros(area.size(), CV_8UC1);
        base.mask.copyTo(result(cv::Rect(1, 1, base.box.width, base.box.height)));
        result.setTo(cv::Scalar(0), WithinDistance(outside, distance, spacing));
        return FromMask(result, area.tl());
    }

    // Columns and rows farther than the distance cannot be reached
    const auto reach = [distance](double step) { return std::min(std::floor(distance / step), 1.0e9); };
    const auto clamp_index = [](double value, int size) { return static_cast<int>(std::clamp(value, 0.0, static_cast<double>(size))); };
    const double columns = reach(spacing.x);
    const double rows = reach(spacing.y);
    const int first_col = clamp_index(base.box.x - columns, image_size.width);
    const int end_col = clamp_index(base.box.x + base.box.width + columns, image_size.width);
    const int first_row = clamp_index(base.box.y - rows, image_size.height);
    const int end_row = clamp_index(base.box.y + base.box.height + rows, image_size.height);
    const cv::Rect area(first_col, first_row, end_col - first_col, end_row - first_row);
    cv::Mat shape_mask = cv::Mat::zeros(area.size(), CV_8UC1);
    base.mask.copyTo(shape_mask(base.box - area.tl()));
    cv::Mat result = WithinDistance(shape_mask, distance, spacing);
    if (operation == GrowOperation::Band) {
        result.setTo(cv::Scalar(0), shape_mask);
    }
    return FromMask(result, area.tl());
}

OperationResult PaintStroke(
    const std::optional<RoiShape>& shape, const std::vector<std::array<double, 2>>& path, double radius, bool erase, cv::Size image_size) {
    if (image_size.width <= 0 || image_size.height <= 0) {
        throw std::invalid_argument("The image size must be positive");
    }
    if (path.empty()) {
        throw std::invalid_argument("The brush stroke has no points");
    }
    RequireRadius(radius);
    double min_x = path[0][0];
    double max_x = path[0][0];
    double min_y = path[0][1];
    double max_y = path[0][1];
    for (const auto& point : path) {
        if (!std::isfinite(point[0]) || !std::isfinite(point[1])) {
            throw std::invalid_argument("The brush stroke has a non-finite coordinate");
        }
        min_x = std::min(min_x, point[0]);
        max_x = std::max(max_x, point[0]);
        min_y = std::min(min_y, point[1]);
        max_y = std::max(max_y, point[1]);
    }
    const CroppedMask base = shape ? RasterizeCroppedMask(*shape, image_size) : CroppedMask{};
    if (erase && base.box.area() == 0) {
        return {};
    }

    // Every pixel the stroke can reach, clipped to the image
    const auto clamp_index = [](double value, int size) { return static_cast<int>(std::clamp(value, 0.0, static_cast<double>(size))); };
    const int first_col = clamp_index(std::floor(min_x - radius), image_size.width);
    const int end_col = clamp_index(std::ceil(max_x + radius) + 1.0, image_size.width);
    const int first_row = clamp_index(std::floor(min_y - radius), image_size.height);
    const int end_row = clamp_index(std::ceil(max_y + radius) + 1.0, image_size.height);
    const cv::Rect stroke_box = (first_col < end_col && first_row < end_row)
                                    ? cv::Rect(first_col, first_row, end_col - first_col, end_row - first_row)
                                    : cv::Rect();

    cv::Rect area = base.box;
    if (!erase && stroke_box.area() > 0) {
        area = area.area() > 0 ? (area | stroke_box) : stroke_box;
    }
    if (area.area() == 0) {
        return {};
    }
    cv::Mat result = cv::Mat::zeros(area.size(), CV_8UC1);
    if (base.box.area() > 0) {
        base.mask.copyTo(result(base.box - area.tl()));
    }
    const cv::Rect stroke_area = stroke_box & area;
    if (stroke_area.area() > 0) {
        const cv::Mat stroke = StrokeMask(path, radius, stroke_area);
        cv::Mat target = result(stroke_area - area.tl());
        if (erase) {
            target.setTo(cv::Scalar(0), stroke);
        } else {
            cv::bitwise_or(target, stroke, target);
        }
    }
    return FromMask(result, area.tl());
}

} // namespace glcm
