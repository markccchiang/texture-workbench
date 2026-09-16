# ImageJ ROI reference data

The workbench reads and writes ImageJ's ROI files (`.roi`, and the `RoiSet.zip` archives of its ROI Manager) in
`packages/api/src/imagejRoi.ts`. These files check that an ROI covers the same pixels in both programs. The data comes
from ImageJ itself, and `packages/api/test/imagejRoi.test.ts` compares it with the core:

| File in `packages/api/test/data/imagej/` | Written by | Contents |
| --- | --- | --- |
| `imagej-rois.zip`, `oval.roi` | ImageJ (`reference`) | ROIs of every kind saved by ImageJ, including sub-pixel, rounded, spline-fitted and composite ROIs, lines and points, and ROIs whose edges pass through pixel centres |
| `imagej-rois.json` | ImageJ (`reference`) | For every entry: ImageJ's type, name, colour, and the count, index sum and index sum of squares of the pixels in its mask on a 256 × 256 image |
| `workbench-rois.json`, `workbench-RoiSet.zip` | `workbench-rois.ts` | ROIs as drawn in the workbench, and the archive the workbench writes for them |
| `workbench-imagej.json` | ImageJ (`measure`) | The same description of `workbench-RoiSet.zip`, as ImageJ reads it |

Only developers run this, to regenerate the data; the application and the tests never call Java. It needs Docker and
ImageJ 1.54p from Maven Central:

```bash
curl -fsSO https://repo1.maven.org/maven2/net/imagej/ij/1.54p/ij-1.54p.jar
echo "2e1a09961dfb41cee66ddc821b2577a41a072566ce45a49bae69267099741e20  ij-1.54p.jar" | shasum -a 256 -c

imagej() {
  docker run --rm -v "$PWD":/work -w /work \
    eclipse-temurin@sha256:78ab9771b4650066c3ef748d46e05dbd6094d8bb34e0667a074486812efd655b \
    java -Djava.awt.headless=true -cp ij-1.54p.jar scripts/imagej-roi/ImageJRoiReference.java "$@"
}
DATA=packages/api/test/data/imagej

imagej reference $DATA                                             # ImageJ's ROIs and their pixels
npx tsx scripts/imagej-roi/workbench-rois.ts                       # the workbench's archive
imagej measure $DATA/workbench-RoiSet.zip > $DATA/workbench-imagej.json   # ... as ImageJ measures it
rm ij-1.54p.jar
```

The image is `eclipse-temurin:21-jdk` (OpenJDK 21.0.12) pinned by digest. Rerun `measure` whenever the writer changes:
the test fails when the archive's bytes differ from `workbench-RoiSet.zip`, because ImageJ's measurement belongs to
those bytes.
