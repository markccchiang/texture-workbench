#include "pipeline/FeatureCatalog.hpp"

#include <stdexcept>

namespace glcm {

namespace {

const char YANG_CORRELATION[] =
    "Follows Yang et al. (2012) as printed: the covariance is divided by the product of the variances "
    "instead of the standard deviations, so the value is not bounded like a correlation. Correlation II "
    "is the standard definition.";

const char YANG_SUM_OF_SQUARES[] =
    "Follows Yang et al. (2012): the sum of the variances in i and j, which is twice Haralick's F4 for "
    "a symmetric co-occurrence matrix. Sum of Squares (in x) is Haralick's F4.";

const char REGION_ANCHOR[] = "equations.html#first-order-statistics";
const char HARALICK_ANCHOR[] = "equations.html#haralick-features";
const char OTHER_ANCHOR[] = "equations.html#other-co-occurrence-features";
const char RUN_LENGTH_ANCHOR[] = "equations.html#run-length-features-glrlm";
const char SIZE_ZONE_ANCHOR[] = "equations.html#size-zone-features-glszm";
const char GRAY_TONE_ANCHOR[] = "equations.html#neighbourhood-gray-tone-difference-features-ngtdm";
const char LBP_ANCHOR[] = "equations.html#local-binary-pattern-features-lbp";
const char SHAPE_ANCHOR[] = "equations.html#shape-features-2d";

FeatureInfo Make(Type type, const char* id, FeatureGroup group, const char* anchor, FeatureCost cost = FeatureCost::Normal,
    const char* non_standard_reason = "") {
    return FeatureInfo{
        type, id, TextureAnalysis::TypeToString(type), group, non_standard_reason[0] != '\0', non_standard_reason, anchor, cost};
}

std::vector<FeatureInfo> BuildCatalog() {
    using G = FeatureGroup;
    return {
        Make(Type::Mean, "Mean", G::RegionStatistics, REGION_ANCHOR),
        Make(Type::Std, "Std", G::RegionStatistics, REGION_ANCHOR),
        Make(Type::Minimum, "Minimum", G::RegionStatistics, REGION_ANCHOR),
        Make(Type::Maximum, "Maximum", G::RegionStatistics, REGION_ANCHOR),
        Make(Type::Range, "Range", G::RegionStatistics, REGION_ANCHOR),
        Make(Type::Median, "Median", G::RegionStatistics, REGION_ANCHOR),
        Make(Type::Percentile10, "Percentile10", G::RegionStatistics, REGION_ANCHOR),
        Make(Type::Percentile90, "Percentile90", G::RegionStatistics, REGION_ANCHOR),
        Make(Type::InterquartileRange, "InterquartileRange", G::RegionStatistics, REGION_ANCHOR),
        Make(Type::MeanAbsoluteDeviation, "MeanAbsoluteDeviation", G::RegionStatistics, REGION_ANCHOR),
        Make(Type::RobustMeanAbsoluteDeviation, "RobustMeanAbsoluteDeviation", G::RegionStatistics, REGION_ANCHOR),
        Make(Type::RootMeanSquared, "RootMeanSquared", G::RegionStatistics, REGION_ANCHOR),
        Make(Type::FirstOrderEnergy, "FirstOrderEnergy", G::RegionStatistics, REGION_ANCHOR),
        Make(Type::Variance, "Variance", G::RegionStatistics, REGION_ANCHOR),
        Make(Type::Skewness, "Skewness", G::RegionStatistics, REGION_ANCHOR),
        Make(Type::Kurtosis, "Kurtosis", G::RegionStatistics, REGION_ANCHOR),
        Make(Type::FirstOrderEntropy, "FirstOrderEntropy", G::RegionStatistics, REGION_ANCHOR),
        Make(Type::Uniformity, "Uniformity", G::RegionStatistics, REGION_ANCHOR),

        Make(Type::Energy, "Energy", G::Haralick, HARALICK_ANCHOR),
        Make(Type::Contrast, "Contrast", G::Haralick, HARALICK_ANCHOR),
        Make(Type::ContrastAnotherWay, "ContrastAnotherWay", G::Haralick, HARALICK_ANCHOR),
        Make(Type::CorrelationII, "CorrelationII", G::Haralick, HARALICK_ANCHOR),
        Make(Type::CorrelationIIAnotherWay, "CorrelationIIAnotherWay", G::Haralick, HARALICK_ANCHOR),
        Make(Type::SumOfSquares, "SumOfSquares", G::Haralick, HARALICK_ANCHOR, FeatureCost::Normal, YANG_SUM_OF_SQUARES),
        Make(Type::SumOfSquaresI, "SumOfSquaresI", G::Haralick, HARALICK_ANCHOR),
        Make(Type::SumOfSquaresJ, "SumOfSquaresJ", G::Haralick, HARALICK_ANCHOR),
        Make(Type::HomogeneityII, "HomogeneityII", G::Haralick, HARALICK_ANCHOR),
        Make(Type::SumAverage, "SumAverage", G::Haralick, HARALICK_ANCHOR),
        Make(Type::SumVariance, "SumVariance", G::Haralick, HARALICK_ANCHOR),
        Make(Type::SumEntropy, "SumEntropy", G::Haralick, HARALICK_ANCHOR),
        Make(Type::Entropy, "Entropy", G::Haralick, HARALICK_ANCHOR),
        Make(Type::DifferenceVariance, "DifferenceVariance", G::Haralick, HARALICK_ANCHOR),
        Make(Type::DifferenceEntropy, "DifferenceEntropy", G::Haralick, HARALICK_ANCHOR),
        Make(Type::InformationMeasuresOfCorrelationI, "InformationMeasuresOfCorrelationI", G::Haralick, HARALICK_ANCHOR),
        Make(Type::InformationMeasuresOfCorrelationII, "InformationMeasuresOfCorrelationII", G::Haralick, HARALICK_ANCHOR),
        Make(Type::MaximalCorrelationCoefficient, "MaximalCorrelationCoefficient", G::Haralick, HARALICK_ANCHOR, FeatureCost::Slow),

        Make(Type::AutoCorrelation, "AutoCorrelation", G::Other, OTHER_ANCHOR),
        Make(Type::CorrelationI, "CorrelationI", G::Other, OTHER_ANCHOR),
        Make(Type::CorrelationIAnotherWay, "CorrelationIAnotherWay", G::Other, OTHER_ANCHOR),
        Make(Type::CorrelationIII, "CorrelationIII", G::Other, OTHER_ANCHOR, FeatureCost::Normal, YANG_CORRELATION),
        Make(Type::ClusterShade, "ClusterShade", G::Other, OTHER_ANCHOR),
        Make(Type::ClusterProminence, "ClusterProminence", G::Other, OTHER_ANCHOR),
        Make(Type::Dissimilarity, "Dissimilarity", G::Other, OTHER_ANCHOR),
        Make(Type::HomogeneityI, "HomogeneityI", G::Other, OTHER_ANCHOR),

        Make(Type::GlrlmShortRunEmphasis, "GlrlmShortRunEmphasis", G::RunLength, RUN_LENGTH_ANCHOR),
        Make(Type::GlrlmLongRunEmphasis, "GlrlmLongRunEmphasis", G::RunLength, RUN_LENGTH_ANCHOR),
        Make(Type::GlrlmGrayLevelNonUniformity, "GlrlmGrayLevelNonUniformity", G::RunLength, RUN_LENGTH_ANCHOR),
        Make(Type::GlrlmGrayLevelNonUniformityNormalized, "GlrlmGrayLevelNonUniformityNormalized", G::RunLength, RUN_LENGTH_ANCHOR),
        Make(Type::GlrlmRunLengthNonUniformity, "GlrlmRunLengthNonUniformity", G::RunLength, RUN_LENGTH_ANCHOR),
        Make(Type::GlrlmRunLengthNonUniformityNormalized, "GlrlmRunLengthNonUniformityNormalized", G::RunLength, RUN_LENGTH_ANCHOR),
        Make(Type::GlrlmRunPercentage, "GlrlmRunPercentage", G::RunLength, RUN_LENGTH_ANCHOR),
        Make(Type::GlrlmGrayLevelVariance, "GlrlmGrayLevelVariance", G::RunLength, RUN_LENGTH_ANCHOR),
        Make(Type::GlrlmRunVariance, "GlrlmRunVariance", G::RunLength, RUN_LENGTH_ANCHOR),
        Make(Type::GlrlmRunEntropy, "GlrlmRunEntropy", G::RunLength, RUN_LENGTH_ANCHOR),
        Make(Type::GlrlmLowGrayLevelRunEmphasis, "GlrlmLowGrayLevelRunEmphasis", G::RunLength, RUN_LENGTH_ANCHOR),
        Make(Type::GlrlmHighGrayLevelRunEmphasis, "GlrlmHighGrayLevelRunEmphasis", G::RunLength, RUN_LENGTH_ANCHOR),
        Make(Type::GlrlmShortRunLowGrayLevelEmphasis, "GlrlmShortRunLowGrayLevelEmphasis", G::RunLength, RUN_LENGTH_ANCHOR),
        Make(Type::GlrlmShortRunHighGrayLevelEmphasis, "GlrlmShortRunHighGrayLevelEmphasis", G::RunLength, RUN_LENGTH_ANCHOR),
        Make(Type::GlrlmLongRunLowGrayLevelEmphasis, "GlrlmLongRunLowGrayLevelEmphasis", G::RunLength, RUN_LENGTH_ANCHOR),
        Make(Type::GlrlmLongRunHighGrayLevelEmphasis, "GlrlmLongRunHighGrayLevelEmphasis", G::RunLength, RUN_LENGTH_ANCHOR),

        Make(Type::GlszmSmallAreaEmphasis, "GlszmSmallAreaEmphasis", G::SizeZone, SIZE_ZONE_ANCHOR),
        Make(Type::GlszmLargeAreaEmphasis, "GlszmLargeAreaEmphasis", G::SizeZone, SIZE_ZONE_ANCHOR),
        Make(Type::GlszmGrayLevelNonUniformity, "GlszmGrayLevelNonUniformity", G::SizeZone, SIZE_ZONE_ANCHOR),
        Make(Type::GlszmGrayLevelNonUniformityNormalized, "GlszmGrayLevelNonUniformityNormalized", G::SizeZone, SIZE_ZONE_ANCHOR),
        Make(Type::GlszmSizeZoneNonUniformity, "GlszmSizeZoneNonUniformity", G::SizeZone, SIZE_ZONE_ANCHOR),
        Make(Type::GlszmSizeZoneNonUniformityNormalized, "GlszmSizeZoneNonUniformityNormalized", G::SizeZone, SIZE_ZONE_ANCHOR),
        Make(Type::GlszmZonePercentage, "GlszmZonePercentage", G::SizeZone, SIZE_ZONE_ANCHOR),
        Make(Type::GlszmGrayLevelVariance, "GlszmGrayLevelVariance", G::SizeZone, SIZE_ZONE_ANCHOR),
        Make(Type::GlszmZoneVariance, "GlszmZoneVariance", G::SizeZone, SIZE_ZONE_ANCHOR),
        Make(Type::GlszmZoneEntropy, "GlszmZoneEntropy", G::SizeZone, SIZE_ZONE_ANCHOR),
        Make(Type::GlszmLowGrayLevelZoneEmphasis, "GlszmLowGrayLevelZoneEmphasis", G::SizeZone, SIZE_ZONE_ANCHOR),
        Make(Type::GlszmHighGrayLevelZoneEmphasis, "GlszmHighGrayLevelZoneEmphasis", G::SizeZone, SIZE_ZONE_ANCHOR),
        Make(Type::GlszmSmallAreaLowGrayLevelEmphasis, "GlszmSmallAreaLowGrayLevelEmphasis", G::SizeZone, SIZE_ZONE_ANCHOR),
        Make(Type::GlszmSmallAreaHighGrayLevelEmphasis, "GlszmSmallAreaHighGrayLevelEmphasis", G::SizeZone, SIZE_ZONE_ANCHOR),
        Make(Type::GlszmLargeAreaLowGrayLevelEmphasis, "GlszmLargeAreaLowGrayLevelEmphasis", G::SizeZone, SIZE_ZONE_ANCHOR),
        Make(Type::GlszmLargeAreaHighGrayLevelEmphasis, "GlszmLargeAreaHighGrayLevelEmphasis", G::SizeZone, SIZE_ZONE_ANCHOR),

        Make(Type::NgtdmCoarseness, "NgtdmCoarseness", G::GrayToneDifference, GRAY_TONE_ANCHOR),
        Make(Type::NgtdmContrast, "NgtdmContrast", G::GrayToneDifference, GRAY_TONE_ANCHOR),
        Make(Type::NgtdmBusyness, "NgtdmBusyness", G::GrayToneDifference, GRAY_TONE_ANCHOR),
        Make(Type::NgtdmComplexity, "NgtdmComplexity", G::GrayToneDifference, GRAY_TONE_ANCHOR),
        Make(Type::NgtdmStrength, "NgtdmStrength", G::GrayToneDifference, GRAY_TONE_ANCHOR),

        Make(Type::LbpUniform0, "LbpUniform0", G::LocalBinaryPattern, LBP_ANCHOR),
        Make(Type::LbpUniform1, "LbpUniform1", G::LocalBinaryPattern, LBP_ANCHOR),
        Make(Type::LbpUniform2, "LbpUniform2", G::LocalBinaryPattern, LBP_ANCHOR),
        Make(Type::LbpUniform3, "LbpUniform3", G::LocalBinaryPattern, LBP_ANCHOR),
        Make(Type::LbpUniform4, "LbpUniform4", G::LocalBinaryPattern, LBP_ANCHOR),
        Make(Type::LbpUniform5, "LbpUniform5", G::LocalBinaryPattern, LBP_ANCHOR),
        Make(Type::LbpUniform6, "LbpUniform6", G::LocalBinaryPattern, LBP_ANCHOR),
        Make(Type::LbpUniform7, "LbpUniform7", G::LocalBinaryPattern, LBP_ANCHOR),
        Make(Type::LbpUniform8, "LbpUniform8", G::LocalBinaryPattern, LBP_ANCHOR),
        Make(Type::LbpNonUniform, "LbpNonUniform", G::LocalBinaryPattern, LBP_ANCHOR),
        Make(Type::LbpEntropy, "LbpEntropy", G::LocalBinaryPattern, LBP_ANCHOR),
        Make(Type::LbpEnergy, "LbpEnergy", G::LocalBinaryPattern, LBP_ANCHOR),

        Make(Type::ShapeMeshSurface, "ShapeMeshSurface", G::Shape, SHAPE_ANCHOR),
        Make(Type::ShapePixelSurface, "ShapePixelSurface", G::Shape, SHAPE_ANCHOR),
        Make(Type::ShapePerimeter, "ShapePerimeter", G::Shape, SHAPE_ANCHOR),
        Make(Type::ShapePerimeterSurfaceRatio, "ShapePerimeterSurfaceRatio", G::Shape, SHAPE_ANCHOR),
        Make(Type::ShapeSphericity, "ShapeSphericity", G::Shape, SHAPE_ANCHOR),
        Make(Type::ShapeMaximumDiameter, "ShapeMaximumDiameter", G::Shape, SHAPE_ANCHOR),
        Make(Type::ShapeMajorAxisLength, "ShapeMajorAxisLength", G::Shape, SHAPE_ANCHOR),
        Make(Type::ShapeMinorAxisLength, "ShapeMinorAxisLength", G::Shape, SHAPE_ANCHOR),
        Make(Type::ShapeElongation, "ShapeElongation", G::Shape, SHAPE_ANCHOR),
        Make(Type::MaximumProbability, "MaximumProbability", G::Other, OTHER_ANCHOR),
        Make(Type::InverseDifferenceNormalized, "InverseDifferenceNormalized", G::Other, OTHER_ANCHOR),
        Make(Type::InverseDifferenceMomentNormalized, "InverseDifferenceMomentNormalized", G::Other, OTHER_ANCHOR),
    };
}

} // namespace

const std::vector<FeatureInfo>& FeatureCatalog() {
    static const std::vector<FeatureInfo> catalog = BuildCatalog();
    return catalog;
}

const FeatureInfo& FindFeature(Type type) {
    for (const FeatureInfo& info : FeatureCatalog()) {
        if (info.type == type) {
            return info;
        }
    }
    throw std::invalid_argument("Not a selectable feature: " + TextureAnalysis::TypeToString(type));
}

std::optional<Type> FeatureTypeFromId(const std::string& id) {
    for (const FeatureInfo& info : FeatureCatalog()) {
        if (info.id == id) {
            return info.type;
        }
    }
    return std::nullopt;
}

const std::vector<FeaturePreset>& FeaturePresets() {
    static const std::vector<FeaturePreset> presets = [] {
        std::set<Type> all;
        std::set<Type> first_order;
        std::set<Type> run_length;
        std::set<Type> size_zone;
        std::set<Type> gray_tone;
        std::set<Type> local_binary_pattern;
        std::set<Type> shape;
        for (const FeatureInfo& info : FeatureCatalog()) {
            all.insert(info.type);
            if (info.group == FeatureGroup::RegionStatistics) {
                first_order.insert(info.type);
            } else if (info.group == FeatureGroup::RunLength) {
                run_length.insert(info.type);
            } else if (info.group == FeatureGroup::SizeZone) {
                size_zone.insert(info.type);
            } else if (info.group == FeatureGroup::GrayToneDifference) {
                gray_tone.insert(info.type);
            } else if (info.group == FeatureGroup::LocalBinaryPattern) {
                local_binary_pattern.insert(info.type);
            } else if (info.group == FeatureGroup::Shape) {
                shape.insert(info.type);
            }
        }
        return std::vector<FeaturePreset>{
            {"haralick", "Haralick F1–F14",
                {Type::Energy, Type::Contrast, Type::CorrelationII, Type::SumOfSquaresI, Type::HomogeneityII, Type::SumAverage,
                    Type::SumVariance, Type::SumEntropy, Type::Entropy, Type::DifferenceVariance, Type::DifferenceEntropy,
                    Type::InformationMeasuresOfCorrelationI, Type::InformationMeasuresOfCorrelationII, Type::MaximalCorrelationCoefficient},
                false},
            {"clausi2002", "Clausi (2002): Contrast, Correlation, Entropy", {Type::Contrast, Type::CorrelationII, Type::Entropy}, false},
            {"basic", "Basic",
                {Type::Mean, Type::Std, Type::Contrast, Type::Entropy, Type::Energy, Type::HomogeneityII, Type::CorrelationII}, false},
            {"score", "Score (Mean, Entropy, Contrast)", {Type::Mean, Type::Entropy, Type::Contrast}, true},
            {"firstOrder", "First-order statistics", first_order, false},
            {"glrlm", "Run length (GLRLM)", run_length, false},
            {"glszm", "Size zone (GLSZM)", size_zone, false},
            {"ngtdm", "Gray tone difference (NGTDM)", gray_tone, false},
            {"lbp", "Local binary patterns (LBP)", local_binary_pattern, false},
            {"shape", "Shape (2D)", shape, false},
            {"all", "All features", all, false},
        };
    }();
    return presets;
}

std::string FeatureGroupId(FeatureGroup group) {
    switch (group) {
        case FeatureGroup::RegionStatistics:
            return "regionStatistics";
        case FeatureGroup::Haralick:
            return "haralick";
        case FeatureGroup::Other:
            return "other";
        case FeatureGroup::RunLength:
            return "runLength";
        case FeatureGroup::SizeZone:
            return "sizeZone";
        case FeatureGroup::GrayToneDifference:
            return "grayToneDifference";
        case FeatureGroup::LocalBinaryPattern:
            return "localBinaryPattern";
        case FeatureGroup::Shape:
            return "shape";
    }
    throw std::invalid_argument("Unknown feature group");
}

} // namespace glcm
