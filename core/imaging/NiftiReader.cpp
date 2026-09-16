#include "imaging/NiftiReader.hpp"

#include <zlib.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <fstream>
#include <functional>
#include <limits>

namespace glcm {

namespace {

constexpr size_t NIFTI1_HEADER_SIZE = 348;
constexpr size_t NIFTI2_HEADER_SIZE = 540;
constexpr size_t CHUNK_BYTES = 4 * 1024 * 1024;
constexpr uint64_t MAX_VOXEL_BYTES = uint64_t{1} << 62;

struct DataType {
    int code;
    const char* name;
    size_t bytes;
    bool integer;
    bool is_signed;
};

constexpr std::array<DataType, 10> DATA_TYPES = {{
    {2, "uint8", 1, true, false},
    {4, "int16", 2, true, true},
    {8, "int32", 4, true, true},
    {16, "float32", 4, false, true},
    {64, "float64", 8, false, true},
    {256, "int8", 1, true, true},
    {512, "uint16", 2, true, false},
    {768, "uint32", 4, true, false},
    {1024, "int64", 8, true, true},
    {1280, "uint64", 8, true, false},
}};

// Sequential reading of a file that may be gzip-compressed (zlib reads uncompressed files as they are)
class Input {
public:
    explicit Input(const std::string& path) : _file(gzopen(path.c_str(), "rb")) {
        if (_file == nullptr) {
            throw std::runtime_error("Cannot read the file: " + path);
        }
        gzbuffer(_file, 1 << 17);
    }
    Input(const Input&) = delete;
    Input& operator=(const Input&) = delete;
    ~Input() {
        gzclose(_file);
    }

    size_t Read(uint8_t* out, size_t count) {
        size_t total = 0;
        while (total < count) {
            const auto chunk = static_cast<unsigned>(std::min<size_t>(count - total, 1u << 30));
            const int read = gzread(_file, out + total, chunk);
            if (read < 0) {
                throw std::runtime_error("Truncated or corrupt compressed NIfTI file");
            }
            if (read == 0) {
                break;
            }
            total += static_cast<size_t>(read);
        }
        _position += total;
        return total;
    }

    void ReadExactly(uint8_t* out, size_t count) {
        if (Read(out, count) != count) {
            throw std::runtime_error("Truncated NIfTI file");
        }
    }

    // Forward seeks in compressed files decompress the bytes in between
    void Seek(uint64_t offset) {
        if (offset == _position) {
            return;
        }
        if (gzseek(_file, static_cast<z_off_t>(offset), SEEK_SET) < 0) {
            throw std::runtime_error("Truncated NIfTI file");
        }
        _position = offset;
    }

private:
    gzFile _file;
    uint64_t _position = 0;
};

uint64_t Unsigned(const uint8_t* bytes, size_t count, bool little_endian) {
    uint64_t value = 0;
    for (size_t i = 0; i < count; ++i) {
        value = (value << 8) | bytes[little_endian ? count - 1 - i : i];
    }
    return value;
}

int64_t Signed(const uint8_t* bytes, size_t count, bool little_endian) {
    const uint64_t value = Unsigned(bytes, count, little_endian);
    if (count < 8 && (value & (uint64_t{1} << (count * 8 - 1)))) {
        return static_cast<int64_t>(value) - (int64_t{1} << (count * 8));
    }
    return static_cast<int64_t>(value);
}

double Float32(const uint8_t* bytes, bool little_endian) {
    const auto bits = static_cast<uint32_t>(Unsigned(bytes, 4, little_endian));
    float value = 0;
    std::memcpy(&value, &bits, sizeof value);
    return value;
}

double Float64(const uint8_t* bytes, bool little_endian) {
    const uint64_t bits = Unsigned(bytes, 8, little_endian);
    double value = 0;
    std::memcpy(&value, &bits, sizeof value);
    return value;
}

double Decode(const uint8_t* bytes, const DataType& type, bool little_endian) {
    if (!type.integer) {
        return type.bytes == 4 ? Float32(bytes, little_endian) : Float64(bytes, little_endian);
    }
    if (type.is_signed) {
        return static_cast<double>(Signed(bytes, type.bytes, little_endian));
    }
    return static_cast<double>(Unsigned(bytes, type.bytes, little_endian));
}

using Affine = std::array<std::array<double, 4>, 3>; // voxel (i, j, k, 1) to RAS millimetres

struct Header {
    int version = 1;
    size_t size = NIFTI1_HEADER_SIZE;
    bool little_endian = true;
    std::array<uint8_t, NIFTI2_HEADER_SIZE> bytes{};
    const DataType* type = nullptr;
    std::array<int64_t, 3> dimensions{};
    int64_t volumes = 1;
    uint64_t voxel_offset = 0;
    uint64_t data_bytes = 0;
    double slope = 1;
    double intercept = 0;
    bool rescaled = false;
    Affine affine{};
    std::string orientation_source;
    std::vector<std::string> warnings;
};

double Norm(const Affine& affine, int column) {
    return std::sqrt(affine[0][column] * affine[0][column] + affine[1][column] * affine[1][column] + affine[2][column] * affine[2][column]);
}

bool IsInteger(double value) {
    return std::isfinite(value) && std::abs(value - std::round(value)) < 1e-9;
}

// Reads and checks the header; the input is left after the header
Header ReadHeader(Input& input) {
    Header header;
    input.ReadExactly(header.bytes.data(), 4);
    const auto size_le = Unsigned(header.bytes.data(), 4, true);
    const auto size_be = Unsigned(header.bytes.data(), 4, false);
    if (size_le == NIFTI1_HEADER_SIZE || size_be == NIFTI1_HEADER_SIZE) {
        header.version = 1;
        header.little_endian = size_le == NIFTI1_HEADER_SIZE;
        header.size = NIFTI1_HEADER_SIZE;
    } else if (size_le == NIFTI2_HEADER_SIZE || size_be == NIFTI2_HEADER_SIZE) {
        header.version = 2;
        header.little_endian = size_le == NIFTI2_HEADER_SIZE;
        header.size = NIFTI2_HEADER_SIZE;
    } else {
        throw std::runtime_error("Not a NIfTI file");
    }
    input.ReadExactly(header.bytes.data() + 4, header.size - 4);
    const uint8_t* b = header.bytes.data();
    const bool le = header.little_endian;
    const bool v1 = header.version == 1;

    const char* magic = reinterpret_cast<const char*>(b + (v1 ? 344 : 4));
    if (std::memcmp(magic, v1 ? "ni1\0" : "ni2\0", 4) == 0) {
        throw std::invalid_argument("NIfTI header and image pairs (.hdr/.img) are not supported; convert them to a single .nii file");
    }
    if (std::memcmp(magic, v1 ? "n+1\0" : "n+2\0", 4) != 0) {
        throw std::runtime_error("Invalid NIfTI header: unknown magic");
    }

    const int datatype = static_cast<int>(Signed(b + (v1 ? 70 : 12), 2, le));
    const auto* type = std::find_if(DATA_TYPES.begin(), DATA_TYPES.end(), [&](const DataType& t) { return t.code == datatype; });
    if (type == DATA_TYPES.end()) {
        throw std::invalid_argument("The NIfTI data type " + std::to_string(datatype) +
                                    " is not supported; only 8-, 16-, 32- and 64-bit integers and 32- and 64-bit floating point are");
    }
    header.type = &*type;

    std::array<int64_t, 8> dim{};
    std::array<double, 8> pixdim{};
    for (int d = 0; d < 8; ++d) {
        dim[d] = v1 ? Signed(b + 40 + 2 * d, 2, le) : Signed(b + 16 + 8 * d, 8, le);
        pixdim[d] = v1 ? Float32(b + 76 + 4 * d, le) : Float64(b + 104 + 8 * d, le);
    }
    if (dim[0] < 1 || dim[0] > 7) {
        throw std::runtime_error("Invalid NIfTI header: the number of dimensions must be 1 to 7");
    }
    for (int d = 1; d <= dim[0]; ++d) {
        if (dim[d] < 1) {
            throw std::runtime_error("Invalid NIfTI header: every dimension must be at least 1");
        }
        if (d > 4 && dim[d] > 1) {
            throw std::invalid_argument("NIfTI files with more than 4 dimensions are not supported");
        }
    }
    const auto size_of = [&](int d) { return d <= dim[0] ? dim[d] : int64_t{1}; };
    header.dimensions = {size_of(1), size_of(2), size_of(3)};
    header.volumes = size_of(4);
    uint64_t voxels = 1;
    for (int64_t n : {header.dimensions[0], header.dimensions[1], header.dimensions[2], header.volumes}) {
        if (static_cast<uint64_t>(n) > MAX_VOXEL_BYTES / voxels / header.type->bytes) {
            throw std::runtime_error("Invalid NIfTI header: the volume is too large");
        }
        voxels *= static_cast<uint64_t>(n);
    }
    header.data_bytes = voxels * header.type->bytes;

    const double voxel_offset = v1 ? Float32(b + 108, le) : static_cast<double>(Signed(b + 168, 8, le));
    if (!std::isfinite(voxel_offset) || voxel_offset < static_cast<double>(header.size) || voxel_offset > 1e12) {
        throw std::runtime_error("Invalid NIfTI header: vox_offset must follow the header");
    }
    header.voxel_offset = static_cast<uint64_t>(voxel_offset);

    const double slope = v1 ? Float32(b + 112, le) : Float64(b + 176, le);
    const double intercept = v1 ? Float32(b + 116, le) : Float64(b + 184, le);
    // scl_slope 0 (or not a number) means that the values are not scaled
    if (std::isfinite(slope) && slope != 0) {
        header.slope = slope;
        header.intercept = std::isfinite(intercept) ? intercept : 0;
        header.rescaled = header.slope != 1 || header.intercept != 0;
    }

    // Spatial unit: metre, millimetre or micrometre; unknown is taken as millimetres
    const int units = static_cast<int>(v1 ? b[123] : Signed(b + 500, 4, le)) & 0x07;
    const double mm_per_unit = units == 1 ? 1000.0 : (units == 3 ? 0.001 : 1.0);

    const int qform_code = static_cast<int>(v1 ? Signed(b + 252, 2, le) : Signed(b + 344, 4, le));
    const int sform_code = static_cast<int>(v1 ? Signed(b + 254, 2, le) : Signed(b + 348, 4, le));
    const auto read_real = [&](size_t v1_offset, size_t v2_offset) { return v1 ? Float32(b + v1_offset, le) : Float64(b + v2_offset, le); };
    Affine affine{};
    if (sform_code > 0) {
        for (int row = 0; row < 3; ++row) {
            for (int column = 0; column < 4; ++column) {
                affine[row][column] = read_real(280 + 16 * row + 4 * column, 400 + 32 * row + 8 * column);
            }
        }
        header.orientation_source = "sform";
    } else if (qform_code > 0) {
        double qb = read_real(256, 352);
        double qc = read_real(260, 360);
        double qd = read_real(264, 368);
        double qa = 1.0 - (qb * qb + qc * qc + qd * qd);
        if (qa < 1e-7) {
            // Nearly 180 degrees: normalize b, c, d (as nifti1_io does)
            const double norm = std::sqrt(qb * qb + qc * qc + qd * qd);
            qb /= norm;
            qc /= norm;
            qd /= norm;
            qa = 0;
        } else {
            qa = std::sqrt(qa);
        }
        const double qfac = pixdim[0] < 0 ? -1.0 : 1.0;
        const std::array<double, 3> scales = {
            pixdim[1] > 0 ? pixdim[1] : 1.0, pixdim[2] > 0 ? pixdim[2] : 1.0, (pixdim[3] > 0 ? pixdim[3] : 1.0) * qfac};
        const std::array<std::array<double, 3>, 3> rotation = {{
            {qa * qa + qb * qb - qc * qc - qd * qd, 2 * (qb * qc - qa * qd), 2 * (qb * qd + qa * qc)},
            {2 * (qb * qc + qa * qd), qa * qa + qc * qc - qb * qb - qd * qd, 2 * (qc * qd - qa * qb)},
            {2 * (qb * qd - qa * qc), 2 * (qc * qd + qa * qb), qa * qa + qd * qd - qc * qc - qb * qb},
        }};
        for (int row = 0; row < 3; ++row) {
            for (int column = 0; column < 3; ++column) {
                affine[row][column] = rotation[row][column] * scales[column];
            }
        }
        affine[0][3] = read_real(268, 376);
        affine[1][3] = read_real(272, 384);
        affine[2][3] = read_real(276, 392);
        header.orientation_source = "qform";
    }
    bool usable = !header.orientation_source.empty();
    for (int row = 0; row < 3 && usable; ++row) {
        for (int column = 0; column < 3; ++column) {
            usable = usable && std::isfinite(affine[row][column]);
        }
    }
    for (int column = 0; column < 3 && usable; ++column) {
        usable = Norm(affine, column) > 0;
    }
    if (!usable) {
        if (!header.orientation_source.empty()) {
            header.warnings.push_back(
                "The orientation in the NIfTI header is invalid; the axes are assumed to point right, anterior and superior");
        } else {
            header.warnings.push_back(
                "The NIfTI file has no orientation (qform and sform); the axes are assumed to point right, anterior "
                "and superior");
        }
        affine = Affine{};
        for (int axis = 0; axis < 3; ++axis) {
            affine[axis][axis] = std::isfinite(pixdim[axis + 1]) ? std::abs(pixdim[axis + 1]) : 0;
        }
        header.orientation_source = "none";
    }
    for (auto& row : affine) {
        for (int column = 0; column < 3; ++column) {
            row[column] *= mm_per_unit;
        }
    }
    header.affine = affine;
    return header;
}

// Which voxel axis runs along each RAS axis, and in which direction
struct Axes {
    std::array<int, 3> voxel_axis{};                // by RAS axis
    std::array<int, 3> direction{};                 // +1 when the voxel index grows towards R, A or S
    std::array<int64_t, 3> size{};                  // voxels along each RAS axis
    std::array<std::optional<double>, 3> spacing{}; // millimetres per voxel along each RAS axis
};

Axes AxesOf(const Header& header) {
    // Greedy assignment of the largest remaining direction cosine, like nibabel's io_orientation for oblique files
    Axes axes;
    std::array<bool, 3> world_used{};
    std::array<bool, 3> voxel_used{};
    for (int step = 0; step < 3; ++step) {
        double best = -1;
        int best_world = 0;
        int best_voxel = 0;
        for (int world = 0; world < 3; ++world) {
            for (int voxel = 0; voxel < 3; ++voxel) {
                if (world_used[world] || voxel_used[voxel]) {
                    continue;
                }
                const double norm = Norm(header.affine, voxel);
                const double cosine = norm > 0 ? std::abs(header.affine[world][voxel]) / norm : (world == voxel ? 0.5 : 0);
                if (cosine > best) {
                    best = cosine;
                    best_world = world;
                    best_voxel = voxel;
                }
            }
        }
        world_used[best_world] = true;
        voxel_used[best_voxel] = true;
        axes.voxel_axis[best_world] = best_voxel;
        axes.direction[best_world] = header.affine[best_world][best_voxel] < 0 ? -1 : 1;
    }
    for (int world = 0; world < 3; ++world) {
        const int voxel = axes.voxel_axis[world];
        axes.size[world] = header.dimensions[voxel];
        const double norm = Norm(header.affine, voxel);
        if (norm > 0 && std::isfinite(norm)) {
            axes.spacing[world] = norm;
        }
    }
    return axes;
}

// For each orientation: the RAS axis held constant, and the axes of the image's columns and rows
constexpr std::array<int, 3> FIXED_AXIS = {2, 1, 0};
constexpr std::array<int, 3> COLUMN_AXIS = {0, 0, 1};
constexpr std::array<int, 3> ROW_AXIS = {1, 2, 2};

SliceGeometry Geometry(const Axes& axes, SliceOrientation orientation) {
    const auto o = static_cast<size_t>(orientation);
    SliceGeometry geometry;
    geometry.count = axes.size[FIXED_AXIS[o]];
    geometry.width = axes.size[COLUMN_AXIS[o]];
    geometry.height = axes.size[ROW_AXIS[o]];
    const auto& x = axes.spacing[COLUMN_AXIS[o]];
    const auto& y = axes.spacing[ROW_AXIS[o]];
    if (x && y && *x >= 1e-6 && *y >= 1e-6 && *x <= 1e6 && *y <= 1e6) {
        geometry.pixel_spacing = PixelSpacing{*x, *y};
    }
    return geometry;
}

std::optional<ValueConversion> Conversion(const Header& header, const StorageChoice& storage) {
    if (!header.rescaled && storage.kind == StorageKind::Identity) {
        return std::nullopt;
    }
    std::string description;
    if (header.rescaled) {
        description = "Rescaled with scl_slope " + FormatValue(header.slope) + ", scl_inter " + FormatValue(header.intercept) + "; ";
    }
    if (storage.kind == StorageKind::Offset) {
        description += "values stored + 1024; ";
    } else if (storage.kind == StorageKind::Linear) {
        description += "values mapped linearly from " + FormatValue(storage.offset) + " – " +
                       FormatValue(storage.offset + storage.scale * 65535) + " to 0 – 65535; ";
    }
    description += ConversionFormula(storage.scale, storage.offset, "");
    if (description[0] >= 'a' && description[0] <= 'z') {
        description[0] = static_cast<char>(description[0] - 'a' + 'A');
    }
    return ValueConversion{storage.scale, storage.offset, "", description};
}

// Calls visit(values, count) for chunks of the voxel data, in file order; the input must be at the voxel offset
void ScanVoxels(
    Input& input, const Header& header, std::ofstream* copy, const std::function<void(const std::vector<double>&, size_t)>& visit) {
    const size_t bytes_per_voxel = header.type->bytes;
    const size_t chunk_voxels = CHUNK_BYTES / bytes_per_voxel;
    std::vector<uint8_t> buffer(chunk_voxels * bytes_per_voxel);
    std::vector<double> values(chunk_voxels);
    uint64_t remaining = header.data_bytes;
    while (remaining > 0) {
        const size_t count = static_cast<size_t>(std::min<uint64_t>(remaining, buffer.size()));
        input.ReadExactly(buffer.data(), count);
        if (copy != nullptr) {
            copy->write(reinterpret_cast<const char*>(buffer.data()), static_cast<std::streamsize>(count));
        }
        const size_t voxels = count / bytes_per_voxel;
        for (size_t v = 0; v < voxels; ++v) {
            values[v] = Decode(buffer.data() + v * bytes_per_voxel, *header.type, header.little_endian) * header.slope + header.intercept;
        }
        visit(values, voxels);
        remaining -= count;
    }
}

void SkipToVoxels(Input& input, const Header& header, std::ofstream* copy) {
    // Header extensions, copied as they are
    uint64_t remaining = header.voxel_offset - header.size;
    std::vector<uint8_t> buffer(static_cast<size_t>(std::min<uint64_t>(remaining, CHUNK_BYTES)));
    while (remaining > 0) {
        const size_t count = static_cast<size_t>(std::min<uint64_t>(remaining, buffer.size()));
        input.ReadExactly(buffer.data(), count);
        if (copy != nullptr) {
            copy->write(reinterpret_cast<const char*>(buffer.data()), static_cast<std::streamsize>(count));
        }
        remaining -= count;
    }
}

} // namespace

VolumeTooLargeError::VolumeTooLargeError(uint64_t bytes, uint64_t max_bytes)
    : std::runtime_error("The volume has " + std::to_string(bytes) + " bytes of voxel data, more than the limit of " +
                         std::to_string(max_bytes) + " bytes") {}

const char* SliceOrientationId(SliceOrientation orientation) {
    switch (orientation) {
        case SliceOrientation::Axial:
            return "axial";
        case SliceOrientation::Coronal:
            return "coronal";
        case SliceOrientation::Sagittal:
            return "sagittal";
    }
    return "axial";
}

bool IsNiftiFile(const std::string& path) {
    try {
        Input input(path);
        ReadHeader(input);
        return true;
    } catch (const std::invalid_argument&) {
        return true; // a NIfTI file, but not a supported one
    } catch (const std::exception&) {
        return false;
    }
}

NiftiVolumeInfo InspectNiftiVolume(const std::string& path, const std::string& uncompressed_copy, uint64_t max_data_bytes) {
    Input input(path);
    const Header header = ReadHeader(input);
    if (max_data_bytes > 0 && header.data_bytes > max_data_bytes) {
        throw VolumeTooLargeError(header.data_bytes, max_data_bytes);
    }

    NiftiVolumeInfo info;
    info.version = header.version;
    info.dimensions = header.dimensions;
    info.volumes = header.volumes;
    info.data_type = header.type->name;
    info.orientation_source = header.orientation_source;
    info.warnings = header.warnings;
    const Axes axes = AxesOf(header);
    for (int orientation = 0; orientation < 3; ++orientation) {
        info.slices[orientation] = Geometry(axes, static_cast<SliceOrientation>(orientation));
    }
    for (int voxel = 0; voxel < 3; ++voxel) {
        for (int world = 0; world < 3; ++world) {
            if (axes.voxel_axis[world] == voxel) {
                const std::array<const char*, 3> positive = {"R", "A", "S"};
                const std::array<const char*, 3> negative = {"L", "P", "I"};
                info.axis_codes += axes.direction[world] > 0 ? positive[world] : negative[world];
            }
        }
    }
    // The orientation whose slices are planes of constant k
    for (int orientation = 0; orientation < 3; ++orientation) {
        if (axes.voxel_axis[FIXED_AXIS[orientation]] == 2) {
            info.acquisition_orientation = static_cast<SliceOrientation>(orientation);
        }
    }

    std::ofstream copy;
    if (!uncompressed_copy.empty()) {
        copy.open(uncompressed_copy, std::ios::binary | std::ios::trunc);
        if (!copy) {
            throw std::runtime_error("Cannot write the file: " + uncompressed_copy);
        }
        copy.write(reinterpret_cast<const char*>(header.bytes.data()), static_cast<std::streamsize>(header.size));
    }
    SkipToVoxels(input, header, copy.is_open() ? &copy : nullptr);

    double minimum = std::numeric_limits<double>::infinity();
    double maximum = -std::numeric_limits<double>::infinity();
    uint64_t non_finite = 0;
    ScanVoxels(input, header, copy.is_open() ? &copy : nullptr, [&](const std::vector<double>& values, size_t count) {
        for (size_t v = 0; v < count; ++v) {
            if (std::isfinite(values[v])) {
                minimum = std::min(minimum, values[v]);
                maximum = std::max(maximum, values[v]);
            } else {
                ++non_finite;
            }
        }
    });
    if (copy.is_open()) {
        copy.close();
        if (!copy) {
            throw std::runtime_error("Cannot write the file: " + uncompressed_copy);
        }
    }
    if (minimum > maximum) {
        minimum = maximum = 0;
    }
    if (non_finite > 0) {
        info.warnings.push_back(std::to_string(non_finite) + " voxels are not finite numbers; they are stored as 0");
    }
    info.minimum = minimum;
    info.maximum = maximum;
    const ValueRange range{minimum, maximum, header.type->integer && IsInteger(header.slope) && IsInteger(header.intercept)};
    info.storage = ChooseStorage(range, std::string(header.type->name) == "uint8" && !header.rescaled, false);
    info.value_conversion = Conversion(header, info.storage);

    // Second pass: the default window from the histogram of the stored samples
    std::vector<uint64_t> histogram(info.storage.bit_depth == 8 ? 256 : 65536, 0);
    {
        Input again(uncompressed_copy.empty() ? path : uncompressed_copy);
        const Header same = ReadHeader(again);
        SkipToVoxels(again, same, nullptr);
        ScanVoxels(again, same, nullptr, [&](const std::vector<double>& values, size_t count) {
            for (size_t v = 0; v < count; ++v) {
                ++histogram[static_cast<size_t>(StoredSample(values[v], info.storage))];
            }
        });
    }
    uint64_t total = 0;
    for (uint64_t count : histogram) {
        total += count;
    }
    // Nearest rank, as ComputeDisplayStatistics
    const auto percentile = [&](uint64_t per_mille) {
        const uint64_t rank = std::max<uint64_t>(1, (total * per_mille + 999) / 1000);
        uint64_t seen = 0;
        for (size_t value = 0; value < histogram.size(); ++value) {
            seen += histogram[value];
            if (seen >= rank) {
                return static_cast<int>(value);
            }
        }
        return static_cast<int>(histogram.size() - 1);
    };
    info.window = DisplayWindow{percentile(5), percentile(995)};
    return info;
}

LoadedImage ExtractNiftiSlice(const std::string& path, SliceOrientation orientation, int64_t slice, int64_t volume,
    const StorageChoice& storage, int64_t max_pixels) {
    Input input(path);
    const Header header = ReadHeader(input);
    const Axes axes = AxesOf(header);
    const SliceGeometry geometry = Geometry(axes, orientation);
    if (slice < 0 || slice >= geometry.count) {
        throw std::invalid_argument("The slice must be 0 to " + std::to_string(geometry.count - 1));
    }
    if (volume < 0 || volume >= header.volumes) {
        throw std::invalid_argument("The volume must be 0 to " + std::to_string(header.volumes - 1));
    }
    if (geometry.width > std::numeric_limits<int>::max() || geometry.height > std::numeric_limits<int>::max() ||
        (max_pixels > 0 && geometry.width > max_pixels / geometry.height)) {
        throw ImageTooLargeError(geometry.width, geometry.height, max_pixels);
    }

    const auto o = static_cast<size_t>(orientation);
    const int fixed_voxel_axis = axes.voxel_axis[FIXED_AXIS[o]];
    const auto voxel_index = [&](int world, int64_t coordinate) {
        return axes.direction[world] > 0 ? coordinate : axes.size[world] - 1 - coordinate;
    };
    const int64_t fixed_index = voxel_index(FIXED_AXIS[o], slice);
    const int64_t ni = header.dimensions[0];
    const int64_t nj = header.dimensions[1];
    const int64_t nk = header.dimensions[2];

    // Read the plane of the fixed voxel axis in file order: rows along i (a single voxel when i is fixed)
    std::vector<double> plane;
    plane.reserve(static_cast<size_t>(geometry.width * geometry.height));
    const size_t bytes_per_voxel = header.type->bytes;
    const int64_t run = fixed_voxel_axis == 0 ? 1 : ni;
    std::vector<uint8_t> buffer(static_cast<size_t>(run) * bytes_per_voxel);
    const int64_t k_first = fixed_voxel_axis == 2 ? fixed_index : 0;
    const int64_t k_last = fixed_voxel_axis == 2 ? fixed_index : nk - 1;
    const int64_t j_first = fixed_voxel_axis == 1 ? fixed_index : 0;
    const int64_t j_last = fixed_voxel_axis == 1 ? fixed_index : nj - 1;
    for (int64_t k = k_first; k <= k_last; ++k) {
        for (int64_t j = j_first; j <= j_last; ++j) {
            const uint64_t voxel = static_cast<uint64_t>(((volume * nk + k) * nj + j) * ni + (fixed_voxel_axis == 0 ? fixed_index : 0));
            input.Seek(header.voxel_offset + voxel * bytes_per_voxel);
            input.ReadExactly(buffer.data(), buffer.size());
            for (int64_t i = 0; i < run; ++i) {
                plane.push_back(
                    Decode(buffer.data() + i * bytes_per_voxel, *header.type, header.little_endian) * header.slope + header.intercept);
            }
        }
    }
    // Index in the plane of the voxel (i, j, k)
    const auto plane_index = [&](const std::array<int64_t, 3>& v) -> size_t {
        switch (fixed_voxel_axis) {
            case 2:
                return static_cast<size_t>(v[1] * ni + v[0]);
            case 1:
                return static_cast<size_t>(v[2] * ni + v[0]);
            default:
                return static_cast<size_t>(v[2] * nj + v[1]);
        }
    };

    LoadedImage image;
    const auto width = static_cast<int>(geometry.width);
    const auto height = static_cast<int>(geometry.height);
    image.gray = cv::Mat(height, width, storage.bit_depth == 8 ? CV_8UC1 : CV_16UC1);
    std::array<int64_t, 3> v{};
    v[fixed_voxel_axis] = fixed_index;
    for (int r = 0; r < height; ++r) {
        v[axes.voxel_axis[ROW_AXIS[o]]] = voxel_index(ROW_AXIS[o], geometry.height - 1 - r);
        for (int c = 0; c < width; ++c) {
            v[axes.voxel_axis[COLUMN_AXIS[o]]] = voxel_index(COLUMN_AXIS[o], c);
            const int stored = StoredSample(plane[plane_index(v)], storage);
            if (storage.bit_depth == 8) {
                image.gray.at<uchar>(r, c) = static_cast<uchar>(stored);
            } else {
                image.gray.at<uint16_t>(r, c) = static_cast<uint16_t>(stored);
            }
        }
    }
    image.info.width = width;
    image.info.height = height;
    image.info.bit_depth = storage.bit_depth;
    image.info.source_channels = 1;
    image.info.pixel_spacing = geometry.pixel_spacing;
    image.info.value_conversion = Conversion(header, storage);
    return image;
}

LoadedStack ExtractNiftiStack(const std::string& path, SliceOrientation orientation, int64_t volume, const StorageChoice& storage,
    int64_t max_pixels, int64_t max_stack_pixels) {
    Input input(path);
    const Header header = ReadHeader(input);
    const Axes axes = AxesOf(header);
    const SliceGeometry geometry = Geometry(axes, orientation);
    if (volume < 0 || volume >= header.volumes) {
        throw std::invalid_argument("The volume must be 0 to " + std::to_string(header.volumes - 1));
    }
    if (geometry.width > std::numeric_limits<int>::max() || geometry.height > std::numeric_limits<int>::max() ||
        (max_pixels > 0 && geometry.width > max_pixels / geometry.height)) {
        throw ImageTooLargeError(geometry.width, geometry.height, max_pixels);
    }
    if (geometry.count > MAX_SLICES) {
        throw std::invalid_argument(
            "The volume has " + std::to_string(geometry.count) + " slices, more than " + std::to_string(MAX_SLICES));
    }
    if (geometry.height * geometry.count > std::numeric_limits<int>::max() ||
        (max_stack_pixels > 0 && geometry.width * geometry.height > max_stack_pixels / geometry.count)) {
        throw StackTooLargeError(geometry.width, geometry.height, geometry.count, max_stack_pixels);
    }

    const auto o = static_cast<size_t>(orientation);
    const auto width = static_cast<int>(geometry.width);
    const auto height = static_cast<int>(geometry.height);
    LoadedStack stack;
    stack.slices = static_cast<int>(geometry.count);
    stack.pixels = cv::Mat(height * stack.slices, width, storage.bit_depth == 8 ? CV_8UC1 : CV_16UC1);
    stack.info.width = width;
    stack.info.height = height;
    stack.info.bit_depth = storage.bit_depth;
    stack.info.source_channels = 1;
    stack.info.pixel_spacing = geometry.pixel_spacing;
    stack.info.value_conversion = Conversion(header, storage);

    // The coordinate along each RAS axis of a voxel index: the same as ExtractNiftiSlice, inverted
    const auto world = [&](int world_axis, const std::array<int64_t, 3>& v) {
        const int64_t index = v[axes.voxel_axis[world_axis]];
        return axes.direction[world_axis] > 0 ? index : axes.size[world_axis] - 1 - index;
    };
    const int64_t ni = header.dimensions[0];
    const int64_t nj = header.dimensions[1];
    const int64_t nk = header.dimensions[2];
    const size_t bytes_per_voxel = header.type->bytes;
    std::vector<uint8_t> buffer(static_cast<size_t>(ni) * bytes_per_voxel);
    std::array<int64_t, 3> v{};
    for (int64_t k = 0; k < nk; ++k) {
        v[2] = k;
        for (int64_t j = 0; j < nj; ++j) {
            v[1] = j;
            const uint64_t first = static_cast<uint64_t>(((volume * nk + k) * nj + j) * ni);
            input.Seek(header.voxel_offset + first * bytes_per_voxel);
            input.ReadExactly(buffer.data(), buffer.size());
            for (int64_t i = 0; i < ni; ++i) {
                v[0] = i;
                const double value =
                    Decode(buffer.data() + i * bytes_per_voxel, *header.type, header.little_endian) * header.slope + header.intercept;
                const int stored = StoredSample(value, storage);
                const int64_t slice = world(FIXED_AXIS[o], v);
                const auto column = static_cast<int>(world(COLUMN_AXIS[o], v));
                const auto row = static_cast<int>(slice * height + (geometry.height - 1 - world(ROW_AXIS[o], v)));
                if (storage.bit_depth == 8) {
                    stack.pixels.at<uchar>(row, column) = static_cast<uchar>(stored);
                } else {
                    stack.pixels.at<uint16_t>(row, column) = static_cast<uint16_t>(stored);
                }
            }
        }
    }
    return stack;
}

LoadedImage LoadNiftiFile(const std::string& path, int64_t max_pixels) {
    NiftiVolumeInfo info = InspectNiftiVolume(path);
    if (info.dimensions[2] > 1 || info.volumes > 1) {
        std::string size =
            std::to_string(info.dimensions[0]) + " × " + std::to_string(info.dimensions[1]) + " × " + std::to_string(info.dimensions[2]);
        if (info.volumes > 1) {
            size += " × " + std::to_string(info.volumes);
        }
        throw std::invalid_argument("The NIfTI file holds a " + size + " volume; open it in Texture Workbench to choose a slice");
    }
    LoadedImage image = ExtractNiftiSlice(path, info.acquisition_orientation, 0, 0, info.storage, max_pixels);
    image.window = info.window;
    image.warnings.insert(image.warnings.end(), info.warnings.begin(), info.warnings.end());
    return image;
}

} // namespace glcm
