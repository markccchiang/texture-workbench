#include "imaging/ColourConversion.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <opencv2/imgproc.hpp>
#include <stdexcept>
#include <utility>
#include <vector>

namespace glcm {

namespace {

struct Entry {
    ColourConversion conversion;
    const char* id;
    const char* description;
};

const std::array<Entry, 12> ENTRIES = {{
    {ColourConversion::Luminance, "luminance", "Luminance (0.299 R + 0.587 G + 0.114 B)"},
    {ColourConversion::Mean, "mean", "Mean of the red, green and blue channels"},
    {ColourConversion::Red, "red", "Red channel"},
    {ColourConversion::Green, "green", "Green channel"},
    {ColourConversion::Blue, "blue", "Blue channel"},
    {ColourConversion::Hue, "hue", "Hue (HSB)"},
    {ColourConversion::Saturation, "saturation", "Saturation (HSB)"},
    {ColourConversion::Brightness, "brightness", "Brightness (HSB)"},
    {ColourConversion::HematoxylinHe, "hematoxylinHe", "Hematoxylin optical density (H&E colour deconvolution, scikit-image hed_from_rgb)"},
    {ColourConversion::EosinHe, "eosinHe", "Eosin optical density (H&E colour deconvolution, scikit-image hed_from_rgb)"},
    {ColourConversion::HematoxylinHdab, "hematoxylinHdab",
        "Hematoxylin optical density (H-DAB colour deconvolution, scikit-image hdx_from_rgb)"},
    {ColourConversion::DabHdab, "dabHdab", "DAB optical density (H-DAB colour deconvolution, scikit-image hdx_from_rgb)"},
}};

const Entry& EntryOf(ColourConversion conversion) {
    return *std::find_if(ENTRIES.begin(), ENTRIES.end(), [&](const Entry& entry) { return entry.conversion == conversion; });
}

// scikit-image 0.26's hed_from_rgb and hdx_from_rgb (inverses of the stain matrices; rows R, G, B; columns the stains)
using Matrix = std::array<std::array<double, 3>, 3>;
const Matrix HED_FROM_RGB = {{
    {1.8779827368521353, -1.0076786862855642, -0.5561158181996245},
    {-0.06590806222356335, 1.1347303724996625, -0.13552179862837113},
    {-0.601907363439289, -0.48041418849705786, 1.5735880719641924},
}};
const Matrix HDX_FROM_RGB = {{
    {1.2001370152970128, -0.6897672021124063, 1.05605386664475},
    {0.6852333815986897, 0.023609908678645767, -1.1785755564151525},
    {-0.9178089531067687, 1.5095360337877537, 0.500986637752376},
}};

cv::Mat Channel(const cv::Mat& bgr, int index) {
    cv::Mat channel;
    cv::extractChannel(bgr, channel, index);
    return channel;
}

template <typename T>
cv::Mat MeanOf(const cv::Mat& bgr) {
    cv::Mat gray(bgr.size(), bgr.depth() == CV_16U ? CV_16UC1 : CV_8UC1);
    const double third = 1.0 / 3.0;
    for (int row = 0; row < bgr.rows; ++row) {
        const T* pixel = bgr.ptr<T>(row);
        T* out = gray.ptr<T>(row);
        for (int col = 0; col < bgr.cols; ++col, pixel += 3) {
            // ImageJ's TypeConverter: r·rw + g·gw + b·bw + 0.5, truncated
            out[col] = static_cast<T>(static_cast<int>(pixel[2] * third + pixel[1] * third + pixel[0] * third + 0.5));
        }
    }
    return gray;
}

// java.awt.Color.RGBtoHSB for channel values up to `maximum`, in float as Java computes it
std::array<float, 3> Hsb(int r, int g, int b, float maximum) {
    const int cmax = std::max({r, g, b});
    const int cmin = std::min({r, g, b});
    const float brightness = static_cast<float>(cmax) / maximum;
    const float saturation = cmax != 0 ? static_cast<float>(cmax - cmin) / static_cast<float>(cmax) : 0.0f;
    float hue = 0.0f;
    if (saturation != 0.0f) {
        const auto range = static_cast<float>(cmax - cmin);
        const float redc = static_cast<float>(cmax - r) / range;
        const float greenc = static_cast<float>(cmax - g) / range;
        const float bluec = static_cast<float>(cmax - b) / range;
        if (r == cmax) {
            hue = bluec - greenc;
        } else if (g == cmax) {
            hue = 2.0f + redc - bluec;
        } else {
            hue = 4.0f + greenc - redc;
        }
        hue = hue / 6.0f;
        if (hue < 0) {
            hue = hue + 1.0f;
        }
    }
    return {hue, saturation, brightness};
}

// The same components in double precision, for 16-bit images (float would lose up to one step of 65535)
std::array<double, 3> HsbDouble(int r, int g, int b, double maximum) {
    const int cmax = std::max({r, g, b});
    const int cmin = std::min({r, g, b});
    const double brightness = static_cast<double>(cmax) / maximum;
    const double saturation = cmax != 0 ? static_cast<double>(cmax - cmin) / static_cast<double>(cmax) : 0.0;
    double hue = 0.0;
    if (cmax != cmin) {
        const auto range = static_cast<double>(cmax - cmin);
        const double redc = (cmax - r) / range;
        const double greenc = (cmax - g) / range;
        const double bluec = (cmax - b) / range;
        hue = r == cmax ? bluec - greenc : g == cmax ? 2.0 + redc - bluec : 4.0 + greenc - redc;
        hue /= 6.0;
        if (hue < 0) {
            hue += 1.0;
        }
    }
    return {hue, saturation, brightness};
}

cv::Mat HsbComponent8(const cv::Mat& bgr, int component) {
    cv::Mat gray(bgr.size(), CV_8UC1);
    for (int row = 0; row < bgr.rows; ++row) {
        const uchar* pixel = bgr.ptr<uchar>(row);
        uchar* out = gray.ptr<uchar>(row);
        for (int col = 0; col < bgr.cols; ++col, pixel += 3) {
            const auto hsb = Hsb(pixel[2], pixel[1], pixel[0], 255.0f);
            // ImageJ's getHSBStack: (byte)((int)(h * 255.0))
            out[col] = static_cast<uchar>(static_cast<int>(hsb[static_cast<size_t>(component)] * 255.0));
        }
    }
    return gray;
}

// 16-bit: channel values up to `maximum` (65535, or less for DICOM files with fewer bits stored), components rounded to
// 0-65535, so the brightness of a 16-bit image is its largest channel
cv::Mat HsbComponent16(const cv::Mat& bgr, int component, int maximum) {
    cv::Mat gray(bgr.size(), CV_16UC1);
    for (int row = 0; row < bgr.rows; ++row) {
        const uint16_t* pixel = bgr.ptr<uint16_t>(row);
        uint16_t* out = gray.ptr<uint16_t>(row);
        for (int col = 0; col < bgr.cols; ++col, pixel += 3) {
            const auto hsb = HsbDouble(pixel[2], pixel[1], pixel[0], maximum);
            out[col] = static_cast<uint16_t>(std::lround(std::clamp(hsb[static_cast<size_t>(component)], 0.0, 1.0) * 65535.0));
        }
    }
    return gray;
}

template <typename T>
cv::Mat StainOf(const cv::Mat& bgr, const Matrix& matrix, int stain, double scale, int maximum) {
    // The density of every possible sample: the same double expression per value, looked up per channel
    const double log_adjust = std::log(1e-6);
    const size_t values = bgr.depth() == CV_16U ? 65536 : 256;
    std::vector<double> density(values);
    for (size_t value = 0; value < values; ++value) {
        // skimage: img_as_float multiplies by 1 / imax, then np.maximum(rgb, 1e-6)
        density[value] = std::log(std::max(static_cast<double>(value) * (1.0 / maximum), 1e-6)) / log_adjust;
    }
    const auto column = static_cast<size_t>(stain);
    cv::Mat gray(bgr.size(), CV_16UC1);
    for (int row = 0; row < bgr.rows; ++row) {
        const T* pixel = bgr.ptr<T>(row);
        uint16_t* out = gray.ptr<uint16_t>(row);
        for (int col = 0; col < bgr.cols; ++col, pixel += 3) {
            const double d = std::max(
                0.0, density[pixel[2]] * matrix[0][column] + density[pixel[1]] * matrix[1][column] + density[pixel[0]] * matrix[2][column]);
            out[col] = static_cast<uint16_t>(std::min(65535.0, std::round(d / scale)));
        }
    }
    return gray;
}

ConvertedColour Convert(const cv::Mat& bgr, ColourConversion conversion, int maximum) {
    ConvertedColour result;
    const std::string what = EntryOf(conversion).description;
    const bool sixteen = bgr.depth() == CV_16U;
    const auto identity = [&](const std::string& description) {
        result.value_conversion = ValueConversion{1, 0, "", description + "; " + ConversionFormula(1, 0, "")};
    };
    const auto stain = [&](const Matrix& matrix, int column) {
        double positive = 0;
        for (const auto& row : matrix) {
            positive += std::max(0.0, row[static_cast<size_t>(column)]);
        }
        const double scale = positive / 65535.0;
        result.gray =
            sixteen ? StainOf<uint16_t>(bgr, matrix, column, scale, maximum) : StainOf<uchar>(bgr, matrix, column, scale, maximum);
        result.value_conversion = ValueConversion{scale, 0, "OD", what + "; " + ConversionFormula(scale, 0, "OD")};
    };

    switch (conversion) {
        case ColourConversion::Luminance:
            cv::cvtColor(bgr, result.gray, cv::COLOR_BGR2GRAY);
            result.warning = "Color image converted to grayscale";
            return result;
        case ColourConversion::Mean:
            result.gray = sixteen ? MeanOf<uint16_t>(bgr) : MeanOf<uchar>(bgr);
            break;
        case ColourConversion::Red:
            result.gray = Channel(bgr, 2);
            break;
        case ColourConversion::Green:
            result.gray = Channel(bgr, 1);
            break;
        case ColourConversion::Blue:
            result.gray = Channel(bgr, 0);
            break;
        case ColourConversion::Hue:
            result.gray = sixteen ? HsbComponent16(bgr, 0, maximum) : HsbComponent8(bgr, 0);
            break;
        case ColourConversion::Saturation:
            result.gray = sixteen ? HsbComponent16(bgr, 1, maximum) : HsbComponent8(bgr, 1);
            break;
        case ColourConversion::Brightness:
            result.gray = sixteen ? HsbComponent16(bgr, 2, maximum) : HsbComponent8(bgr, 2);
            break;
        case ColourConversion::HematoxylinHe:
            stain(HED_FROM_RGB, 0);
            break;
        case ColourConversion::EosinHe:
            stain(HED_FROM_RGB, 1);
            break;
        case ColourConversion::HematoxylinHdab:
            stain(HDX_FROM_RGB, 0);
            break;
        case ColourConversion::DabHdab:
            stain(HDX_FROM_RGB, 1);
            break;
    }
    if (!result.value_conversion) {
        identity(what);
    }
    result.warning = "Colour image converted: " + what;
    return result;
}

} // namespace

const char* ColourConversionId(ColourConversion conversion) {
    return EntryOf(conversion).id;
}

std::optional<ColourConversion> ColourConversionFromId(const std::string& id) {
    const auto found = std::find_if(ENTRIES.begin(), ENTRIES.end(), [&](const Entry& entry) { return id == entry.id; });
    return found == ENTRIES.end() ? std::nullopt : std::optional<ColourConversion>(found->conversion);
}

ConvertedColour ConvertColour(const cv::Mat& bgr, ColourConversion conversion, int maximum) {
    if (bgr.empty() || (bgr.type() != CV_8UC3 && bgr.type() != CV_16UC3)) {
        throw std::invalid_argument("A colour conversion needs an 8- or 16-bit three-channel image");
    }
    const int depth_maximum = bgr.depth() == CV_16U ? 65535 : 255;
    if (maximum <= 0) {
        maximum = depth_maximum;
    }
    if (maximum > depth_maximum || (bgr.depth() == CV_8U && maximum != 255)) {
        throw std::invalid_argument("The largest sample of a colour conversion must fit the image's bit depth");
    }
    return Convert(bgr, conversion, maximum);
}

} // namespace glcm
