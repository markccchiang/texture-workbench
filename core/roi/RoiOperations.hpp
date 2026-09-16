#ifndef GLCM_ROI_OPERATIONS_HPP_
#define GLCM_ROI_OPERATIONS_HPP_

#include <array>
#include <opencv2/core.hpp>
#include <optional>
#include <vector>

#include "roi/Roi.hpp"

namespace glcm {

enum class RoiOperation {
    Union,     // the pixels of any shape
    Subtract,  // the pixels of the first shape that no other shape covers
    Intersect, // the pixels every shape covers
    Xor        // the pixels an odd number of shapes cover (for two shapes: covered by exactly one)
};

enum class GrowOperation {
    Enlarge, // the image pixels within the distance of a pixel of the shape
    Shrink,  // the pixels of the shape farther than the distance from every pixel outside it
    Band     // the pixels Enlarge adds: within the distance of the shape, but not in it
};

// A shape computed on the pixel grid, as one polygon ROI
struct OperationResult {
    PolygonRoi polygon; // no points when no pixel is left
    int pixel_count = 0;
    cv::Rect box; // bounding box of the pixels; empty when none is left
};

// A polygon whose pixels (RasterizeMask, pixel-centre rule) are exactly the non-zero pixels of `mask`, with mask pixel
// (c, r) at image pixel (offset.x + c, offset.y + r). It consists of the outline of every 8-connected part and of every hole
// (background not 4-connected to the outside) along the pixel edges, joined into one polygon by straight cuts from loop to
// loop. Each cut is traversed once in each direction, so under the even-odd rule it adds no crossings and the polygon covers
// the parts without the holes. Empty for a mask without non-zero pixels. Throws std::invalid_argument for a mask that is not
// CV_8UC1.
std::vector<std::array<double, 2>> MaskOutline(const cv::Mat& mask, cv::Point offset = cv::Point());

// Union, subtraction, intersection or exclusive or of shapes rasterized on an image of the given size (shapes are clipped to the
// image). Throws std::invalid_argument for an empty list or an invalid shape.
OperationResult CombineShapes(const std::vector<RoiShape>& shapes, RoiOperation operation, cv::Size image_size);

// A shape enlarged, shrunk or turned into a band around it, on the pixel grid of an image of the given size. Distances are
// measured between pixel centres, with `spacing.x` between neighbouring columns and `spacing.y` between neighbouring rows (1, 1
// for pixels, or the pixel spacing for millimetres); a pixel is within the distance when it is not farther, so enlarging a
// single pixel by 1 adds its four edge neighbours but not the diagonal ones. Shrinking is the exact counterpart: a pixel stays
// when enlarging the outside of the shape by the same distance would not reach it. Pixels outside the image count as outside
// the shape, so shrinking also works in from the image border. Throws std::invalid_argument for a distance or spacing that
// is not positive and finite, or an invalid shape.
OperationResult GrowShape(const RoiShape& shape, GrowOperation operation, double distance, cv::Point2d spacing, cv::Size image_size);

// A brush stroke: the pixels whose centres lie within `radius` of the polyline `path` (a single point paints a disc),
// added to `shape`, or removed from it when `erase` is set. Without a shape, painting gives the stroke alone and erasing
// gives nothing. Throws std::invalid_argument for an empty path, a radius that is not positive and finite, non-finite path
// coordinates or an invalid shape.
OperationResult PaintStroke(
    const std::optional<RoiShape>& shape, const std::vector<std::array<double, 2>>& path, double radius, bool erase, cv::Size image_size);

} // namespace glcm

#endif // GLCM_ROI_OPERATIONS_HPP_
