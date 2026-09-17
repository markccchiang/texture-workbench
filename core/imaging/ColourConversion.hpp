#ifndef GLCM_COLOUR_CONVERSION_HPP_
#define GLCM_COLOUR_CONVERSION_HPP_

#include <opencv2/core.hpp>
#include <optional>
#include <string>

#include "imaging/ValueConversion.hpp"

namespace glcm {

// How a colour image becomes the gray image that is measured
enum class ColourConversion {
    Luminance,     // 0.299 R + 0.587 G + 0.114 B, OpenCV's conversion (the default)
    Mean,          // (R + G + B) / 3, ImageJ's unweighted RGB → 8-bit conversion
    Red,           // one channel
    Green,         //
    Blue,          //
    Hue,           // the HSB components as ImageJ's HSB stack gives them
    Saturation,    //
    Brightness,    //
    HematoxylinHe, // stain optical densities by colour deconvolution (Ruifrok and Johnston), as scikit-image's separate_stains
    EosinHe,       // computes them: H&E with hed_from_rgb, H-DAB with hdx_from_rgb
    HematoxylinHdab,
    DabHdab,
};

const char* ColourConversionId(ColourConversion conversion); // "luminance", "mean", "red", …, "dabHdab"
std::optional<ColourConversion> ColourConversionFromId(const std::string& id);

// The gray image of a colour image and what it means
struct ConvertedColour {
    cv::Mat gray;                                    // CV_8UC1 or CV_16UC1
    std::optional<ValueConversion> value_conversion; // absent for the luminance, which stays as it was
    std::string warning;                             // what the notification says, e.g. "Colour image converted: red channel"
};

// Converts an 8- or 16-bit BGR image (OpenCV's channel order). Channels, the mean and the HSB components keep the bit depth:
// - Mean: round(R/3 + G/3 + B/3) (ImageJ adds the weighted channels and 0.5, then truncates)
// - Hue, saturation, brightness: java.awt.Color.RGBtoHSB in float (brightness = max / M, saturation = (max − min) / max,
//   hue in sixths from the largest channel), each × M truncated, where M is 255 or 65535
// Stains are stored as 16-bit samples: the optical density d = max(0, Σ_j x_j · C[j][s]) with x_j = ln(max(v_j / M,
// 10⁻⁶)) / ln(10⁻⁶), and stored = round(d / scale), scale = (sum of the positive C[j][s]) / 65535, so that value =
// stored × scale. Throws std::invalid_argument for another image type.
ConvertedColour ConvertColour(const cv::Mat& bgr, ColourConversion conversion);

} // namespace glcm

#endif // GLCM_COLOUR_CONVERSION_HPP_
