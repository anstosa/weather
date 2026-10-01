import java.awt.AlphaComposite;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.Adler32;
import java.util.zip.CRC32;
import javax.imageio.ImageIO;

final class GenerateBrandAssets {
    private static final String SOURCE_SHA256 = "7e58a1c467e32de2637a350fc3d50a4925b4f4102bc394d94d913c9f81b24ba7";
    private static final Map<String, Integer> OUTPUTS = new LinkedHashMap<>();

    // retain density fallbacks alongside the shared adaptive artwork
    static {
        OUTPUTS.put("mipmap-mdpi/ic_launcher.png", 48);
        OUTPUTS.put("mipmap-hdpi/ic_launcher.png", 72);
        OUTPUTS.put("mipmap-xhdpi/ic_launcher.png", 96);
        OUTPUTS.put("mipmap-xxhdpi/ic_launcher.png", 144);
        OUTPUTS.put("mipmap-xxxhdpi/ic_launcher.png", 192);
        OUTPUTS.put("drawable-nodpi/ic_launcher_artwork.png", 512);
    }

    // verify or regenerate android launcher assets
    public static void main(String[] arguments) throws Exception {
        // require an explicit verification or generation mode
        if (arguments.length != 1 || !(arguments[0].equals("--check") || arguments[0].equals("--write"))) {
            throw new IllegalArgumentException("usage: java mobile/android/scripts/GenerateBrandAssets.java --check|--write");
        }
        Path root = Path.of("").toAbsolutePath().normalize();
        Path source = root.resolve("apps/web/public/brand/ballydidean-weather-icon-maskable-512.png");
        byte[] sourceBytes = Files.readAllBytes(source);
        require(sha256(sourceBytes).equals(SOURCE_SHA256), "maskable brand hash changed; review provenance before regeneration");
        BufferedImage master = ImageIO.read(source.toFile());
        require(master != null && master.getWidth() == 512 && master.getHeight() == 512, "maskable brand dimensions changed");
        // reject artwork with a baked transparent launcher mask
        for (int y = 0; y < master.getHeight(); y++) {
            // require opaque artwork through every corner and edge
            for (int x = 0; x < master.getWidth(); x++) {
                require((master.getRGB(x, y) >>> 24) == 255, "maskable brand must be fully opaque");
            }
        }
        // package full-bleed artwork and unmasked density fallbacks
        for (Map.Entry<String, Integer> output : OUTPUTS.entrySet()) {
            // preserve the reviewed adaptive artwork byte for byte
            byte[] expected = output.getValue() == master.getWidth() ? sourceBytes : render(master, output.getValue());
            Path path = root.resolve("mobile/android/app/src/main/res")
                .resolve(output.getKey());
            // write only through the explicit generation command
            if (arguments[0].equals("--write")) {
                Files.createDirectories(path.getParent());
                Files.write(path, expected);
            } else {
                require(Files.exists(path), "missing generated asset " + path);
                require(MessageDigest.isEqual(expected, Files.readAllBytes(path)), "generated asset differs " + path);
            }
            System.out.println(output.getKey() + " " + output.getValue() + "x" + output.getValue() + " " + sha256(expected));
        }
    }

    // resize without redrawing the repository brand
    private static byte[] render(BufferedImage master, int size) throws Exception {
        BufferedImage output = new BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB);
        Graphics2D graphics = output.createGraphics();
        try {
            graphics.setComposite(AlphaComposite.Src);
            graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
            graphics.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
            graphics.setRenderingHint(RenderingHints.KEY_ALPHA_INTERPOLATION, RenderingHints.VALUE_ALPHA_INTERPOLATION_QUALITY);
            graphics.drawImage(master, 0, 0, size, size, null);
        } finally {
            graphics.dispose();
        }
        return encodePng(output);
    }

    // encode portable filter-zero rgba bytes
    private static byte[] encodePng(BufferedImage image) throws Exception {
        ByteArrayOutputStream scanlines = new ByteArrayOutputStream();
        // emit every raster row without a platform-selected filter
        for (int y = 0; y < image.getHeight(); y++) {
            scanlines.write(0);
            // preserve each java2d rgba sample exactly
            for (int x = 0; x < image.getWidth(); x++) {
                int pixel = image.getRGB(x, y);
                scanlines.write((pixel >>> 16) & 0xff);
                scanlines.write((pixel >>> 8) & 0xff);
                scanlines.write(pixel & 0xff);
                scanlines.write((pixel >>> 24) & 0xff);
            }
        }

        ByteArrayOutputStream header = new ByteArrayOutputStream();
        DataOutputStream headerData = new DataOutputStream(header);
        headerData.writeInt(image.getWidth());
        headerData.writeInt(image.getHeight());
        headerData.writeByte(8);
        headerData.writeByte(6);
        headerData.writeByte(0);
        headerData.writeByte(0);
        headerData.writeByte(0);

        ByteArrayOutputStream png = new ByteArrayOutputStream();
        png.write(new byte[] {(byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a});
        writeChunk(png, "IHDR", header.toByteArray());
        writeChunk(png, "IDAT", storedDeflate(scanlines.toByteArray()));
        writeChunk(png, "IEND", new byte[0]);
        return png.toByteArray();
    }

    // avoid vendor-dependent deflate decisions
    private static byte[] storedDeflate(byte[] payload) throws Exception {
        ByteArrayOutputStream encoded = new ByteArrayOutputStream();
        encoded.write(0x78);
        encoded.write(0x01);
        int offset = 0;
        // emit fixed-size stored deflate blocks
        while (offset < payload.length) {
            int length = Math.min(65_535, payload.length - offset);
            boolean last = offset + length == payload.length;
            encoded.write(last ? 1 : 0);
            encoded.write(length & 0xff);
            encoded.write((length >>> 8) & 0xff);
            int inverse = length ^ 0xffff;
            encoded.write(inverse & 0xff);
            encoded.write((inverse >>> 8) & 0xff);
            encoded.write(payload, offset, length);
            offset += length;
        }
        Adler32 checksum = new Adler32();
        checksum.update(payload);
        new DataOutputStream(encoded).writeInt((int) checksum.getValue());
        return encoded.toByteArray();
    }

    // write one checksummed png chunk
    private static void writeChunk(
        ByteArrayOutputStream output,
        String name,
        byte[] payload
    ) throws Exception {
        byte[] type = name.getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        DataOutputStream data = new DataOutputStream(output);
        data.writeInt(payload.length);
        data.write(type);
        data.write(payload);
        CRC32 checksum = new CRC32();
        checksum.update(type);
        checksum.update(payload);
        data.writeInt((int) checksum.getValue());
    }

    // compute one lowercase sha-256 receipt
    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    // fail with one actionable asset message
    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new IllegalStateException(message);
        }
    }
}
