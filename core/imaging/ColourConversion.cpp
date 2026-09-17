#include "imaging/ColourConversion.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <opencv2/imgproc.hpp>
#include <stdexcept>
#include <utility>

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

template <typename T>
cv::Mat HsbComponent(const cv::Mat& bgr, int component) {
    const bool sixteen = bgr.depth() == CV_16U;
    const double scale = sixteen ? 65535.0 : 255.0;
    cv::Mat gray(bgr.size(), sixteen ? CV_16UC1 : CV_8UC1);
    for (int row = 0; row < bgr.rows; ++row) {
        const T* pixel = bgr.ptr<T>(row);
        T* out = gray.ptr<T>(row);
        for (int col = 0; col < bgr.cols; ++col, pixel += 3) {
            const auto hsb = Hsb(pixel[2], pixel[1], pixel[0], static_cast<float>(scale));
            // ImageJ's getHSBStack: (byte)((int)(h * 255.0))
            out[col] = static_cast<T>(static_cast<int>(hsb[static_cast<size_t>(component)] * scale));
        }
    }
    return gray;
}

template <typename T>
cv::Mat StainOf(const cv::Mat& bgr, const Matrix& matrix, int stain, double scale) {
    const double maximum = bgr.depth() == CV_16U ? 65535.0 : 255.0;
    const double log_adjust = std::log(1e-6);
    cv::Mat gray(bgr.size(), CV_16UC1);
    for (int row = 0; row < bgr.rows; ++row) {
        const T* pixel = bgr.ptr<T>(row);
        uint16_t* out = gray.ptr<uint16_t>(row);
        for (int col = 0; col < bgr.cols; ++col, pixel += 3) {
            // skimage: img_as_float multiplies by 1 / imax, then np.maximum(rgb, 1e-6)
            const auto density = [&](T value) { return std::log(std::max(value * (1.0 / maximum), 1e-6)) / log_adjust; };
            const std::array<double, 3> x = {density(pixel[2]), density(pixel[1]), density(pixel[0])};
            const double d = std::max(0.0, x[0] * matrix[0][static_cast<size_t>(stain)] + x[1] * matrix[1][static_cast<size_t>(stain)] +
                                               x[2] * matrix[2][static_cast<size_t>(stain)]);
            out[col] = static_cast<uint16_t>(std::min(65535.0, std::round(d / scale)));
        }
    }
    return gray;
}

ConvertedColour Convert(const cv::Mat& bgr, ColourConversion conversion) {
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
        result.gray = sixteen ? StainOf<uint16_t>(bgr, matrix, column, scale) : StainOf<uchar>(bgr, matrix, column, scale);
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
            result.gray = sixteen ? HsbComponent<uint16_t>(bgr, 0) : HsbComponent<uchar>(bgr, 0);
            break;
        case ColourConversion::Saturation:
            result.gray = sixteen ? HsbComponent<uint16_t>(bgr, 1) : HsbComponent<uchar>(bgr, 1);
            break;
        case ColourConversion::Brightness:
            result.gray = sixteen ? HsbComponent<uint16_t>(bgr, 2) : HsbComponent<uchar>(bgr, 2);
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

ConvertedColour ConvertColour(const cv::Mat& bgr, ColourConversion conversion) {
    if (bgr.empty() || (bgr.type() != CV_8UC3 && bgr.type() != CV_16UC3)) {
        throw std::invalid_argument("A colour conversion needs an 8- or 16-bit three-channel image");
    }
    return Convert(bgr, conversion);
}

} // namespace glcm
