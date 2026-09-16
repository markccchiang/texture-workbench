#include <gtest/gtest.h>

#include <array>
#include <cmath>
#include <opencv2/core.hpp>
#include <optional>
#include <stdexcept>
#include <string>
#include <tuple>
#include <vector>

#include "roi/Roi.hpp"
#include "roi/RoiOperations.hpp"

using namespace glcm;

namespace {

// '#' = 255, anything else = 0
cv::Mat FromRows(const std::vector<std::string>& rows) {
    cv::Mat mask(static_cast<int>(rows.size()), static_cast<int>(rows[0].size()), CV_8UC1);
    for (int y = 0; y < mask.rows; ++y) {
        for (int x = 0; x < mask.cols; ++x) {
            mask.at<uchar>(y, x) = rows[y][x] == '#' ? 255 : 0;
        }
    }
    return mask;
}

cv::Mat Rasterize(const std::vector<std::array<double, 2>>& points, cv::Size size) {
    PolygonRoi polygon;
    polygon.points = points;
    return RasterizeMask(polygon, size);
}

int Differences(const cv::Mat& a, const cv::Mat& b) {
    return cv::countNonZero(a != b);
}

RoiShape Rectangle(double x, double y, double width, double height) {
    return RectangleRoi{x, y, width, height};
}

// Pixels whose centres lie within the radius of a segment, by brute force over the whole image
cv::Mat ReferenceStroke(const std::vector<std::array<double, 2>>& path, double radius, cv::Size size) {
    cv::Mat mask = cv::Mat::zeros(size, CV_8UC1);
    for (int y = 0; y < size.height; ++y) {
        for (int x = 0; x < size.width; ++x) {
            const double px = x + 0.5;
            const double py = y + 0.5;
            double best = INFINITY;
            for (size_t i = 0; i < path.size(); ++i) {
                const auto& a = path[i];
                const auto& b = path[std::min(i + 1, path.size() - 1)];
                const double dx = b[0] - a[0];
                const double dy = b[1] - a[1];
                const double length2 = dx * dx + dy * dy;
                double t = length2 > 0 ? ((px - a[0]) * dx + (py - a[1]) * dy) / length2 : 0.0;
                t = std::min(1.0, std::max(0.0, t));
                best = std::min(best, std::hypot(px - (a[0] + t * dx), py - (a[1] + t * dy)));
            }
            if (best <= radius) {
                mask.at<uchar>(y, x) = 255;
            }
        }
    }
    return mask;
}

// Pixels within the distance of a pixel of `from`, by comparing every pair of pixels; pixels beyond the image count as part of
// `from` when `outside_counts` is set (the outside of a shape reaches in from the image border)
cv::Mat ReferenceWithin(const cv::Mat& from, double distance, cv::Point2d spacing, bool outside_counts) {
    const int margin = outside_counts ? 1 : 0;
    cv::Mat within = cv::Mat::zeros(from.size(), CV_8UC1);
    for (int y = 0; y < from.rows; ++y) {
        for (int x = 0; x < from.cols; ++x) {
            bool found = false;
            for (int v = -margin; v < from.rows + margin && !found; ++v) {
                for (int u = -margin; u < from.cols + margin && !found; ++u) {
                    const bool beyond = u < 0 || v < 0 || u >= from.cols || v >= from.rows;
                    if (beyond ? outside_counts : from.at<uchar>(v, u) != 0) {
                        const double dx = (x - u) * spacing.x;
                        const double dy = (y - v) * spacing.y;
                        found = dx * dx + dy * dy <= distance * distance;
                    }
                }
            }
            within.at<uchar>(y, x) = found ? 255 : 0;
        }
    }
    return within;
}

} // namespace

TEST(RoiOperationsTest, MaskOutlineReproducesMasksWithHolesIslandsAndSeveralParts) {
    const std::vector<std::vector<std::string>> cases = {
        {"#"},
        {"....", ".##.", ".##.", "...."},
        // A ring with an island in its hole, a diagonal hole, and a separate part
        {
            "############...",
            "#..........#...",
            "#.####.....#.#.",
            "#.#..#.....#...",
            "#.####..#..#.##",
            "#......#...#.##",
            "############...",
        },
        // Diagonal neighbours in the parts and in the background
        {"#.#.#", ".#.#.", "#.#.#", ".#.#.", "#.#.#"},
        {"##..", "##..", "..##", "..##"},
        {".....", ".###.", ".#.#.", ".###.", "....."},
    };
    for (size_t i = 0; i < cases.size(); ++i) {
        const cv::Mat mask = FromRows(cases[i]);
        const auto outline = MaskOutline(mask);
        EXPECT_EQ(Differences(Rasterize(outline, mask.size()), mask), 0) << "case " << i;
    }

    // Masks with many holes and parts
    cv::Mat pattern(40, 50, CV_8UC1);
    for (int y = 0; y < pattern.rows; ++y) {
        for (int x = 0; x < pattern.cols; ++x) {
            pattern.at<uchar>(y, x) = static_cast<uchar>((x * 37 + y * 101 + (x * y) % 7 * 13) % 256);
        }
    }
    for (int threshold : {40, 100, 128, 200}) {
        const cv::Mat mask = pattern > threshold;
        EXPECT_EQ(Differences(Rasterize(MaskOutline(mask), mask.size()), mask), 0) << "threshold " << threshold;
    }
}

TEST(RoiOperationsTest, MaskOutlineOfOneRectangleIsItsCornersAndHonoursTheOffset) {
    const cv::Mat mask = FromRows({"###", "###"});
    EXPECT_EQ(MaskOutline(mask, cv::Point(4, 7)), (std::vector<std::array<double, 2>>{{4, 7}, {7, 7}, {7, 9}, {4, 9}}));
    EXPECT_TRUE(MaskOutline(cv::Mat::zeros(3, 3, CV_8UC1)).empty());
    EXPECT_THROW(MaskOutline(cv::Mat::zeros(3, 3, CV_32FC1)), std::invalid_argument);

    cv::Mat image = cv::Mat::zeros(20, 20, CV_8UC1);
    const cv::Mat ring = FromRows({"###", "#.#", "###"});
    ring.copyTo(image(cv::Rect(12, 5, 3, 3)));
    EXPECT_EQ(Differences(Rasterize(MaskOutline(ring, cv::Point(12, 5)), image.size()), image), 0);
}

TEST(RoiOperationsTest, UnionAndSubtractMatchTheRasterizedShapes) {
    const cv::Size size(40, 30);
    const RoiShape a = Rectangle(2, 3, 20, 15);
    const RoiShape b = EllipseRoi{20, 15, 9, 6, 30};
    const RoiShape inner = Rectangle(8, 7, 6, 5);
    const RoiShape far = Rectangle(30, 22, 5, 5);

    const auto check = [&size](const OperationResult& result, const cv::Mat& expected, const char* label) {
        EXPECT_EQ(result.pixel_count, cv::countNonZero(expected)) << label;
        EXPECT_EQ(Differences(Rasterize(result.polygon.points, size), expected), 0) << label;
        EXPECT_EQ(result.box, MaskBoundingBox(expected)) << label;
    };
    check(CombineShapes({a, b}, RoiOperation::Union, size), RasterizeMask(a, size) | RasterizeMask(b, size), "overlapping union");
    check(CombineShapes({a, far}, RoiOperation::Union, size), RasterizeMask(a, size) | RasterizeMask(far, size), "separate parts");
    check(CombineShapes({a, b}, RoiOperation::Subtract, size), RasterizeMask(a, size) & ~RasterizeMask(b, size), "subtract");
    check(CombineShapes({a, inner, far}, RoiOperation::Subtract, size), RasterizeMask(a, size) & ~RasterizeMask(inner, size), "hole");

    const OperationResult hole = CombineShapes({a, inner}, RoiOperation::Subtract, size);
    EXPECT_EQ(hole.pixel_count, 20 * 15 - 6 * 5);
    EXPECT_GT(hole.polygon.points.size(), 8u);

    const OperationResult nothing = CombineShapes({inner, a}, RoiOperation::Subtract, size);
    EXPECT_EQ(nothing.pixel_count, 0);
    EXPECT_TRUE(nothing.polygon.points.empty());
    EXPECT_EQ(CombineShapes({Rectangle(-10, -10, 5, 5), Rectangle(50, 50, 5, 5)}, RoiOperation::Union, size).pixel_count, 0);
    EXPECT_THROW(CombineShapes({}, RoiOperation::Union, size), std::invalid_argument);
}

TEST(RoiOperationsTest, IntersectAndXorMatchTheRasterizedShapes) {
    const cv::Size size(40, 30);
    const RoiShape a = Rectangle(2, 3, 20, 15);
    const RoiShape b = EllipseRoi{20, 15, 9, 6, 30};
    const RoiShape c = Rectangle(15, 0, 4, 30);
    const cv::Mat ma = RasterizeMask(a, size);
    const cv::Mat mb = RasterizeMask(b, size);
    const cv::Mat mc = RasterizeMask(c, size);

    const auto check = [&size](const OperationResult& result, const cv::Mat& expected, const char* label) {
        EXPECT_EQ(result.pixel_count, cv::countNonZero(expected)) << label;
        EXPECT_EQ(Differences(Rasterize(result.polygon.points, size), expected), 0) << label;
        EXPECT_EQ(result.box, MaskBoundingBox(expected)) << label;
    };
    check(CombineShapes({a, b}, RoiOperation::Intersect, size), ma & mb, "intersect two");
    check(CombineShapes({a, b, c}, RoiOperation::Intersect, size), ma & mb & mc, "intersect three");
    check(CombineShapes({a, b}, RoiOperation::Xor, size), ma ^ mb, "xor two");
    // Three shapes: the pixels covered once or three times
    check(CombineShapes({a, b, c}, RoiOperation::Xor, size), ma ^ mb ^ mc, "xor three");

    EXPECT_EQ(CombineShapes({a, Rectangle(30, 22, 5, 5)}, RoiOperation::Intersect, size).pixel_count, 0);
    EXPECT_EQ(CombineShapes({a, a}, RoiOperation::Xor, size).pixel_count, 0);
    EXPECT_EQ(CombineShapes({a, Rectangle(-10, -10, 5, 5)}, RoiOperation::Intersect, size).pixel_count, 0);
}

TEST(RoiOperationsTest, EnlargeShrinkAndBandMatchDistancesBetweenPixelCentres) {
    const cv::Size size(36, 28);
    // An ellipse, a rotated ellipse near the border, a ring with a hole and a thin diagonal, which exercise corners, the image
    // border, holes that close when enlarging and parts that vanish when shrinking
    const std::vector<RoiShape> shapes = {
        EllipseRoi{15, 12, 7, 4.5, 0},
        EllipseRoi{4, 20, 6, 3, 35},
        PolygonRoi{{{8, 4}, {26, 4}, {26, 22}, {8, 22}, {8, 4}, {13, 9}, {13, 17}, {21, 17}, {21, 9}, {13, 9}}},
        PolygonRoi{{{3, 2}, {4.2, 2}, {30.2, 26}, {29, 26}}},
    };
    const std::vector<cv::Point2d> spacings = {{1, 1}, {0.7, 1.3}, {0.46875, 0.46875}};
    const std::vector<double> distances = {0.5, 1, std::sqrt(2.0), 2, 3.3, 4.6875};
    for (size_t s = 0; s < shapes.size(); ++s) {
        const cv::Mat shape = RasterizeMask(shapes[s], size);
        for (const cv::Point2d spacing : spacings) {
            for (double distance : distances) {
                const std::string label = "shape " + std::to_string(s) + ", spacing " + std::to_string(spacing.x) + "×" +
                                          std::to_string(spacing.y) + ", distance " + std::to_string(distance);
                const cv::Mat enlarged = ReferenceWithin(shape, distance, spacing, false);
                const cv::Mat shrunk = shape & ~ReferenceWithin(~shape, distance, spacing, true);
                const cv::Mat band = enlarged & ~shape;
                for (const auto& [operation, expected, name] : {std::tuple{GrowOperation::Enlarge, enlarged, "enlarge"},
                         std::tuple{GrowOperation::Shrink, shrunk, "shrink"}, std::tuple{GrowOperation::Band, band, "band"}}) {
                    const OperationResult result = GrowShape(shapes[s], operation, distance, spacing, size);
                    EXPECT_EQ(result.pixel_count, cv::countNonZero(expected)) << name << ", " << label;
                    EXPECT_EQ(Differences(Rasterize(result.polygon.points, size), expected), 0) << name << ", " << label;
                }
            }
        }
    }

    // A single pixel enlarged by 1 gains its edge neighbours only; by the diagonal it gains the corners too
    const RoiShape pixel = Rectangle(10, 10, 1, 1);
    EXPECT_EQ(GrowShape(pixel, GrowOperation::Enlarge, 1, {1, 1}, size).pixel_count, 5);
    EXPECT_EQ(GrowShape(pixel, GrowOperation::Enlarge, std::sqrt(2.0), {1, 1}, size).pixel_count, 9);
    EXPECT_EQ(GrowShape(pixel, GrowOperation::Band, 1, {1, 1}, size).pixel_count, 4);
    // Shrinking works in from the image border, and a shape can vanish
    EXPECT_EQ(GrowShape(Rectangle(0, 0, 6, 6), GrowOperation::Shrink, 1, {1, 1}, size).pixel_count, 16);
    EXPECT_EQ(GrowShape(Rectangle(4, 4, 3, 3), GrowOperation::Shrink, 2, {1, 1}, size).pixel_count, 0);
    // Enlarging stops at the image border
    EXPECT_EQ(GrowShape(Rectangle(0, 0, 36, 28), GrowOperation::Enlarge, 50, {1, 1}, size).pixel_count, 36 * 28);
    EXPECT_EQ(GrowShape(Rectangle(-9, -9, 2, 2), GrowOperation::Enlarge, 3, {1, 1}, size).pixel_count, 0);

    EXPECT_THROW(GrowShape(pixel, GrowOperation::Enlarge, 0, {1, 1}, size), std::invalid_argument);
    EXPECT_THROW(GrowShape(pixel, GrowOperation::Enlarge, NAN, {1, 1}, size), std::invalid_argument);
    EXPECT_THROW(GrowShape(pixel, GrowOperation::Shrink, 1, {0, 1}, size), std::invalid_argument);
    EXPECT_THROW(GrowShape(pixel, GrowOperation::Band, 1, {1, INFINITY}, size), std::invalid_argument);
}

TEST(RoiOperationsTest, BrushStrokesPaintAndEraseTheCoveredPixels) {
    const cv::Size size(30, 25);
    const std::vector<std::array<double, 2>> dot{{10.3, 7.8}};
    const std::vector<std::array<double, 2>> line{{3.0, 20.0}, {18.5, 12.25}, {26.0, 21.0}};

    const OperationResult disc = PaintStroke(std::nullopt, dot, 3.0, false, size);
    const cv::Mat expected_disc = ReferenceStroke(dot, 3.0, size);
    EXPECT_EQ(disc.pixel_count, cv::countNonZero(expected_disc));
    EXPECT_EQ(Differences(Rasterize(disc.polygon.points, size), expected_disc), 0);

    const RoiShape base = Rectangle(5, 5, 15, 15);
    const OperationResult painted = PaintStroke(base, line, 2.5, false, size);
    const cv::Mat expected_painted = RasterizeMask(base, size) | ReferenceStroke(line, 2.5, size);
    EXPECT_EQ(Differences(Rasterize(painted.polygon.points, size), expected_painted), 0);

    // Erasing a band through the rectangle splits it into two parts
    const std::vector<std::array<double, 2>> band{{12.0, 0.0}, {12.0, 30.0}};
    const OperationResult split = PaintStroke(base, band, 1.5, true, size);
    const cv::Mat expected_split = RasterizeMask(base, size) & ~ReferenceStroke(band, 1.5, size);
    EXPECT_EQ(split.pixel_count, cv::countNonZero(expected_split));
    EXPECT_EQ(Differences(Rasterize(split.polygon.points, size), expected_split), 0);

    // A stroke over the image edge is clipped; erasing without a shape or everything leaves nothing
    const std::vector<std::array<double, 2>> corner{{0.0, 0.0}};
    EXPECT_EQ(Differences(
                  Rasterize(PaintStroke(std::nullopt, corner, 4.0, false, size).polygon.points, size), ReferenceStroke(corner, 4.0, size)),
        0);
    EXPECT_EQ(PaintStroke(std::nullopt, dot, 3.0, true, size).pixel_count, 0);
    EXPECT_EQ(PaintStroke(Rectangle(9, 7, 2, 2), dot, 5.0, true, size).pixel_count, 0);
    EXPECT_EQ(PaintStroke(std::nullopt, {{-50.0, -50.0}}, 2.0, false, size).pixel_count, 0);

    EXPECT_THROW(PaintStroke(std::nullopt, {}, 2.0, false, size), std::invalid_argument);
    EXPECT_THROW(PaintStroke(std::nullopt, dot, 0.0, false, size), std::invalid_argument);
    EXPECT_THROW(PaintStroke(std::nullopt, dot, NAN, false, size), std::invalid_argument);
    EXPECT_THROW(PaintStroke(std::nullopt, {{NAN, 1.0}}, 2.0, false, size), std::invalid_argument);
}
