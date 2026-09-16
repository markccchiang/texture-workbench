#!/usr/bin/env python3
"""Reference values of first-order, texture and shape features from PyRadiomics and scikit-image, for the core tests.

Writes core/tests/data/pyradiomics-firstorder.json (FirstOrderTest), pyradiomics-glrlm.json (RunLengthTest),
pyradiomics-glszm.json (SizeZoneTest), pyradiomics-ngtdm.json (GrayToneDifferenceTest) and scikit-image-lbp.json
(LocalBinaryPatternTest) and pyradiomics-shape2d.json (ShapeTest): for rectangle ROIs on sample images, the values of PyRadiomics' first-order, GLRLM, GLSZM and
NGTDM feature classes, and the histogram of scikit-image's local_binary_pattern (which PyRadiomics' LBP filter uses).
Rectangles avoid differences in mask rasterization (the core covers the pixels whose centres lie inside). Entropy and
uniformity are computed with a bin width of 1 on 8-bit images, which matches the core with quantization "none" and 256
gray levels; 16-bit cases only list the features that use the original intensities. The texture classes use 8-bit
images with a bin width of 1 in 2D (four in-plane directions, 8-connected zones, NGTDM rings at distances 1 and 2),
matching the core's fixed bin width of 1. LBP uses the original 8- and 16-bit intensities of the whole image at radii 1
and 2. Shape features use masks of their own (ellipses, a ring, separate parts, pixels touching only at corners, a
thresholded part of an image) at three pixel spacings, stored as runs so the test uses exactly the same pixels.

Only developers run this script, to regenerate the reference data; the application and the tests never call Python.

Setup (Python 3.12; PyRadiomics 3.1.0 has no wheels for newer Python versions and is built from its git tag):
    uv venv --python 3.12 .venv-radiomics
    uv pip install --python .venv-radiomics/bin/python -r scripts/requirements-radiomics.txt
    .venv-radiomics/bin/python scripts/radiomics-reference.py
"""

import json
from pathlib import Path

import numpy as np
import radiomics
import SimpleITK as sitk
import skimage
from radiomics import firstorder, glrlm, glszm, ngtdm, shape2D
from skimage.feature import local_binary_pattern

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'core' / 'tests' / 'data' / 'pyradiomics-firstorder.json'
GLRLM_OUTPUT = ROOT / 'core' / 'tests' / 'data' / 'pyradiomics-glrlm.json'
GLSZM_OUTPUT = ROOT / 'core' / 'tests' / 'data' / 'pyradiomics-glszm.json'
NGTDM_OUTPUT = ROOT / 'core' / 'tests' / 'data' / 'pyradiomics-ngtdm.json'
LBP_OUTPUT = ROOT / 'core' / 'tests' / 'data' / 'scikit-image-lbp.json'
SHAPE_OUTPUT = ROOT / 'core' / 'tests' / 'data' / 'pyradiomics-shape2d.json'
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


if __name__ == '__main__':
    main()
