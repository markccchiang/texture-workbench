#ifndef GLCM_REGION_SELECTION_HPP_
#define GLCM_REGION_SELECTION_HPP_

#include <array>
#include <limits>
#include <opencv2/core.hpp>
#include <optional>
#include <vector>

namespace glcm {

// A connected region of pixels, outlined as a polygon ROI
struct SelectedRegion {
    // Polygon along the pixel edges around the region with its holes filled, so that RasterizeMask of the polygon gives
    // exactly the region's pixels. The vertices are the pixel corners where the outline turns, clockwise on screen, starting
    // at the top-left corner of the region's first pixel in raster order. Parts joined only at a corner (8-connected) share
    // that corner, where the outline touches itself without crossing.
    std::vector<std::array<double, 2>> outline;
    int pixel_count = 0; // pixels of the region, holes included
    cv::Rect box;        // bounding box of the region
};

struct ThresholdSelection {
    // The largest regions first (equal sizes by the top, then the left edge of their bounding box), at most max_regions
    std::vector<SelectedRegion> regions;
    // Regions with at least min_pixels pixels, including those not returned
    int total = 0;
};

// Regions of the pixels with min_value <= value <= max_value in an 8- or 16-bit single-channel image: 8-connected parts
// with their holes filled (holes are background not 4-connected to the image border), so a part lying in another part's
// hole belongs to that region. Regions with fewer than min_pixels or more than max_pixels pixels, holes included, are left
// out, and so are regions whose sphericity (ShapeSphericity of analysis/Shape, in pixel units) is below min_sphericity.
// Throws std::invalid_argument for another image type, min_value > max_value, min_pixels < 1, max_pixels < min_pixels,
// max_regions < 0 or min_sphericity outside [0, 1].
ThresholdSelection SelectThresholdRegions(const cv::Mat& gray, int min_value, int max_value, int min_pixels, int max_regions,
    int max_pixels = std::numeric_limits<int>::max(), double min_sphericity = 0.0);

// The 8-connected region of pixels whose values differ by at most `tolerance` from the value of pixel (x, y), and that
// are connected to it, with its holes filled; nullopt when (x, y) lies outside the image.
// Throws std::invalid_argument for another image type or a negative tolerance.
std::optional<SelectedRegion> SelectWandRegion(const cv::Mat& gray, int x, int y, int tolerance);

} // namespace glcm

#endif // GLCM_REGION_SELECTION_HPP_
