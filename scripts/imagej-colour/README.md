# ImageJ colour conversion reference data

`core/tests/data/imagej-colour.json` holds the SHA-256 of ImageJ's unweighted RGB → 8-bit conversion and of the three
slices of its HSB stack, for a 256 × 256 image whose pixel (x, y) is R = x, G = y, B = (7x + 13y) mod 256.
`ColourConversionTest.MeanAndHsbMatchImageJ` builds the same image and compares the hashes of `ConvertColour`'s
results (`core/imaging/ColourConversion`).

Only developers run this, to regenerate the data; the application and the tests never call Java. It needs Docker and
ImageJ 1.54p from Maven Central (the same jar and container as `scripts/imagej-roi/`):

```bash
curl -fsSO https://repo1.maven.org/maven2/net/imagej/ij/1.54p/ij-1.54p.jar
echo "2e1a09961dfb41cee66ddc821b2577a41a072566ce45a49bae69267099741e20  ij-1.54p.jar" | shasum -a 256 -c

docker run --rm -v "$PWD":/work -w /work \
  eclipse-temurin@sha256:78ab9771b4650066c3ef748d46e05dbd6094d8bb34e0667a074486812efd655b \
  java -Djava.awt.headless=true -cp ij-1.54p.jar scripts/imagej-colour/ImageJColourReference.java > core/tests/data/imagej-colour.json
```

The stain densities are compared with scikit-image instead: `scripts/radiomics-reference.py` writes
`core/tests/data/scikit-image-stains.json`.
