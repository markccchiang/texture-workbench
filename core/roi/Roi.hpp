#ifndef GLCM_ROI_HPP_
#define GLCM_ROI_HPP_

#include <array>
#include <opencv2/core.hpp>
#include <string>
#include <variant>
#include <vector>

namespace glcm {

// ROI shapes in image pixel coordinates. Pixel (column c, row r) covers the square [c, c + 1) x [r, r + 1), so its
// centre is (c + 0.5, r + 0.5). This matches drawing the image at the origin of a canvas with one unit per pixel.

struct RectangleRoi {
    double x = 0.0; // left edge
    double y = 0.0; // top edge
    double width = 0.0;
    double height = 0.0;
};

struct EllipseRoi {
    double cx = 0.0;
    double cy = 0.0;
    double rx = 0.0;        // semi-axis along the ellipse's own x axis
    double ry = 0.0;        // semi-axis along the ellipse's own y axis
    double angle_deg = 0.0; // rotation in degrees, clockwise on screen (the y axis points down)
};

struct PolygonRoi {
    std::vector<std::array<double, 2>> points; // (x, y) vertices; the last vertex connects back to the first
    bool freehand = false;                     // drawn freehand; rasterized like any other polygon
};

using RoiShape = std::variant<RectangleRoi, EllipseRoi, PolygonRoi>;

struct Roi {
    std::string id;
    std::string name;
    std::string color; // "#RRGGBB"
    RoiShape shape;
    std::string class_name; // class of the ROI, e.g. "lesion"; empty when it has none. Carried into results and exports.
    int slice = 0;          // the slice of a stack the ROI lies on, from 1; 0 for an image without slices
};

// Mask of the pixels whose centre lies inside the shape: CV_8UC1 of the given size, 255 inside and 0 outside.
// - Rectangle: half-open, a centre on the right or bottom edge is outside. A negative width or height is allowed.
// - Ellipse: a centre on the boundary is inside. Zero or negative semi-axes give an empty mask.
// - Polygon: even-odd rule with half-open crossings, so self-intersecting polygons alternate inside/outside.
//   Fewer than 3 vertices give an empty mask.
// Shapes are clipped to the image. Non-finite coordinates throw std::invalid_argument.
cv::Mat RasterizeMask(const RoiShape& shape, cv::Size image_size);

// The same mask restricted to a box around the shape, so that small ROIs on large images neither allocate nor visit the
// whole image: `mask` has the size of `box`, which lies inside the image, and mask pixel (c, r) is image pixel
// (box.x + c, box.y + r). Every pixel outside `box` is outside the shape, so RasterizeMask(shape, size)(box) equals `mask`
// and the full mask is 0 elsewhere. `box` may be larger than MaskBoundingBox(mask). Both are empty when the shape covers
// no pixel of the image. Analysing image(box) with `mask` gives the same results as the whole image with the full mask.
struct CroppedMask {
    cv::Rect box;
    cv::Mat mask;
};
CroppedMask RasterizeCroppedMask(const RoiShape& shape, cv::Size image_size);

// Smallest rectangle containing all non-zero mask pixels; an empty cv::Rect for an empty mask
cv::Rect MaskBoundingBox(const cv::Mat& mask);

// Number of non-zero mask pixels (0 for an empty mask)
int CountMaskPixels(const cv::Mat& mask);

} // namespace glcm

#endif // GLCM_ROI_HPP_
