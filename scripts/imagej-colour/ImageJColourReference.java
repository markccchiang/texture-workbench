// Reference data for the colour conversions that follow ImageJ: RGB → 8-bit without weights (ImageJ's default) and the
// HSB stack. Writes a JSON object with the SHA-256 of each 8-bit result for a 256 × 256 test image whose pixel (x, y) is
// R = x, G = y, B = (7x + 13y) mod 256, which the core's ColourConversionTest builds the same way.
//
// Run with ImageJ 1.54p (see README.md next to this file for the jar and the container):
//   java -Djava.awt.headless=true -cp ij-1.54p.jar scripts/imagej-colour/ImageJColourReference.java > core/tests/data/imagej-colour.json

import ij.ImageStack;
import ij.process.ByteProcessor;
import ij.process.ColorProcessor;
import java.security.MessageDigest;

public class ImageJColourReference {
    static String sha256(byte[] bytes) throws Exception {
        StringBuilder text = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) {
            text.append(String.format("%02x", b));
        }
        return text.toString();
    }

    public static void main(String[] args) throws Exception {
        int size = 256;
        ColorProcessor image = new ColorProcessor(size, size);
        for (int y = 0; y < size; y++) {
            for (int x = 0; x < size; x++) {
                image.putPixel(x, y, new int[] {x, y, (7 * x + 13 * y) % 256});
            }
        }
        ColorProcessor.setWeightingFactors(1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0);
        byte[] mean = (byte[]) image.convertToByte(false).getPixels();
        ImageStack hsb = image.getHSBStack();
        System.out.println("{");
        System.out.println("  \"source\": \"ImageJ " + ij.IJ.getVersion() + ": ColorProcessor.convertToByte(false) with weights 1/3, getHSBStack()\",");
        System.out.println("  \"image\": \"256 x 256, R = x, G = y, B = (7x + 13y) mod 256\",");
        System.out.println("  \"mean\": \"" + sha256(mean) + "\",");
        System.out.println("  \"hue\": \"" + sha256((byte[]) hsb.getPixels(1)) + "\",");
        System.out.println("  \"saturation\": \"" + sha256((byte[]) hsb.getPixels(2)) + "\",");
        System.out.println("  \"brightness\": \"" + sha256((byte[]) hsb.getPixels(3)) + "\"");
        System.out.println("}");
    }
}
