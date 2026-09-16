#ifndef GLCM_SHAPE_HPP_
#define GLCM_SHAPE_HPP_

#include <map>
#include <opencv2/core.hpp>
#include <set>

#include "analysis/TextureAnalysis.hpp"

namespace glcm {

// The feature types computed by ComputeShapeFeatures
bool IsShapeFeature(Type type);

// 2D shape features of the pixels inside the mask (255), defined as in PyRadiomics' shape2D class (doc/equations.rst, "Shape
// features (2D)"). The mesh runs through the midpoints between pixel centres inside and outside the mask (marching squares);
// the surface and perimeter are those of the mesh, the maximum diameter the largest distance between its vertices, and the
// axis lengths and elongation come from the principal components of the pixel centres. Coordinates are multiplied by the
// spacing (spacing.x between columns, spacing.y between rows): millimetres with a pixel spacing, pixels with (1, 1). Values are
// NaN for an empty mask, and the axis features NaN when a principal component is negative beyond rounding. Throws
// std::invalid_argument for a mask that is not CV_8UC1, a spacing that is not positive and finite, and a type that
// IsShapeFeature does not accept.
std::map<Type, double> ComputeShapeFeatures(const cv::Mat& mask, cv::Point2d spacing, const std::set<Type>& types);

} // namespace glcm

#endif // GLCM_SHAPE_HPP_
