#include "roi/RegionSelection.hpp"

#include <algorithm>
#include <cstdint>
#include <opencv2/imgproc.hpp>
#include <stdexcept>
#include <tuple>
#include <utility>

#include "analysis/Shape.hpp"
#include "roi/Outline.hpp"

namespace glcm {

namespace {

const uchar INSIDE = 255;
const uchar FLOODED = 128;

void CheckImage(const cv::Mat& gray) {
    if (gray.empty() || gray.channels() != 1 || (gray.depth() != CV_8U && gray.depth() != CV_16U)) {
        throw std::invalid_argument("The image must be an 8- or 16-bit single-channel image");
    }
}

// 255 where low <= value <= high
cv::Mat RangeMask(const cv::Mat& gray, int64_t low, int64_t high) {
    cv::Mat mask;
    cv::inRange(gray, cv::Scalar(static_cast<double>(low)), cv::Scalar(static_cast<double>(high)), mask);
    return mask;
}

// The mask with its holes set to 255: background pixels that are not 4-connected to the border. 4-connected background
// is the counterpart of 8-connected regions, so a diagonal gap does not let the background through.
cv::Mat FillHoles(const cv::Mat& mask) {
    cv::Mat padded;
    cv::copyMakeBorder(mask, padded, 1, 1, 1, 1, cv::BORDER_CONSTANT, cv::Scalar(0));
    cv::floodFill(padded, cv::Point(0, 0), cv::Scalar(FLOODED), nullptr, cv::Scalar(0), cv::Scalar(0), 4);
    cv::Mat filled = padded(cv::Rect(1, 1, mask.cols, mask.rows)) != FLOODED;
    return filled;
}

int PixelValue(const cv::Mat& gray, int x, int y) {
    return (gray.depth() == CV_16U) ? gray.at<uint16_t>(y, x) : gray.at<uchar>(y, x);
}

} // namespace

ThresholdSelection SelectThresholdRegions(
    const cv::Mat& gray, int min_value, int max_value, int min_pixels, int max_regions, int max_pixels, double min_sphericity) {
    CheckImage(gray);
    if (min_value > max_value) {
        throw std::invalid_argument("The threshold minimum must not be above its maximum");
    }
    if (min_pixels < 1) {
        throw std::invalid_argument("The minimum region size must be at least 1 pixel");
    }
    if (max_regions < 0) {
        throw std::invalid_argument("The maximum number of regions must not be negative");
    }
    if (max_pixels < min_pixels) {
        throw std::invalid_argument("The maximum region size must not be below the minimum size");
    }
    if (!(min_sphericity >= 0.0 && min_sphericity <= 1.0)) {
        throw std::invalid_argument("The minimum sphericity must lie between 0 and 1");
    }

    const cv::Mat filled = FillHoles(RangeMask(gray, min_value, max_value));
    cv::Mat labels;
    cv::Mat stats;
    cv::Mat centroids;
    const int count = cv::connectedComponentsWithStats(filled, labels, stats, centroids, 8, CV_32S);

    std::vector<int> candidates;
    for (int label = 1; label < count; ++label) {
        const int area = stats.at<int>(label, cv::CC_STAT_AREA);
        if (area < min_pixels || area > max_pixels) {
            continue;
        }
        if (min_sphericity > 0.0) {
            const cv::Rect box(stats.at<int>(label, cv::CC_STAT_LEFT), stats.at<int>(label, cv::CC_STAT_TOP),
                stats.at<int>(label, cv::CC_STAT_WIDTH), stats.at<int>(label, cv::CC_STAT_HEIGHT));
            const cv::Mat region = labels(box) == label;
            if (ComputeShapeFeatures(region, {1.0, 1.0}, {Type::ShapeSphericity}).at(Type::ShapeSphericity) < min_sphericity) {
                continue;
            }
        }
        candidates.push_back(label);
    }
    std::sort(candidates.begin(), candidates.end(), [&stats](int a, int b) {
        const auto key = [&stats](int label) {
            return std::make_tuple(-stats.at<int>(label, cv::CC_STAT_AREA), stats.at<int>(label, cv::CC_STAT_TOP),
                stats.at<int>(label, cv::CC_STAT_LEFT), label);
        };
        return key(a) < key(b);
    });

    ThresholdSelection selection;
    selection.total = static_cast<int>(candidates.size());
    const size_t returned = std::min(candidates.size(), static_cast<size_t>(max_regions));
    for (size_t i = 0; i < returned; ++i) {
        const int label = candidates[i];
        SelectedRegion region;
        region.pixel_count = stats.at<int>(label, cv::CC_STAT_AREA);
        region.box = cv::Rect(stats.at<int>(label, cv::CC_STAT_LEFT), stats.at<int>(label, cv::CC_STAT_TOP),
            stats.at<int>(label, cv::CC_STAT_WIDTH), stats.at<int>(label, cv::CC_STAT_HEIGHT));
        // The first pixel in raster order lies in the top row of the bounding box
        const int* top_row = labels.ptr<int>(region.box.y);
        int start_x = region.box.x;
        while (top_row[start_x] != label) {
            ++start_x;
        }
        region.outline = outline_detail::TraceOutline(
            start_x, region.box.y,
            [&labels, label](
                int x, int y) { return x >= 0 && y >= 0 && x < labels.cols && y < labels.rows && labels.at<int>(y, x) == label; },
            true);
        selection.regions.push_back(std::move(region));
    }
    return selection;
}

std::optional<SelectedRegion> SelectWandRegion(const cv::Mat& gray, int x, int y, int tolerance) {
    CheckImage(gray);
    if (tolerance < 0) {
        throw std::invalid_argument("The tolerance must not be negative");
    }
    if (x < 0 || y < 0 || x >= gray.cols || y >= gray.rows) {
        return std::nullopt;
    }

    const int64_t seed = PixelValue(gray, x, y);
    cv::Mat mask = RangeMask(gray, seed - tolerance, seed + tolerance);
    cv::Rect box;
    cv::floodFill(mask, cv::Point(x, y), cv::Scalar(FLOODED), &box, cv::Scalar(0), cv::Scalar(0), 8);
    const cv::Mat region = FillHoles(mask(box) == FLOODED);

    SelectedRegion result;
    result.box = box;
    result.pixel_count = cv::countNonZero(region);
    const uchar* top_row = region.ptr<uchar>(0);
    int start_x = 0;
    while (top_row[start_x] != INSIDE) {
        ++start_x;
    }
    const auto inside = [&region, &box](int px, int py) {
        const int local_x = px - box.x;
        const int local_y = py - box.y;
        return local_x >= 0 && local_y >= 0 && local_x < region.cols && local_y < region.rows &&
               region.at<uchar>(local_y, local_x) == INSIDE;
    };
    result.outline = outline_detail::TraceOutline(start_x + box.x, box.y, inside, true);
    return result;
}

} // namespace glcm
