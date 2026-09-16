// Reference data for the ImageJ ROI files, written by ImageJ itself (see README.md in this folder).
//
//   reference <dir>   writes imagej-rois.zip (ROIs saved by ImageJ, as its ROI Manager saves them), oval.roi (one ROI
//                     on its own) and imagej-rois.json (for every entry: ImageJ's type and name, and the pixels
//                     ImageJ's mask covers on a 256 x 256 image)
//   measure <zip>     prints the same description for every entry of an archive, as ImageJ reads it: this checks
//                     the files the workbench writes

import ij.gui.*;
import ij.io.RoiDecoder;
import ij.io.RoiEncoder;
import ij.process.ByteProcessor;
import java.awt.Color;
import java.awt.Point;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;

public class ImageJRoiReference {
    static final int SIZE = 256;

    public static void main(String[] args) throws Exception {
        if (args.length == 2 && args[0].equals("reference")) {
            reference(Paths.get(args[1]));
        } else if (args.length == 2 && args[0].equals("measure")) {
            System.out.println(describe(readZip(Files.readAllBytes(Paths.get(args[1])))));
        } else {
            System.err.println("Usage: reference <dir> | measure <zip>");
            System.exit(2);
        }
    }

    static void reference(Path dir) throws Exception {
        LinkedHashMap<String, Roi> rois = new LinkedHashMap<>();
        rois.put("rectangle", new Roi(20, 30, 41, 17));
        rois.put("rectangle sub-pixel", new Roi(20.3, 30.7, 40.6, 17.2));
        Roi rounded = new Roi(70, 20, 60, 40);
        rounded.setCornerDiameter(18);
        rois.put("rounded rectangle", rounded);
        rois.put("oval", new OvalRoi(140, 20, 51, 36));
        rois.put("oval sub-pixel", new OvalRoi(140.4, 70.6, 50.5, 35.25));
        rois.put("polygon", new PolygonRoi(new int[] {10, 60, 80, 40, 10}, new int[] {90, 80, 130, 150, 120}, 5, Roi.POLYGON));
        rois.put("polygon on pixel centres", new PolygonRoi(new float[] {90.5f, 120.5f, 140.5f, 100.5f}, new float[] {90.5f, 95.5f, 140.5f, 150.5f}, 4, Roi.POLYGON));
        rois.put("freehand", new PolygonRoi(circle(200, 120, 30, 40, true), Roi.FREEROI));
        rois.put("traced", traced());
        PolygonRoi spline = new PolygonRoi(new int[] {20, 70, 60, 15}, new int[] {170, 175, 230, 220}, 4, Roi.POLYGON);
        spline.fitSpline();
        rois.put("spline", spline);
        PolygonRoi freehandSpline = new PolygonRoi(circle(120, 200, 25, 12, true), Roi.FREEROI);
        freehandSpline.fitSpline();
        rois.put("freehand spline", freehandSpline);
        rois.put("ellipse", new EllipseRoi(170, 170, 240, 230, 0.45));
        rois.put("rotated rectangle", new RotatedRectRoi(160, 240, 240, 200, 14));
        rois.put("rectangle with a hole", new ShapeRoi(new Roi(30, 180, 60, 50)).not(new ShapeRoi(new OvalRoi(45, 190, 30, 25))));
        rois.put("two ovals xor", new ShapeRoi(new OvalRoi(100, 100, 40, 40)).xor(new ShapeRoi(new OvalRoi(120, 110, 40, 40))));
        rois.put("two parts", new ShapeRoi(new PolygonRoi(new int[] {5, 25, 15}, new int[] {5, 5, 25}, 3, Roi.POLYGON))
                .or(new ShapeRoi(new Roi(200, 5, 20, 10))));
        rois.put("Läsion α", new OvalRoi(60, 60, 20, 20));
        rois.get("Läsion α").setStrokeColor(new Color(0xE6, 0x4B, 0x35));
        rois.put("line", new Line(10, 10, 100, 40));
        rois.put("points", new PointRoi(new int[] {5, 50}, new int[] {5, 60}, 2));
        rois.put("polyline", new PolygonRoi(new int[] {10, 50, 90}, new int[] {200, 210, 190}, 3, Roi.POLYLINE));
        rois.put("angle", new PolygonRoi(new int[] {30, 60, 90}, new int[] {60, 30, 60}, 3, Roi.ANGLE));

        // Many ordinary ROIs, where ties between edges and pixel centres come up by chance
        Random random = new Random(20260916);
        for (int i = 0; i < 40; i++) {
            float[][] c = circle(40 + random.nextDouble() * 176, 40 + random.nextDouble() * 176, 10 + random.nextDouble() * 25, 5 + random.nextInt(15), false, random);
            int n = c[0].length;
            int[] x = new int[n], y = new int[n];
            for (int j = 0; j < n; j++) {
                x[j] = Math.round(c[0][j]);
                y[j] = Math.round(c[1][j]);
            }
            switch (i % 4) {
                case 0: rois.put("random polygon " + i, new PolygonRoi(x, y, n, Roi.POLYGON)); break;
                case 1: rois.put("random sub-pixel polygon " + i, new PolygonRoi(c[0], c[1], n, Roi.POLYGON)); break;
                case 2: {
                    PolygonRoi s = new PolygonRoi(x, y, n, Roi.FREEROI);
                    s.fitSpline();
                    rois.put("random spline " + i, s);
                    break;
                }
                default: rois.put("random oval " + i, new OvalRoi(x[0] - 20, y[0] - 15, 10 + random.nextInt(40), 10 + random.nextInt(30)));
            }
        }

        ByteArrayOutputStream zip = new ByteArrayOutputStream();
        try (ZipOutputStream out = new ZipOutputStream(zip)) {
            for (Map.Entry<String, Roi> entry : rois.entrySet()) {
                entry.getValue().setName(entry.getKey());
                out.putNextEntry(new ZipEntry(entry.getKey() + ".roi"));
                out.write(RoiEncoder.saveAsByteArray(entry.getValue()));
                out.closeEntry();
            }
        }
        Files.createDirectories(dir);
        Files.write(dir.resolve("imagej-rois.zip"), zip.toByteArray());
        Files.write(dir.resolve("oval.roi"), RoiEncoder.saveAsByteArray(rois.get("Läsion α")));
        Files.write(dir.resolve("imagej-rois.json"), describe(readZip(zip.toByteArray())).getBytes(StandardCharsets.UTF_8));
    }

    /** Entries of an archive as ImageJ's ROI Manager opens them */
    static LinkedHashMap<String, Roi> readZip(byte[] bytes) throws IOException {
        LinkedHashMap<String, Roi> rois = new LinkedHashMap<>();
        try (ZipInputStream in = new ZipInputStream(new ByteArrayInputStream(bytes))) {
            for (ZipEntry entry; (entry = in.getNextEntry()) != null; ) {
                if (entry.getName().endsWith(".roi")) {
                    rois.put(entry.getName(), new RoiDecoder(in.readAllBytes(), entry.getName()).getRoi());
                }
            }
        }
        return rois;
    }

    /** For every ROI: its entry, ImageJ type and name, and the pixels of its mask on a 256 x 256 image */
    static String describe(LinkedHashMap<String, Roi> rois) {
        StringBuilder json = new StringBuilder("{\n  \"imagej\": \"" + ij.IJ.getVersion() + "\",\n  \"width\": " + SIZE + ",\n  \"height\": " + SIZE + ",\n  \"rois\": [");
        String separator = "\n";
        for (Map.Entry<String, Roi> entry : rois.entrySet()) {
            Roi roi = entry.getValue();
            json.append(separator).append("    {\"entry\": ").append(quote(entry.getKey()))
                .append(", \"name\": ").append(quote(roi.getName()))
                .append(", \"type\": ").append(quote(roi.getTypeAsString()));
            if (roi.getStrokeColor() != null) {
                json.append(", \"color\": ").append(quote(String.format("#%06X", roi.getStrokeColor().getRGB() & 0xFFFFFF)));
            }
            if (roi.isArea()) {
                // Pixel index i = y * 256 + x: the count, the sum and the sum of squares identify the pixels
                long count = 0, sum = 0, sumSquares = 0;
                for (Point p : roi.getContainedPoints()) {
                    if (p.x >= 0 && p.y >= 0 && p.x < SIZE && p.y < SIZE) {
                        long index = (long) p.y * SIZE + p.x;
                        count++;
                        sum += index;
                        sumSquares += index * index;
                    }
                }
                json.append(", \"pixels\": {\"count\": ").append(count).append(", \"sum\": ").append(sum).append(", \"sumSquares\": ").append(sumSquares).append("}");
            }
            json.append("}");
            separator = ",\n";
        }
        return json.append("\n  ]\n}\n").toString();
    }

    static String quote(String text) {
        StringBuilder out = new StringBuilder("\"");
        for (char c : text.toCharArray()) {
            if (c == '"' || c == '\\') {
                out.append('\\').append(c);
            } else if (c < 0x20 || c > 0x7e) {
                out.append(String.format("\\u%04x", (int) c));
            } else {
                out.append(c);
            }
        }
        return out.append('"').toString();
    }

    /** A wand outline of a blob on an image, as ImageJ's wand tool makes it */
    static Roi traced() {
        ByteProcessor ip = new ByteProcessor(SIZE, SIZE);
        ip.setValue(255);
        ip.fill(new OvalRoi(150, 150, 45, 30));
        ip.fill(new Roi(185, 140, 20, 50));
        Wand wand = new Wand(ip);
        wand.autoOutline(170, 165, 255.0, 255.0);
        return new PolygonRoi(wand.xpoints, wand.ypoints, wand.npoints, Roi.TRACED_ROI);
    }

    static FloatPolygon circle(double cx, double cy, double r, int n, boolean integer) {
        float[][] c = circle(cx, cy, r, n, integer, new Random(n));
        return new FloatPolygon(c[0], c[1]);
    }

    static float[][] circle(double cx, double cy, double r, int n, boolean integer, Random random) {
        float[] x = new float[n], y = new float[n];
        for (int i = 0; i < n; i++) {
            double angle = 2 * Math.PI * i / n;
            double radius = r * (0.75 + 0.5 * random.nextDouble());
            x[i] = (float) (cx + radius * Math.cos(angle));
            y[i] = (float) (cy + radius * Math.sin(angle));
            if (integer) {
                x[i] = Math.round(x[i]);
                y[i] = Math.round(y[i]);
            }
        }
        return new float[][] {x, y};
    }

    // ij.process.FloatPolygon without the import clash with java.awt
    static class FloatPolygon extends ij.process.FloatPolygon {
        FloatPolygon(float[] x, float[] y) {
            super(x, y);
        }
    }
}
