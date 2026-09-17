#ifndef GLCM_DICOM_READER_HPP_
#define GLCM_DICOM_READER_HPP_

#include <cstdint>
#include <opencv2/core.hpp>
#include <string>
#include <vector>

#include "imaging/ImageLoader.hpp"

namespace glcm {

// True for DICOM Part 10 files: 128 bytes of preamble followed by "DICM"
bool IsDicomFile(const std::string& path);
bool IsDicomBytes(const std::vector<uchar>& bytes);

// Reads the first frame of an uncompressed DICOM file (implicit or explicit VR little endian).
// - Grayscale (MONOCHROME1/2, 8 or 16 bits allocated, any bits stored, signed or unsigned): the rescale slope and
//   intercept are applied and the values stored as described by ChooseStorage (imaging/ValueConversion.hpp), with
//   clipping below -1024 allowed for CT (Hounsfield units). MONOCHROME1 is inverted, so bright means dense. The
//   conversion is recorded in info.value_conversion when the stored samples differ from the file's samples.
// - RGB (8 or 16 bits) is converted to grayscale with `colour` (imaging/ColourConversion.hpp).
// - PixelSpacing, else ImagerPixelSpacing, gives info.pixel_spacing; the first WindowCenter/WindowWidth gives window.
// Throws std::invalid_argument for files that are valid but not supported (compressed or big-endian transfer syntaxes,
// palette colour, no pixel data), std::runtime_error for malformed or truncated files, and ImageTooLargeError (checked
// before the pixels are read) when max_pixels > 0 is exceeded.
LoadedImage LoadDicomFile(const std::string& path, int64_t max_pixels = 0, ColourConversion colour = ColourConversion::Luminance);
LoadedImage LoadDicomBytes(const std::vector<uchar>& bytes, int64_t max_pixels = 0, ColourConversion colour = ColourConversion::Luminance);

// Every frame of a DICOM file as the slices of a stack, decoded as LoadDicomFile decodes one frame, with one storage for
// all frames. max_pixels limits a frame, max_stack_pixels (> 0) all frames together (StackTooLargeError, before the
// pixels are read). Enhanced DICOM files keep their per-frame attributes in sequences, which are not read (a warning).
LoadedStack LoadDicomStackFile(
    const std::string& path, int64_t max_pixels = 0, int64_t max_stack_pixels = 0, ColourConversion colour = ColourConversion::Luminance);

// The files of a DICOM series (single-frame images) as one stack: files that are not DICOM images are left out, only the
// series (SeriesInstanceUID) with the most files is used, and the slices are ordered along the normal of the image plane
// (ImagePositionPatient and ImageOrientationPatient), else by InstanceNumber, else kept in the order of the paths. Values are stored with
// one storage for all files; the window is the first file's that has one, the pixel spacing the first file's. Throws std::invalid_argument
// when no file is a DICOM image, or the images differ in size or colour.
LoadedStack LoadDicomSeries(const std::vector<std::string>& paths, int64_t max_pixels = 0, int64_t max_stack_pixels = 0);

} // namespace glcm

#endif // GLCM_DICOM_READER_HPP_
