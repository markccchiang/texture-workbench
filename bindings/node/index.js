// Loads the glcm_native addon built by `npm run build -w @glcm/native`
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const native = require('./build/Release/glcm_native.node');

export const {
  coreVersion,
  catalog,
  decodeImageFile,
  inspectNiftiVolume,
  extractNiftiSlice,
  renderDisplay,
  roiStats,
  validateAnalysis,
  runAnalysis,
  formatResults,
  exportRoiImages,
  windowLevel,
  featureMapGrid,
  computeFeatureMap,
  CancelToken,
  selectThresholdRegions,
  selectWandRegion,
  combineRois,
  brushRoi,
  growRoi,
  gradientStatistics,
  renderEdgeMap,
  livewirePath,
} = native;
export default native;
