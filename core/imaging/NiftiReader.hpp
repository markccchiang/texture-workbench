#ifndef GLCM_NIFTI_READER_HPP_
#define GLCM_NIFTI_READER_HPP_

#include <array>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "imaging/ImageLoader.hpp"
#include "imaging/ValueConversion.hpp"

namespace glcm {

// Slices of a volume, in RAS (patient right, anterior, superior) orientation:
// - Axial: a plane of constant S; columns run from the patient's left to right (the right is on the image's right),
//   rows from anterior (top) to posterior
// - Coronal: constant A; columns from left to right, rows from superior (top) to inferior
// - Sagittal: constant R; columns from posterior to anterior, rows from superior (top) to inferior
// Slice 0 is the most inferior (axial), posterior (coronal) or left (sagittal) one.
enum class SliceOrientation { Axial = 0, Coronal = 1, Sagittal = 2 };

struct SliceGeometry {
    int64_t count = 0; // slices in the volume
    int64_t width = 0;
    int64_t height = 0;
    std::optional<PixelSpacing> pixel_spacing; // in millimetres; absent when the file gives no voxel size
};

struct NiftiVolumeInfo {
    int version = 1;                       // NIfTI-1 or NIfTI-2
    std::array<int64_t, 3> dimensions{};   // voxels along the file's axes i, j, k
    int64_t volumes = 1;                   // the 4th dimension (e.g. time points)
    std::string data_type;                 // "uint8", "int16", "float32", ...
    std::string orientation_source;        // "sform", "qform" or "none" (axes assumed RAS)
    std::string axis_codes;                // the direction of the i, j and k axes, e.g. "RAS" or "LPI"
    std::array<SliceGeometry, 3> slices{}; // indexed by SliceOrientation
    // The orientation of the plane of the i and j axes, where 3D files are usually acquired, and 2D files have their image
    SliceOrientation acquisition_orientation = SliceOrientation::Axial;
    // The values after scl_slope and scl_inter, over the finite voxels of all volumes (0 when there are none)
    double minimum = 0;
    double maximum = 0;
    StorageChoice storage;                           // how every slice of the file is stored
    std::optional<ValueConversion> value_conversion; // absent when the samples are stored unchanged
    DisplayWindow window;                            // 0.5th and 99.5th percentiles of the stored samples of all volumes
    std::vector<std::string> warnings;
};

// Thrown when the voxel data of a volume is larger than allowed
class VolumeTooLargeError : public std::runtime_error {
public:
    VolumeTooLargeError(uint64_t bytes, uint64_t max_bytes);
};

// True for a single-file NIfTI-1 or NIfTI-2 header, gzip-compressed or not
bool IsNiftiFile(const std::string& path);

// Reads the header and scans the voxels of a .nii or .nii.gz file, which chooses the storage of its values
// (ChooseStorage with the minimum and maximum of all volumes, so every slice is stored the same way).
// With uncompressed_copy, the file is also written there uncompressed, for fast access to slices.
// With max_data_bytes > 0, VolumeTooLargeError is thrown before the voxels are read when the declared data is larger.
// Throws std::invalid_argument for files that are valid but not supported (.hdr/.img pairs, more than 4 dimensions,
// RGB or complex data) and std::runtime_error for malformed or truncated files.
NiftiVolumeInfo InspectNiftiVolume(const std::string& path, const std::string& uncompressed_copy = "", uint64_t max_data_bytes = 0);

// One slice (0-based) of one volume (0-based) as a 2D image, stored as given by InspectNiftiVolume's storage, with the
// in-plane voxel size as pixel spacing and the conversion in info.value_conversion. The window is not set.
// Throws std::invalid_argument when the slice or volume is out of range, and ImageTooLargeError (before the voxels are
// read) when max_pixels > 0 is exceeded.
LoadedImage ExtractNiftiSlice(const std::string& path, SliceOrientation orientation, int64_t slice, int64_t volume,
    const StorageChoice& storage, int64_t max_pixels = 0);

// Every slice of one volume (0-based) in one orientation as a stack, slice 0 first, each laid out and stored exactly as
// ExtractNiftiSlice gives it. The file is read once, in its own order. max_pixels limits a slice, max_stack_pixels (> 0) the
// stack (StackTooLargeError, before the voxels are read). The window is not set.
LoadedStack ExtractNiftiStack(const std::string& path, SliceOrientation orientation, int64_t volume, const StorageChoice& storage,
    int64_t max_pixels = 0, int64_t max_stack_pixels = 0);

// A NIfTI file holding a single 2D image (one slice and one volume); std::invalid_argument for volumes, which need a
// slice to be chosen (InspectNiftiVolume and ExtractNiftiSlice)
LoadedImage LoadNiftiFile(const std::string& path, int64_t max_pixels = 0);

const char* SliceOrientationId(SliceOrientation orientation); // "axial", "coronal", "sagittal"

} // namespace glcm

#endif // GLCM_NIFTI_READER_HPP_
