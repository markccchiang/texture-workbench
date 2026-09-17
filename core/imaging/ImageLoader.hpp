#ifndef GLCM_IMAGE_LOADER_HPP_
#define GLCM_IMAGE_LOADER_HPP_

#include <cstdint>
#include <opencv2/core.hpp>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "imaging/ColourConversion.hpp"
#include "imaging/ImageHeader.hpp"
#include "imaging/ValueConversion.hpp"

namespace glcm {

struct ImageInfo {
    int width = 0;
    int height = 0;
    int bit_depth = 0;       // 8 or 16
    int source_channels = 0; // channels of the decoded file before grayscale conversion (1 or 3)
    // Millimetres per pixel from the file's resolution (see ImageSize::pixel_spacing), after the EXIF orientation
    // DICOM: PixelSpacing or ImagerPixelSpacing; NIfTI: the in-plane voxel size
    std::optional<PixelSpacing> pixel_spacing;
    // DICOM and NIfTI: how the file's values became the stored samples; absent when they are stored unchanged
    std::optional<ValueConversion> value_conversion;
};

// A display window of stored samples, min <= max
struct DisplayWindow {
    int min = 0;
    int max = 0;
};

// A decoded image, ready for analysis: single-channel CV_8UC1 or CV_16UC1
struct LoadedImage {
    cv::Mat gray;
    ImageInfo info;
    std::vector<std::string> warnings; // e.g. "Color image converted to grayscale"
    // The window the file asks for (DICOM WindowCenter/WindowWidth, or the percentiles of a whole NIfTI volume)
    std::optional<DisplayWindow> window;
};

// The largest number of slices of a stack
inline constexpr int MAX_SLICES = 100000;

// A stack of images of the same size and bit depth (the pages of a TIFF, the frames of a DICOM file, the files of a DICOM
// series, the slices of a NIfTI volume); a single image is a stack of one slice
struct LoadedStack {
    cv::Mat pixels; // CV_8UC1 or CV_16UC1, the slices one below the other: info.height × slices rows
    int slices = 1;
    ImageInfo info; // the size of one slice
    std::vector<std::string> warnings;
    std::optional<DisplayWindow> window;
    std::string series_description; // DICOM series: the SeriesDescription; empty otherwise

    // Slice `index` (from 0), sharing the pixels
    cv::Mat Slice(int index) const {
        return pixels.rowRange(index * info.height, (index + 1) * info.height);
    }
};

// Thrown when a stack has more pixels than allowed, before its pixels are decoded
class StackTooLargeError : public std::runtime_error {
public:
    StackTooLargeError(int64_t width, int64_t height, int64_t slices, int64_t max_pixels);
};

// Thrown when an image has more pixels than allowed. When the limit is checked from the header (see LoadImageFile), the
// pixels have not been decoded.
class ImageTooLargeError : public std::runtime_error {
public:
    ImageTooLargeError(int64_t width, int64_t height, int64_t max_pixels);
};

// Reads an image file (PNG, JPEG, BMP, 8/16-bit TIFF, ...; uncompressed DICOM with imaging/DicomReader.hpp and 2D NIfTI
// with imaging/NiftiReader.hpp, recognized by their content). The bit depth is kept, colour images are converted to
// grayscale with `colour` (imaging/ColourConversion.hpp; the value conversion of a conversion other than the luminance is
// recorded in info.value_conversion), an alpha channel is ignored and the EXIF orientation is applied.
// Throws std::runtime_error if the file cannot be read or decoded, and std::invalid_argument for bit depths other than
// 8 and 16.
// With max_pixels > 0, the size is first read from the header (imaging/ImageHeader.hpp), so an image above the limit
// throws ImageTooLargeError before the decoder allocates memory for it; files that are not PNG, JPEG, BMP or TIFF then
// throw std::runtime_error, because their size cannot be checked in advance.
LoadedImage LoadImageFile(const std::string& path, int64_t max_pixels = 0, ColourConversion colour = ColourConversion::Luminance);

// Reads an image file as a stack: every page of a multi-page TIFF (up to the first page of another size, type or bit
// depth, with a warning), every frame of a DICOM file, and otherwise the single image LoadImageFile reads. max_pixels
// limits one slice, max_stack_pixels (> 0) all slices together; both are checked before the pixels are decoded.
LoadedStack LoadImageStackFile(
    const std::string& path, int64_t max_pixels = 0, int64_t max_stack_pixels = 0, ColourConversion colour = ColourConversion::Luminance);

// A stack as an uncompressed little-endian TIFF: one 8- or 16-bit grayscale page per slice, with the pixel spacing as the
// resolution in pixels per centimetre and, when not empty, `description` as the ImageDescription of every page (so that
// equal samples made for different purposes give different files). LoadImageStackFile reads it back with the same samples.
std::vector<uchar> EncodeTiffStack(const LoadedStack& stack, const std::string& description = "");

// Same as LoadImageFile, for an encoded image held in memory (e.g. an upload)
LoadedImage LoadImageBytes(const std::vector<uchar>& bytes, int64_t max_pixels = 0, ColourConversion colour = ColourConversion::Luminance);

} // namespace glcm

#endif // GLCM_IMAGE_LOADER_HPP_
