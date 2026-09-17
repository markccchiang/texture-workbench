#!/usr/bin/env python3
"""Reference values of first-order, texture and shape features from PyRadiomics and scikit-image, for the core tests.

Writes core/tests/data/pyradiomics-firstorder.json (FirstOrderTest), pyradiomics-glrlm.json (RunLengthTest),
pyradiomics-glszm.json (SizeZoneTest), pyradiomics-ngtdm.json (GrayToneDifferenceTest) and scikit-image-lbp.json
(LocalBinaryPatternTest), pyradiomics-shape2d.json (ShapeTest), simpleitk-resampling.json (ResamplingTest) and
scikit-image-stains.json (ColourConversionTest: stain optical densities by colour deconvolution): for
rectangle ROIs on sample images, the values of PyRadiomics' first-order, GLRLM, GLSZM and
NGTDM feature classes, and the histogram of scikit-image's local_binary_pattern (which PyRadiomics' LBP filter uses).
Rectangles avoid differences in mask rasterization (the core covers the pixels whose centres lie inside). Entropy and
uniformity are computed with a bin width of 1 on 8-bit images, which matches the core with quantization "none" and 256
gray levels; 16-bit cases only list the features that use the original intensities. The texture classes use 8-bit
images with a bin width of 1 in 2D (four in-plane directions, 8-connected zones, NGTDM rings at distances 1 and 2),
matching the core's fixed bin width of 1. LBP uses the original 8- and 16-bit intensities of the whole image at radii 1
and 2. Shape features use masks of their own (ellipses, a ring, separate parts, pixels touching only at corners, a
thresholded part of an image) at three pixel spacings, stored as runs so the test uses exactly the same pixels.
Resampling uses SimpleITK's B-spline resampler with the grid PyRadiomics' resampleImage uses (aligned to the image's
corner), on crops of sample images, with real-valued output so the test sees the interpolation before any rounding.

Only developers run this script, to regenerate the reference data; the application and the tests never call Python.

Setup (Python 3.12; PyRadiomics 3.1.0 has no wheels for newer Python versions and is built from its git tag):
    uv venv --python 3.12 .venv-radiomics
    uv pip install --python .venv-radiomics/bin/python -r scripts/requirements-radiomics.txt
    .venv-radiomics/bin/python scripts/radiomics-reference.py
"""

import json
from pathlib import Path

import numpy as np
import pywt
import radiomics
import SimpleITK as sitk
import skimage
import skimage.io
from radiomics import firstorder, glrlm, glszm, ngtdm, shape2D
from skimage.feature import local_binary_pattern

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'core' / 'tests' / 'data' / 'pyradiomics-firstorder.json'
GLRLM_OUTPUT = ROOT / 'core' / 'tests' / 'data' / 'pyradiomics-glrlm.json'
GLSZM_OUTPUT = ROOT / 'core' / 'tests' / 'data' / 'pyradiomics-glszm.json'
NGTDM_OUTPUT = ROOT / 'core' / 'tests' / 'data' / 'pyradiomics-ngtdm.json'
LBP_OUTPUT = ROOT / 'core' / 'tests' / 'data' / 'scikit-image-lbp.json'
SHAPE_OUTPUT = ROOT / 'core' / 'tests' / 'data' / 'pyradiomics-shape2d.json'
RESAMPLING_OUTPUT = ROOT / 'core' / 'tests' / 'data' / 'simpleitk-resampling.json'
LOG_OUTPUT = ROOT / 'core' / 'tests' / 'data' / 'simpleitk-log.json'
LOG_FEATURES_OUTPUT = ROOT / 'core' / 'tests' / 'data' / 'pyradiomics-log-features.json'
WAVELET_OUTPUT = ROOT / 'core' / 'tests' / 'data' / 'pywavelets-wavelet.json'
WAVELET_FEATURES_OUTPUT = ROOT / 'core' / 'tests' / 'data' / 'pyradiomics-wavelet-features.json'
STAINS_OUTPUT = ROOT / 'core' / 'tests' / 'data' / 'scikit-image-stains.json'
LBP_SAMPLES = 8

# PyRadiomics feature name -> core feature id
FEATURES = {
    'Minimum': 'Minimum',
    'Maximum': 'Maximum',
    'Range': 'Range',
    'Median': 'Median',
    '10Percentile': 'Percentile10',
    '90Percentile': 'Percentile90',
    'InterquartileRange': 'InterquartileRange',
    'MeanAbsoluteDeviation': 'MeanAbsoluteDeviation',
    'RobustMeanAbsoluteDeviation': 'RobustMeanAbsoluteDeviation',
    'RootMeanSquared': 'RootMeanSquared',
    'Energy': 'FirstOrderEnergy',
    'Variance': 'Variance',
    'Skewness': 'Skewness',
    'Kurtosis': 'Kurtosis',
    'Mean': 'Mean',
    'Entropy': 'FirstOrderEntropy',
    'Uniformity': 'Uniformity',
}
BINNED = {'Entropy', 'Uniformity'}

# Sample image, rectangle (x, y, width, height) in pixels
CASES = [
    ('textures/camera.png', (100, 100, 64, 48)),
    ('textures/brick.png', (200, 150, 90, 70)),
    ('medical/ct-chest.png', (180, 200, 120, 80)),
]
# Texture features need gray levels a bin width of 1 can hold within the core's 256 levels
EIGHT_BIT_CASES = [case for case in CASES if case[0].startswith('textures/')]


def reference(image_path: str, rectangle: tuple[int, int, int, int]) -> dict:
    pixels = sitk.GetArrayFromImage(sitk.ReadImage(str(ROOT / 'samples' / image_path)))
    assert pixels.ndim == 2, image_path
    eight_bit = pixels.dtype == np.uint8
    x, y, width, height = rectangle
    mask = np.zeros(pixels.shape, dtype=np.uint8)
    mask[y : y + height, x : x + width] = 1

    image = sitk.GetImageFromArray(pixels[np.newaxis])
    label = sitk.GetImageFromArray(mask[np.newaxis])
    features = firstorder.RadiomicsFirstOrder(image, label, binWidth=1, voxelArrayShift=0)
    features.enableAllFeatures()
    values = features.execute()
    return {
        'image': image_path,
        'rectangle': list(rectangle),
        'bitDepth': 8 if eight_bit else 16,
        'features': {
            core: float(values[name]) for name, core in FEATURES.items() if eight_bit or name not in BINNED
        },
    }


def texture_reference(feature_class, image_path: str, rectangle: tuple[int, int, int, int], distance: int = 1) -> dict:
    """PyRadiomics values of a texture feature class in 2D with a bin width of 1, on an 8-bit image"""
    pixels = sitk.GetArrayFromImage(sitk.ReadImage(str(ROOT / 'samples' / image_path)))
    assert pixels.dtype == np.uint8, image_path
    x, y, width, height = rectangle
    mask = np.zeros(pixels.shape, dtype=np.uint8)
    mask[y : y + height, x : x + width] = 1
    image = sitk.GetImageFromArray(pixels[np.newaxis])
    label = sitk.GetImageFromArray(mask[np.newaxis])
    features = feature_class(image, label, binWidth=1, force2D=True, force2Ddimension=0, distances=[distance])
    features.enableAllFeatures()
    values = features.execute()
    # Feature names without the core's prefix ("Glrlm", "Glszm", "Ngtdm")
    reference = {
        'image': image_path,
        'rectangle': list(rectangle),
        'features': {name: float(value) for name, value in sorted(values.items())},
    }
    # Only the NGTDM depends on the distance: its neighbourhood is the ring at that distance
    if feature_class is ngtdm.RadiomicsNGTDM:
        reference['distance'] = distance
    return reference


def lbp_reference(image_path: str, rectangle: tuple[int, int, int, int], radius: int) -> dict:
    """Code fractions, entropy (log2) and energy of the rotation-invariant uniform LBP of the rectangle's pixels"""
    pixels = sitk.GetArrayFromImage(sitk.ReadImage(str(ROOT / 'samples' / image_path)))
    # The whole image, so the codes near the rectangle's edge sample the pixels around it
    codes = local_binary_pattern(pixels, LBP_SAMPLES, radius, method='uniform')
    x, y, width, height = rectangle
    region = codes[y : y + height, x : x + width].astype(np.int64)
    fractions = np.bincount(region.ravel(), minlength=LBP_SAMPLES + 2) / region.size
    features = {f'Uniform{k}': float(fractions[k]) for k in range(LBP_SAMPLES + 1)}
    features['NonUniform'] = float(fractions[LBP_SAMPLES + 1])
    features['Entropy'] = float(-np.sum(fractions * np.log2(fractions + np.spacing(1))))
    features['Energy'] = float(np.sum(fractions**2))
    return {'image': image_path, 'rectangle': list(rectangle), 'radius': radius, 'features': features}


def shape_masks() -> dict[str, np.ndarray]:
    """Masks for the shape features, pixel (row, col) inside when its centre (col + 0.5, row + 0.5) is"""
    rows, cols = np.mgrid[0:48, 0:64]
    x = cols + 0.5
    y = rows + 0.5
    masks = {}
    masks['ellipse'] = ((x - 30.3) / 17.2) ** 2 + ((y - 20.7) / 9.4) ** 2 <= 1
    angle = np.deg2rad(35)
    u = (x - 32) * np.cos(angle) + (y - 24) * np.sin(angle)
    v = -(x - 32) * np.sin(angle) + (y - 24) * np.cos(angle)
    masks['rotated ellipse'] = (u / 22) ** 2 + (v / 7.5) ** 2 <= 1
    distance = np.hypot(x - 30, y - 24)
    masks['ring'] = (distance <= 18) & (distance > 9)
    parts = np.zeros((48, 64), dtype=bool)
    parts[5:15, 4:20] = True
    parts[30:44, 40:58] = True
    parts[20:26, 30:33] = True
    masks['three parts'] = parts
    # Pixels that touch only at their corners: the ambiguous squares of marching squares
    diagonal = np.zeros((48, 64), dtype=bool)
    for k in range(12):
        diagonal[10 + k, 10 + k] = True
        diagonal[10 + k, 12 + k] = True
    diagonal[30:40:2, 30:50:2] = True
    masks['corners'] = diagonal
    triangle = (y > 6) & (x > 5) & (y < 0.8 * x + 10) & (y < -1.3 * x + 80)
    masks['triangle'] = triangle
    camera = sitk.GetArrayFromImage(sitk.ReadImage(str(ROOT / 'samples' / 'textures' / 'camera.png')))
    masks['camera threshold'] = camera[140:188, 200:264] < 60
    return masks


def shape_reference(name: str, mask: np.ndarray, spacing: tuple[float, float]) -> dict:
    """PyRadiomics shape2D values of a mask with a pixel spacing (x, y) in mm"""
    image = sitk.GetImageFromArray(np.zeros((1, *mask.shape), dtype=np.uint8))
    label = sitk.GetImageFromArray(mask.astype(np.uint8)[np.newaxis])
    for volume in (image, label):
        volume.SetSpacing((spacing[0], spacing[1], 1.0))
    features = shape2D.RadiomicsShape2D(image, label, force2D=True, force2Ddimension=0)
    features.enableAllFeatures()
    values = features.execute()
    runs = []
    for row in range(mask.shape[0]):
        padded = np.concatenate(([False], mask[row], [False]))
        edges = np.flatnonzero(padded[1:] != padded[:-1])
        runs.extend([row, int(start), int(end)] for start, end in zip(edges[::2], edges[1::2]))
    return {
        'name': name,
        'width': mask.shape[1],
        'height': mask.shape[0],
        'spacing': list(spacing),
        'runs': runs,
        'features': {feature: float(value) for feature, value in sorted(values.items())},
    }


def resampling_reference(image_path: str, crop: tuple[int, int, int, int], old: tuple[float, float], new: tuple[float, float]) -> dict:
    """SimpleITK B-spline resampling of an image crop from one pixel spacing (x, y) to another, as real values"""
    x, y, width, height = crop
    pixels = sitk.GetArrayFromImage(sitk.ReadImage(str(ROOT / 'samples' / image_path)))[y : y + height, x : x + width]
    image = sitk.GetImageFromArray(np.ascontiguousarray(pixels))
    image.SetSpacing(old)
    size = [int(np.ceil(n * o / s)) for n, o, s in zip((width, height), old, new)]
    resampler = sitk.ResampleImageFilter()
    resampler.SetOutputSpacing(new)
    # PyRadiomics' newOriginIndex: the new grid starts at the image's corner
    resampler.SetOutputOrigin([0.5 * (s - o) for o, s in zip(old, new)])
    resampler.SetSize(size)
    resampler.SetOutputPixelType(sitk.sitkFloat64)
    resampler.SetInterpolator(sitk.sitkBSpline)
    resampler.SetDefaultPixelValue(0)
    values = sitk.GetArrayFromImage(resampler.Execute(image))
    return {
        'image': image_path,
        'crop': list(crop),
        'from': list(old),
        'to': list(new),
        'size': size,
        'values': [float(value) for value in values.ravel()],
    }


def log_reference(image_path: str, crop: tuple[int, int, int, int], spacing: tuple[float, float], sigma: float) -> dict:
    """SimpleITK's Laplacian of Gaussian as PyRadiomics applies it (recursive Gaussian, normalized across scale), float32"""
    x, y, width, height = crop
    pixels = sitk.GetArrayFromImage(sitk.ReadImage(str(ROOT / 'samples' / image_path)))[y : y + height, x : x + width]
    image = sitk.GetImageFromArray(np.ascontiguousarray(pixels))
    image.SetSpacing(spacing)
    log = sitk.LaplacianRecursiveGaussianImageFilter()
    log.SetNormalizeAcrossScale(True)
    log.SetSigma(sigma)
    values = sitk.GetArrayFromImage(log.Execute(image))
    return {
        'image': image_path,
        'crop': list(crop),
        'spacing': list(spacing),
        'sigma': sigma,
        'values': [float(value) for value in values.ravel()],
    }


def log_features_reference(
    image_path: str, rectangle: tuple[int, int, int, int], spacing: tuple[float, float], sigma: float, binning: dict
) -> dict:
    """PyRadiomics features of a LoG image (getLoGImage on the whole image) in a rectangle, with binWidth or binCount"""
    pixels = sitk.GetArrayFromImage(sitk.ReadImage(str(ROOT / 'samples' / image_path)))
    image = sitk.GetImageFromArray(pixels)
    image.SetSpacing(spacing)
    x, y, width, height = rectangle
    mask = np.zeros(pixels.shape, dtype=np.uint8)
    mask[y : y + height, x : x + width] = 1
    label = sitk.GetImageFromArray(mask)
    label.CopyInformation(image)
    [(log, name, _)] = list(radiomics.imageoperations.getLoGImage(image, label, sigma=[sigma]))
    # The feature classes as the extractor calls them on a derived 2D image
    log3d = sitk.JoinSeries(log)
    label3d = sitk.JoinSeries(label)
    settings = {'force2D': True, 'force2Ddimension': 0, 'distances': [1], **binning}
    features = {}
    for prefix, feature_class in (('', firstorder.RadiomicsFirstOrder), ('Glrlm', glrlm.RadiomicsGLRLM), ('Glszm', glszm.RadiomicsGLSZM), ('Ngtdm', ngtdm.RadiomicsNGTDM)):
        extractor = feature_class(log3d, label3d, **settings)
        extractor.enableAllFeatures()
        for feature, value in extractor.execute().items():
            if prefix == '':
                if feature in FEATURES:
                    features[FEATURES[feature]] = float(value)
            else:
                features[prefix + feature] = float(value)
    return {
        'image': image_path,
        'rectangle': list(rectangle),
        'spacing': list(spacing),
        'sigma': sigma,
        'imageType': name,
        'binning': binning,
        'features': features,
    }


def wavelet_images(pixels: np.ndarray, label: sitk.Image | None = None) -> dict[str, sitk.Image]:
    """PyRadiomics' getWaveletImage (coif1, level 1) of a 2D image: the band name without 'wavelet-' -> image"""
    image = sitk.GetImageFromArray(np.ascontiguousarray(pixels))
    if label is None:
        label = sitk.GetImageFromArray(np.ones(pixels.shape, dtype=np.uint8))
        label.CopyInformation(image)
    return {name.removeprefix('wavelet-'): result for result, name, _ in radiomics.imageoperations.getWaveletImage(image, label)}


def wavelet_reference(image_path: str, crop: tuple[int, int, int, int]) -> dict:
    """The four sub-bands PyRadiomics computes with PyWavelets' swtn, float64"""
    x, y, width, height = crop
    pixels = sitk.GetArrayFromImage(sitk.ReadImage(str(ROOT / 'samples' / image_path)))[y : y + height, x : x + width]
    bands = wavelet_images(pixels)
    return {
        'image': image_path,
        'crop': list(crop),
        'bands': {name: [float(value) for value in sitk.GetArrayFromImage(band).ravel()] for name, band in sorted(bands.items())},
    }


def wavelet_features_reference(image_path: str, rectangle: tuple[int, int, int, int], band: str, binning: dict) -> dict:
    """PyRadiomics features of one wavelet sub-band of the whole image in a rectangle, with binWidth or binCount"""
    pixels = sitk.GetArrayFromImage(sitk.ReadImage(str(ROOT / 'samples' / image_path)))
    x, y, width, height = rectangle
    mask = np.zeros(pixels.shape, dtype=np.uint8)
    mask[y : y + height, x : x + width] = 1
    image = sitk.GetImageFromArray(pixels)
    label = sitk.GetImageFromArray(mask)
    label.CopyInformation(image)
    filtered = wavelet_images(pixels, label)[band]
    filtered3d = sitk.JoinSeries(filtered)
    label3d = sitk.JoinSeries(label)
    settings = {'force2D': True, 'force2Ddimension': 0, 'distances': [1], **binning}
    features = {}
    for prefix, feature_class in (('', firstorder.RadiomicsFirstOrder), ('Glrlm', glrlm.RadiomicsGLRLM), ('Glszm', glszm.RadiomicsGLSZM), ('Ngtdm', ngtdm.RadiomicsNGTDM)):
        extractor = feature_class(filtered3d, label3d, **settings)
        extractor.enableAllFeatures()
        for feature, value in extractor.execute().items():
            if prefix == '':
                if feature in FEATURES:
                    features[FEATURES[feature]] = float(value)
            else:
                features[prefix + feature] = float(value)
    return {
        'image': image_path,
        'rectangle': list(rectangle),
        'band': band,
        'binning': binning,
        'features': features,
    }


def synthetic_rgb() -> np.ndarray:
    """The 256 × 256 test image of ColourConversionTest (and scripts/imagej-colour): R = x, G = y, B = (7x + 13y) mod 256"""
    y, x = np.mgrid[0:256, 0:256]
    return np.stack([x, y, (7 * x + 13 * y) % 256], axis=-1).astype(np.uint8)


def stains_reference(name: str, rgb: np.ndarray, step: int) -> dict:
    """Optical densities of scikit-image's separate_stains (float64) at every step-th pixel of each row and column"""
    from skimage.color import hdx_from_rgb, hed_from_rgb, separate_stains

    he = separate_stains(rgb, hed_from_rgb)
    hdab = separate_stains(rgb, hdx_from_rgb)
    return {
        'image': name,
        'step': step,
        'hematoxylinHe': he[::step, ::step, 0].ravel().tolist(),
        'eosinHe': he[::step, ::step, 1].ravel().tolist(),
        'hematoxylinHdab': hdab[::step, ::step, 0].ravel().tolist(),
        'dabHdab': hdab[::step, ::step, 1].ravel().tolist(),
    }


def main() -> None:
    document = {
        'source': (
            f'PyRadiomics {radiomics.__version__}, NumPy {np.__version__}, '
            f'SimpleITK {sitk.Version_VersionString()}'
        ),
        'settings': {'binWidth': 1, 'voxelArrayShift': 0, 'logBase': 'log2'},
        'cases': [reference(image, rectangle) for image, rectangle in CASES],
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(document, indent=2) + '\n')
    print(f'{OUTPUT.relative_to(ROOT)}: {len(document["cases"])} cases from {document["source"]}')

    run_lengths = {
        'source': document['source'],
        'settings': {'binWidth': 1, 'force2D': True, 'force2Ddimension': 0, 'logBase': 'log2'},
        'cases': [texture_reference(glrlm.RadiomicsGLRLM, image, rectangle) for image, rectangle in EIGHT_BIT_CASES],
    }
    GLRLM_OUTPUT.write_text(json.dumps(run_lengths, indent=2) + '\n')
    print(f'{GLRLM_OUTPUT.relative_to(ROOT)}: {len(run_lengths["cases"])} cases')

    size_zones = {
        'source': document['source'],
        'settings': {'binWidth': 1, 'force2D': True, 'force2Ddimension': 0, 'logBase': 'log2'},
        'cases': [texture_reference(glszm.RadiomicsGLSZM, image, rectangle) for image, rectangle in EIGHT_BIT_CASES],
    }
    GLSZM_OUTPUT.write_text(json.dumps(size_zones, indent=2) + '\n')
    print(f'{GLSZM_OUTPUT.relative_to(ROOT)}: {len(size_zones["cases"])} cases')

    gray_tones = {
        'source': document['source'],
        'settings': {'binWidth': 1, 'force2D': True, 'force2Ddimension': 0},
        'cases': [
            texture_reference(ngtdm.RadiomicsNGTDM, image, rectangle, distance)
            for image, rectangle in EIGHT_BIT_CASES
            for distance in (1, 2)
        ],
    }
    NGTDM_OUTPUT.write_text(json.dumps(gray_tones, indent=2) + '\n')
    print(f'{NGTDM_OUTPUT.relative_to(ROOT)}: {len(gray_tones["cases"])} cases')

    patterns = {
        'source': f'scikit-image {skimage.__version__}, NumPy {np.__version__}',
        'settings': {'P': LBP_SAMPLES, 'method': 'uniform', 'logBase': 'log2'},
        'cases': [lbp_reference(image, rectangle, radius) for image, rectangle in CASES for radius in (1, 2)],
    }
    LBP_OUTPUT.write_text(json.dumps(patterns, indent=2) + '\n')
    print(f'{LBP_OUTPUT.relative_to(ROOT)}: {len(patterns["cases"])} cases from {patterns["source"]}')

    shapes = {
        'source': document['source'],
        'settings': {'force2D': True, 'force2Ddimension': 0, 'spacing': '(x, y) in mm'},
        'cases': [
            shape_reference(name, mask, spacing)
            for name, mask in shape_masks().items()
            for spacing in ((1.0, 1.0), (0.7, 1.3), (0.46875, 0.46875))
        ],
    }
    SHAPE_OUTPUT.write_text(json.dumps(shapes, indent=2) + '\n')
    print(f'{SHAPE_OUTPUT.relative_to(ROOT)}: {len(shapes["cases"])} cases')

    resampling = {
        'source': f'SimpleITK {sitk.Version_VersionString()} ({sitk.Version_ITKVersionString()}), sitkBSpline',
        'cases': [
            resampling_reference('textures/camera.png', (180, 120, 40, 30), (1.0, 1.0), (0.7, 1.3)),
            resampling_reference('textures/camera.png', (180, 120, 40, 30), (0.5, 0.8), (0.5, 0.5)),
            resampling_reference('textures/brick.png', (60, 90, 37, 29), (1.0, 1.0), (2.3, 1.7)),
            resampling_reference('medical/ct-chest.png', (200, 220, 33, 41), (0.703125, 0.703125), (1.0, 1.0)),
            resampling_reference('medical/mri-brain-t1.png', (90, 100, 3, 25), (1.0, 1.33), (1.0, 1.0)),
        ],
    }
    RESAMPLING_OUTPUT.write_text(json.dumps(resampling) + '\n')
    print(f'{RESAMPLING_OUTPUT.relative_to(ROOT)}: {len(resampling["cases"])} cases')

    laplacians = {
        'source': f'SimpleITK {sitk.Version_VersionString()} ({sitk.Version_ITKVersionString()}), LaplacianRecursiveGaussianImageFilter',
        'cases': [
            log_reference('textures/camera.png', (180, 120, 40, 30), (1.0, 1.0), 1.0),
            log_reference('textures/camera.png', (180, 120, 40, 30), (0.7, 1.3), 2.5),
            log_reference('textures/brick.png', (60, 90, 37, 29), (0.5, 0.5), 0.8),
            log_reference('medical/ct-chest.png', (200, 220, 33, 41), (0.703125, 0.703125), 3.0),
            log_reference('medical/mri-brain-t1.png', (90, 100, 4, 25), (1.0, 1.33), 1.2),
        ],
    }
    LOG_OUTPUT.write_text(json.dumps(laplacians) + '\n')
    print(f'{LOG_OUTPUT.relative_to(ROOT)}: {len(laplacians["cases"])} cases')

    log_features = {
        'source': document['source'],
        'settings': {'force2D': True, 'force2Ddimension': 0, 'distances': [1], 'voxelArrayShift': 0, 'logBase': 'log2'},
        'cases': [
            log_features_reference('textures/camera.png', (100, 100, 64, 48), (1.0, 1.0), 1.0, {'binWidth': 5}),
            log_features_reference('textures/brick.png', (200, 150, 90, 70), (0.5, 0.8), 2.0, {'binCount': 32}),
            log_features_reference('medical/ct-chest.png', (180, 200, 120, 80), (0.703125, 0.703125), 3.0, {'binWidth': 25}),
            log_features_reference('medical/ct-chest.png', (180, 200, 120, 80), (0.703125, 0.703125), 1.5, {'binCount': 64}),
        ],
    }
    LOG_FEATURES_OUTPUT.write_text(json.dumps(log_features, indent=2) + '\n')
    print(f'{LOG_FEATURES_OUTPUT.relative_to(ROOT)}: {len(log_features["cases"])} cases')

    wavelets = {
        'source': f'PyRadiomics {radiomics.__version__} getWaveletImage (PyWavelets {pywt.__version__} swtn, coif1, level 1)',
        'cases': [
            wavelet_reference('textures/camera.png', (180, 120, 40, 30)),
            wavelet_reference('textures/brick.png', (60, 90, 37, 29)),
            wavelet_reference('medical/ct-chest.png', (200, 220, 33, 41)),
            wavelet_reference('medical/mri-brain-t1.png', (90, 100, 3, 5)),
            wavelet_reference('textures/camera.png', (10, 10, 1, 2)),
        ],
    }
    WAVELET_OUTPUT.write_text(json.dumps(wavelets) + '\n')
    print(f'{WAVELET_OUTPUT.relative_to(ROOT)}: {len(wavelets["cases"])} cases')

    wavelet_features = {
        'source': document['source'],
        'settings': {'force2D': True, 'force2Ddimension': 0, 'distances': [1], 'voxelArrayShift': 0, 'logBase': 'log2'},
        'cases': [
            wavelet_features_reference('textures/camera.png', (100, 100, 64, 48), 'LL', {'binWidth': 5}),
            wavelet_features_reference('textures/brick.png', (200, 150, 90, 70), 'LH', {'binCount': 32}),
            wavelet_features_reference('medical/ct-chest.png', (180, 200, 120, 80), 'HL', {'binWidth': 25}),
            wavelet_features_reference('medical/ct-chest.png', (180, 200, 120, 80), 'HH', {'binCount': 64}),
        ],
    }
    WAVELET_FEATURES_OUTPUT.write_text(json.dumps(wavelet_features, indent=2) + '\n')
    print(f'{WAVELET_FEATURES_OUTPUT.relative_to(ROOT)}: {len(wavelet_features["cases"])} cases')

    stains = {
        'source': f'scikit-image {skimage.__version__} separate_stains with hed_from_rgb and hdx_from_rgb',
        'cases': [
            stains_reference('synthetic', synthetic_rgb(), 9),
            stains_reference('textures/ihc.png', skimage.io.imread(ROOT / 'samples' / 'textures' / 'ihc.png'), 17),
        ],
    }
    STAINS_OUTPUT.write_text(json.dumps(stains) + '\n')
    print(f'{STAINS_OUTPUT.relative_to(ROOT)}: {len(stains["cases"])} cases')


if __name__ == '__main__':
    main()
