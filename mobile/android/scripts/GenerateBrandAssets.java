import java.awt.AlphaComposite;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.imageio.ImageIO;

final class GenerateBrandAssets {
    private static final String SOURCE_SHA256 = "4871810f45b233e384852af995dbb510a3c1765acc6410a0035396a847ddb568";
    private static final Map<String, Integer> OUTPUTS = new LinkedHashMap<>();

    static {
        OUTPUTS.put("mipmap-mdpi", 48);
        OUTPUTS.put("mipmap-hdpi", 72);
        OUTPUTS.put("mipmap-xhdpi", 96);
        OUTPUTS.put("mipmap-xxhdpi", 144);
        OUTPUTS.put("mipmap-xxxhdpi", 192);
    }

    // verify or regenerate android launcher assets
    public static void main(String[] arguments) throws Exception {
        if (arguments.length != 1 || !(arguments[0].equals("--check") || arguments[0].equals("--write"))) {
            throw new IllegalArgumentException("usage: java mobile/android/scripts/GenerateBrandAssets.java --check|--write");
        }
        Path root = Path.of("").toAbsolutePath().normalize();
        Path source = root.resolve("apps/web/public/brand/weather-app-icon-master.png");
        byte[] sourceBytes = Files.readAllBytes(source);
        require(sha256(sourceBytes).equals(SOURCE_SHA256), "brand master hash changed; review provenance before regeneration");
        BufferedImage master = ImageIO.read(source.toFile());
        require(master != null && master.getWidth() == 1254 && master.getHeight() == 1254, "brand master dimensions changed");
        // produce every android density from the same master
        for (Map.Entry<String, Integer> output : OUTPUTS.entrySet()) {
            byte[] expected = render(master, output.getValue());
            Path path = root.resolve("mobile/android/app/src/main/res")
                .resolve(output.getKey())
                .resolve("ic_launcher.png");
            if (arguments[0].equals("--write")) {
                Files.createDirectories(path.getParent());
                Files.write(path, expected);
            } else {
                require(Files.exists(path), "missing generated asset " + path);
                require(MessageDigest.isEqual(expected, Files.readAllBytes(path)), "generated asset differs " + path);
            }
            System.out.println(output.getKey() + "/ic_launcher.png " + output.getValue() + "x" + output.getValue() + " " + sha256(expected));
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
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        require(ImageIO.write(output, "png", bytes), "png writer unavailable");
        return bytes.toByteArray();
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
