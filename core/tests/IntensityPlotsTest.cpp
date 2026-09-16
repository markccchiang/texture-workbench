#include <gtest/gtest.h>

#include <cmath>
#include <opencv2/core.hpp>
#include <stdexcept>

#include "imaging/IntensityPlots.hpp"
#include "pipeline/AnalysisRunner.hpp"
#include "roi/Roi.hpp"

using namespace glcm;

TEST(IntensityPlotsTest, LineProfileSamplesEveryPixelAlongTheLine) {
    // value = 10 × column + row, so interpolation along a line is exact
    cv::Mat gray(20, 30, CV_16UC1);
    for (int row = 0; row < gray.rows; ++row) {
        for (int col = 0; col < gray.cols; ++col) {
            gray.at<uint16_t>(row, col) = static_cast<uint16_t>(10 * col + row);
        }
    }
    // Through pixel centres: exactly the pixel values
    LineProfile profile = ComputeLineProfile(gray, {2.5, 3.5}, {12.5, 3.5});
    ASSERT_EQ(profile.values.size(), 11u);
    EXPECT_EQ(profile.length, 10);
    EXPECT_EQ(profile.step, 1);
    for (int k = 0; k <= 10; ++k) {
        EXPECT_DOUBLE_EQ(profile.values[static_cast<size_t>(k)], 10 * (2 + k) + 3) << k;
    }
    // A diagonal of length 5 √2 ≈ 7.07: 8 samples, step L / 7, halfway between centres
    profile = ComputeLineProfile(gray, {5.0, 5.0}, {10.0, 10.0});
    ASSERT_EQ(profile.values.size(), 8u);
    EXPECT_NEAR(profile.step, 5 * std::sqrt(2.0) / 7, 1e-12);
    EXPECT_NEAR(profile.values.front(), 10 * 4.5 + 4.5, 1e-9);
    EXPECT_NEAR(profile.values.back(), 10 * 9.5 + 9.5, 1e-9);

    // Beyond the outer centres the edge value holds; outside the image there is no value
    profile = ComputeLineProfile(gray, {0.0, 0.25}, {-1.0, 0.25});
    ASSERT_EQ(profile.values.size(), 2u);
    EXPECT_EQ(profile.values[0], 0);
    EXPECT_TRUE(std::isnan(profile.values[1]));
    EXPECT_EQ(ComputeLineProfile(gray, {3, 3}, {3.2, 3}).values.size(), 1u);

    EXPECT_THROW(ComputeLineProfile(gray, {0, NAN}, {1, 1}), std::invalid_argument);
    EXPECT_THROW(ComputeLineProfile(cv::Mat(4, 4, CV_32FC1), {0, 0}, {1, 1}), std::invalid_argument);
}

TEST(IntensityPlotsTest, RoiHistogramCountsThePixelsOfTheMask) {
    cv::Mat gray(40, 50, CV_16UC1);
    cv::randu(gray, 1000, 1300);
    const RoiShape shape = EllipseRoi{25, 20, 15, 10, 30};
    const RoiHistogram histogram = ComputeRoiHistogram(gray, shape, 64);

    // Compared with the mask and the ROI statistics
    const cv::Mat mask = RasterizeMask(shape, gray.size());
    const RegionStatistics statistics = ComputeRegionStatistics(gray, mask);
    EXPECT_EQ(histogram.pixel_count, statistics.pixel_count);
    EXPECT_EQ(histogram.min, statistics.min);
    EXPECT_EQ(histogram.max, statistics.max);
    EXPECT_NEAR(histogram.mean, statistics.mean, 1e-9);
    EXPECT_NEAR(histogram.std, statistics.std, 1e-9);

    // The smallest whole bin width with at most 64 bins over min–max, and every pixel in its bin
    const int range = histogram.max - histogram.min + 1;
    EXPECT_EQ(histogram.bin_width, (range + 63) / 64);
    EXPECT_LE(histogram.counts.size(), 64u);
    std::vector<int64_t> expected(histogram.counts.size(), 0);
    std::vector<int64_t> frequency(65536, 0);
    for (int row = 0; row < gray.rows; ++row) {
        for (int col = 0; col < gray.cols; ++col) {
            if (mask.at<uchar>(row, col) == 255) {
                const int value = gray.at<uint16_t>(row, col);
                ++expected[static_cast<size_t>((value - histogram.bin_start) / histogram.bin_width)];
                ++frequency[static_cast<size_t>(value)];
            }
        }
    }
    EXPECT_EQ(histogram.counts, expected);
    EXPECT_EQ(histogram.mode, std::max_element(frequency.begin(), frequency.end()) - frequency.begin());

    // 8-bit, one bin per value
    cv::Mat eight(10, 10, CV_8UC1, cv::Scalar(7));
    eight.at<uchar>(2, 2) = 9;
    const RoiHistogram small = ComputeRoiHistogram(eight, RectangleRoi{0, 0, 10, 10}, 256);
    EXPECT_EQ(small.counts, (std::vector<int64_t>{99, 0, 1}));
    EXPECT_EQ(small.mode, 7);

    EXPECT_EQ(ComputeRoiHistogram(eight, RectangleRoi{20, 20, 5, 5}, 256).pixel_count, 0);
    EXPECT_THROW(ComputeRoiHistogram(eight, RectangleRoi{0, 0, 5, 5}, 0), std::invalid_argument);
}
