#ifndef GLCM_FEATURE_CATALOG_HPP_
#define GLCM_FEATURE_CATALOG_HPP_

#include <optional>
#include <set>
#include <string>
#include <vector>

#include "analysis/TextureAnalysis.hpp"

namespace glcm {

enum class FeatureGroup { RegionStatistics, Haralick, Other, RunLength, SizeZone, GrayToneDifference, LocalBinaryPattern, Shape };

enum class FeatureCost { Normal, Slow };

struct FeatureInfo {
    Type type;
    std::string id;                  // stable identifier for JSON and the API: the enum name, e.g. "CorrelationII"
    std::string name;                // display name
    FeatureGroup group;              // as grouped in doc/equations.rst
    bool non_standard;               // differs from the literature definition
    std::string non_standard_reason; // empty for standard features
    std::string doc_anchor;          // page and anchor in the Sphinx documentation
    FeatureCost cost;
};

struct FeaturePreset {
    std::string id;
    std::string name;
    std::set<Type> features;
    bool enables_score;
};

// Every selectable feature (Mean ... MaximalCorrelationCoefficient), in documentation order
const std::vector<FeatureInfo>& FeatureCatalog();

// Catalog entry of a feature; throws std::invalid_argument for types that are not features (Score, Age)
const FeatureInfo& FindFeature(Type type);

// Feature with the given id, if any
std::optional<Type> FeatureTypeFromId(const std::string& id);

const std::vector<FeaturePreset>& FeaturePresets();

// "regionStatistics", "haralick", "other", "runLength", "sizeZone", "grayToneDifference", "localBinaryPattern" or "shape"
std::string FeatureGroupId(FeatureGroup group);

} // namespace glcm

#endif // GLCM_FEATURE_CATALOG_HPP_
