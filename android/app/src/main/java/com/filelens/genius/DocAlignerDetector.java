package com.filelens.genius;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.FloatBuffer;
import java.util.Collections;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;

/**
 * On-device neural document corner detector using DocsaidLab DocAligner (LCNet100, Apache-2.0).
 * Input: [1, 3, 256, 256] BGR float32 normalized to [0..1].
 * Output: [1, 4, 128, 128] corner heatmaps (TL, TR, BR, BL).
 */
public final class DocAlignerDetector {
    private static final String MODEL_ASSET_PATH = "models/docaligner-lcnet100.onnx";
    private static final int INPUT_SIZE = 256;
    private static final int HEATMAP_SIZE = 128;

    private static OrtEnvironment env;
    private static OrtSession session;
    private static final Object LOCK = new Object();

    private DocAlignerDetector() {}

    public static void warmupAsync(final Context context) {
        if (session != null || context == null) return;
        new Thread(() -> {
            try {
                ensureLoaded(context.getApplicationContext());
            } catch (Throwable ignored) {}
        }, "DocAlignerWarmup").start();
    }

    private static void ensureLoaded(Context context) throws Exception {
        if (session != null) return;
        synchronized (LOCK) {
            if (session != null) return;
            env = OrtEnvironment.getEnvironment();
            byte[] modelBytes;
            try (InputStream is = context.getAssets().open(MODEL_ASSET_PATH);
                 ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = is.read(buf)) != -1) {
                    bos.write(buf, 0, n);
                }
                modelBytes = bos.toByteArray();
            }
            OrtSession.SessionOptions opts = new OrtSession.SessionOptions();
            opts.setIntraOpNumThreads(2);
            opts.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
            session = env.createSession(modelBytes, opts);
        }
    }

    public static String detectQuadJson(Context context, String dataUrlOrBase64) {
        if (dataUrlOrBase64 == null || dataUrlOrBase64.isEmpty()) return "";
        try {
            String b64 = dataUrlOrBase64;
            int comma = b64.indexOf(',');
            if (comma >= 0) {
                b64 = b64.substring(comma + 1);
            }
            byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
            Bitmap decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (decoded == null) return "";

            Bitmap scaled = Bitmap.createScaledBitmap(decoded, INPUT_SIZE, INPUT_SIZE, true);
            if (scaled != decoded) {
                decoded.recycle();
            }

            int[] pixels = new int[INPUT_SIZE * INPUT_SIZE];
            scaled.getPixels(pixels, 0, INPUT_SIZE, 0, 0, INPUT_SIZE, INPUT_SIZE);
            scaled.recycle();

            int planeSize = INPUT_SIZE * INPUT_SIZE;
            float[] chw = new float[3 * planeSize];
            final float inv255 = 1.0f / 255.0f;
            for (int i = 0; i < planeSize; i++) {
                int px = pixels[i];
                // Model expects BGR [0..1] in NCHW layout
                chw[i] = (px & 0xFF) * inv255;
                chw[planeSize + i] = ((px >> 8) & 0xFF) * inv255;
                chw[2 * planeSize + i] = ((px >> 16) & 0xFF) * inv255;
            }

            ensureLoaded(context);

            long[] shape = new long[]{1, 3, INPUT_SIZE, INPUT_SIZE};
            float[][][][] heatmaps;
            synchronized (LOCK) {
                try (OnnxTensor inputTensor = OnnxTensor.createTensor(env, FloatBuffer.wrap(chw), shape);
                     OrtSession.Result result = session.run(Collections.singletonMap("img", inputTensor))) {
                    heatmaps = (float[][][][]) result.get(0).getValue();
                }
            }

            if (heatmaps == null || heatmaps.length == 0 || heatmaps[0].length < 4) return "";

            float[] cx = new float[4];
            float[] cy = new float[4];
            float minConf = 1.0f;
            float sumConf = 0.0f;

            for (int c = 0; c < 4; c++) {
                float[][] map = heatmaps[0][c];
                float maxVal = 0.0f;
                for (int y = 0; y < HEATMAP_SIZE; y++) {
                    float[] row = map[y];
                    for (int x = 0; x < HEATMAP_SIZE; x++) {
                        if (row[x] > maxVal) maxVal = row[x];
                    }
                }
                if (maxVal < 0.22f) return "";
                if (maxVal < minConf) minConf = maxVal;
                sumConf += maxVal;

                float thresh = Math.max(0.20f, maxVal * 0.50f);
                double wx = 0.0, wy = 0.0, wSum = 0.0;
                for (int y = 0; y < HEATMAP_SIZE; y++) {
                    float[] row = map[y];
                    for (int x = 0; x < HEATMAP_SIZE; x++) {
                        float v = row[x];
                        if (v >= thresh) {
                            double wt = v;
                            wx += (x + 0.5) * wt;
                            wy += (y + 0.5) * wt;
                            wSum += wt;
                        }
                    }
                }
                if (wSum <= 0.0) return "";
                cx[c] = clamp01((float) (wx / wSum) / HEATMAP_SIZE);
                cy[c] = clamp01((float) (wy / wSum) / HEATMAP_SIZE);
            }

            // Order corners consistently: TL, TR, BR, BL by sum/diff
            float tlX = cx[0], tlY = cy[0];
            float trX = cx[1], trY = cy[1];
            float brX = cx[2], brY = cy[2];
            float blX = cx[3], blY = cy[3];

            // Reject degenerate quads
            double area = 0.5 * Math.abs(
                tlX * trY - trX * tlY +
                trX * brY - brX * trY +
                brX * blY - blX * brY +
                blX * tlY - tlX * blY
            );
            if (area < 0.04 || area > 0.96) return "";

            float confidence = Math.min(0.99f, minConf * 0.55f + (sumConf / 4.0f) * 0.45f);
            JSONObject out = new JSONObject();
            out.put("tlX", tlX);
            out.put("tlY", tlY);
            out.put("trX", trX);
            out.put("trY", trY);
            out.put("brX", brX);
            out.put("brY", brY);
            out.put("blX", blX);
            out.put("blY", blY);
            out.put("confidence", confidence);
            return out.toString();
        } catch (Throwable t) {
            return "";
        }
    }

    private static float clamp01(float v) {
        return Math.max(0.005f, Math.min(0.995f, v));
    }
}
