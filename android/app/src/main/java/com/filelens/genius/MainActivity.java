package com.filelens.genius;

import android.Manifest;
import android.app.Activity;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.PowerManager;
import android.os.StatFs;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;
import android.provider.AlarmClock;
import android.provider.CalendarContract;
import android.provider.MediaStore;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.WebView;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.BridgeActivity;
import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanner;
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.devanagari.DevanagariTextRecognizerOptions;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends BridgeActivity {

    private final ExecutorService indexExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService scanExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean cancelRequested = new AtomicBoolean(false);
    private final AtomicBoolean isCrawling = new AtomicBoolean(false);
    private final FileLensAndroidBridge androidBridge = new FileLensAndroidBridge();
    private boolean bridgeAttached = false;
    private LanHttpServer lanServer = null;
    private LanFtpServer ftpServer = null;
    private SpeechRecognizer speechRecognizer = null;
    private String pendingVoiceLang = "en-US";
    private String pendingShareJson = null;
    private volatile boolean bgServiceActive = false;
    private TextRecognizer latinRecognizer = null;
    private TextRecognizer devanagariRecognizer = null;

    private synchronized TextRecognizer getLatinRecognizer() {
        if (latinRecognizer == null) {
            latinRecognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
        }
        return latinRecognizer;
    }

    private synchronized TextRecognizer getDevanagariRecognizer() {
        if (devanagariRecognizer == null) {
            devanagariRecognizer = TextRecognition.getClient(new DevanagariTextRecognizerOptions.Builder().build());
        }
        return devanagariRecognizer;
    }

    private final ActivityResultLauncher<IntentSenderRequest> docScannerLauncher =
        registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), result -> {
            if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
                GmsDocumentScanningResult scanResult =
                    GmsDocumentScanningResult.fromActivityResultIntent(result.getData());
                if (scanResult != null && scanResult.getPages() != null && !scanResult.getPages().isEmpty()) {
                    List<GmsDocumentScanningResult.Page> pages = scanResult.getPages();
                    scanExecutor.execute(() -> {
                        JSONArray arr = new JSONArray();
                        for (GmsDocumentScanningResult.Page p : pages) {
                            try (InputStream is = getContentResolver().openInputStream(p.getImageUri());
                                 ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
                                if (is == null) continue;
                                byte[] buf = new byte[16384];
                                int n;
                                while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
                                String dataUrl = "data:image/jpeg;base64," +
                                    Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
                                arr.put(dataUrl);
                            } catch (Exception ignored) {
                            }
                        }
                        final String jsonArr = arr.toString();
                        runOnUiThread(() -> {
                            if (getBridge() == null || getBridge().getWebView() == null) return;
                            getBridge().getWebView().evaluateJavascript(
                                "window.dispatchEvent(new CustomEvent('filelens-google-scan-result',{detail:{pages:" + jsonArr + "}}));",
                                null
                            );
                        });
                    });
                    return;
                }
            }
            runOnUiThread(() -> {
                if (getBridge() == null || getBridge().getWebView() == null) return;
                getBridge().getWebView().evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('filelens-google-scan-result',{detail:{pages:[],cancelled:true}}));",
                    null
                );
            });
        });

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        attachJsBridge();
        handleIncomingShareIntent(getIntent());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1003);
            }
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.CAMERA}, 1004);
        }
    }

    @Override
    public void onDestroy() {
        try {
            if (lanServer != null) lanServer.stop();
        } catch (Exception ignored) {}
        try {
            if (ftpServer != null) ftpServer.stop();
        } catch (Exception ignored) {}
        try {
            if (speechRecognizer != null) speechRecognizer.destroy();
        } catch (Exception ignored) {}
        try {
            if (latinRecognizer != null) latinRecognizer.close();
        } catch (Exception ignored) {}
        try {
            if (devanagariRecognizer != null) devanagariRecognizer.close();
        } catch (Exception ignored) {}
        indexExecutor.shutdownNow();
        scanExecutor.shutdownNow();
        super.onDestroy();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingShareIntent(intent);
    }

    private void handleIncomingShareIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
        try {
            JSONObject payload = new JSONObject();
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (text != null && !text.trim().isEmpty()) payload.put("text", text);
            JSONArray filesArr = new JSONArray();
            if (Intent.ACTION_SEND.equals(action)) {
                Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (uri != null) {
                    JSONObject item = readShareUri(uri);
                    if (item != null) filesArr.put(item);
                }
            } else {
                ArrayList<Uri> uris = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (uris != null) {
                    for (Uri u : uris) {
                        JSONObject item = readShareUri(u);
                        if (item != null) filesArr.put(item);
                    }
                }
            }
            payload.put("files", filesArr);
            if (payload.has("text") || filesArr.length() > 0) {
                pendingShareJson = payload.toString();
                if (getBridge() != null && getBridge().getWebView() != null) {
                    final String safeJson = JSONObject.quote(pendingShareJson);
                    getBridge().getWebView().post(() ->
                        getBridge().getWebView().evaluateJavascript(
                            "window.dispatchEvent(new CustomEvent('filelens-share-intent',{detail:JSON.parse(" + safeJson + ")}));",
                            null
                        )
                    );
                }
            }
        } catch (Exception ignored) {
        }
    }

    private JSONObject readShareUri(Uri uri) {
        try (InputStream is = getContentResolver().openInputStream(uri);
             ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
            if (is == null) return null;
            byte[] buf = new byte[16384];
            int n;
            int total = 0;
            while ((n = is.read(buf)) != -1 && total < 16 * 1024 * 1024) {
                bos.write(buf, 0, n);
                total += n;
            }
            String mime = getContentResolver().getType(uri);
            if (mime == null) mime = "application/octet-stream";
            String name = uri.getLastPathSegment();
            if (name == null || name.trim().isEmpty()) name = "shared_file";
            JSONObject obj = new JSONObject();
            obj.put("name", name);
            obj.put("mime", mime);
            obj.put("base64", Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP));
            return obj;
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    public void onStart() {
        super.onStart();
        attachJsBridge();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == 1002 && grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            androidBridge.startVoiceCapture(pendingVoiceLang);
        }
    }

    private void attachJsBridge() {
        if (getBridge() != null && getBridge().getWebView() != null) {
            WebView wv = getBridge().getWebView();
            if (!bridgeAttached) {
                wv.addJavascriptInterface(androidBridge, "FileLensAndroid");
                bridgeAttached = true;
            }
            wv.post(() -> wv.evaluateJavascript(
                "window.dispatchEvent(new Event('filelens-android-ready'));",
                null
            ));
        }
    }

    public class FileLensAndroidBridge {

        private final Set<String> SKIP_DIRS = new HashSet<>(Arrays.asList(
            "android", ".thumbnails", ".trash", "cache", "caches", "lost.dir",
            "node_modules", ".git", ".gradle", "temp", "tmp"
        ));

        private final Set<String> DOC_OR_IMAGE_EXTS = new HashSet<>(Arrays.asList(
            "pdf", "jpg", "jpeg", "png", "webp", "bmp", "gif", "heic",
            "txt", "md", "csv", "tsv", "json", "xml", "yaml", "yml", "log", "html", "htm", "rtf",
            "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "epub"
        ));

        @JavascriptInterface
        public boolean hasAllFilesAccess() {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                return Environment.isExternalStorageManager();
            }
            return ContextCompat.checkSelfPermission(
                MainActivity.this,
                Manifest.permission.READ_EXTERNAL_STORAGE
            ) == PackageManager.PERMISSION_GRANTED;
        }

        @JavascriptInterface
        public boolean requestAllFilesAccess() {
            if (hasAllFilesAccess()) return true;
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    try {
                        Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                        intent.setData(Uri.parse("package:" + getPackageName()));
                        startActivity(intent);
                    } catch (Exception e) {
                        startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
                    }
                } else {
                    ActivityCompat.requestPermissions(
                        MainActivity.this,
                        new String[]{Manifest.permission.READ_EXTERNAL_STORAGE},
                        1001
                    );
                }
            });
            return true;
        }

        @JavascriptInterface
        public int getAndroidApiLevel() {
            return Build.VERSION.SDK_INT;
        }

        @JavascriptInterface
        public String getStorageRootPath() {
            return Environment.getExternalStorageDirectory().getAbsolutePath();
        }

        @JavascriptInterface
        public void cancelDeviceIndex() {
            cancelRequested.set(true);
        }

        @JavascriptInterface
        public String getDeviceStorageStats() {
            try {
                List<File> roots = discoverAllStorageRoots();
                long total = 0;
                long free = 0;
                JSONArray vols = new JSONArray();
                for (File r : roots) {
                    try {
                        StatFs sf = new StatFs(r.getAbsolutePath());
                        long vt = sf.getTotalBytes();
                        long vf = sf.getAvailableBytes();
                        total += vt;
                        free += vf;
                        JSONObject vo = new JSONObject();
                        vo.put("name", r.getAbsolutePath().contains("emulated") ? "Internal Storage" : "SD Card (" + r.getName() + ")");
                        vo.put("path", r.getAbsolutePath());
                        vo.put("totalBytes", vt);
                        vo.put("freeBytes", vf);
                        vols.put(vo);
                    } catch (Exception ignored) {
                    }
                }
                JSONObject res = new JSONObject();
                res.put("totalBytes", total);
                res.put("freeBytes", free);
                res.put("usedBytes", Math.max(0, total - free));
                res.put("volumes", vols);
                return res.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public String listDirectory(String path) {
            try {
                if (path == null || path.isEmpty()) {
                    JSONArray arr = new JSONArray();
                    for (File r : discoverAllStorageRoots()) {
                        JSONObject o = new JSONObject();
                        o.put("name", r.getAbsolutePath().contains("emulated") ? "Internal Storage" : "SD Card (" + r.getName() + ")");
                        o.put("path", r.getAbsolutePath());
                        o.put("isDirectory", true);
                        o.put("size", 0);
                        o.put("lastModified", r.lastModified());
                        arr.put(o);
                    }
                    return arr.toString();
                }
                File dir = new File(path);
                if (!dir.exists() || !dir.isDirectory()) return "[]";
                File[] children = dir.listFiles();
                if (children == null) return "[]";
                Arrays.sort(children, (a, b) -> {
                    if (a.isDirectory() != b.isDirectory()) return a.isDirectory() ? -1 : 1;
                    return a.getName().compareToIgnoreCase(b.getName());
                });
                JSONArray arr = new JSONArray();
                for (File f : children) {
                    if (f.getName().startsWith(".")) continue;
                    JSONObject o = new JSONObject();
                    o.put("name", f.getName());
                    o.put("path", f.getAbsolutePath());
                    o.put("isDirectory", f.isDirectory());
                    o.put("size", f.isDirectory() ? 0 : f.length());
                    o.put("lastModified", f.lastModified());
                    arr.put(o);
                }
                return arr.toString();
            } catch (Exception e) {
                return "[]";
            }
        }

        @JavascriptInterface
        public boolean createFolder(String path) {
            try {
                return new File(path).mkdirs();
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean renameFile(String path, String newName) {
            try {
                File f = new File(path);
                File target = new File(f.getParentFile(), newName);
                return f.renameTo(target);
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean deleteNativeFile(String path) {
            try {
                return new File(path).delete();
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public String startLanServer() {
            if (lanServer == null) {
                lanServer = new LanHttpServer(discoverAllStorageRoots());
            }
            return lanServer.start();
        }

        @JavascriptInterface
        public void stopLanServer() {
            if (lanServer != null) {
                lanServer.stop();
            }
        }

        @JavascriptInterface
        public String getLanServerUrl() {
            return lanServer != null ? lanServer.getServerUrl() : "";
        }

        @JavascriptInterface
        public boolean startVoiceCapture(String langCode) {
            pendingVoiceLang = (langCode != null && !langCode.isEmpty()) ? langCode : "en-US";
            if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.RECORD_AUDIO)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(
                    MainActivity.this,
                    new String[]{Manifest.permission.RECORD_AUDIO},
                    1002
                );
                return false;
            }
            runOnUiThread(() -> {
                try {
                    if (speechRecognizer != null) {
                        speechRecognizer.destroy();
                        speechRecognizer = null;
                    }
                    speechRecognizer = SpeechRecognizer.createSpeechRecognizer(MainActivity.this);
                    speechRecognizer.setRecognitionListener(new RecognitionListener() {
                        @Override public void onReadyForSpeech(Bundle params) {}
                        @Override public void onBeginningOfSpeech() {}
                        @Override public void onRmsChanged(float rmsdB) {}
                        @Override public void onBufferReceived(byte[] buffer) {}
                        @Override public void onEvent(int eventType, Bundle params) {}

                        @Override
                        public void onPartialResults(Bundle partialResults) {
                            ArrayList<String> list = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                            if (list != null && !list.isEmpty()) {
                                dispatchVoiceEvent("filelens-voice-partial", list.get(0));
                            }
                        }

                        @Override
                        public void onResults(Bundle results) {
                            ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                            if (list != null && !list.isEmpty()) {
                                dispatchVoiceEvent("filelens-voice-result", list.get(0));
                            }
                            dispatchVoiceEvent("filelens-voice-end", "");
                        }

                        @Override
                        public void onError(int error) {
                            dispatchVoiceEvent("filelens-voice-error", String.valueOf(error));
                            dispatchVoiceEvent("filelens-voice-end", "");
                        }

                        @Override
                        public void onEndOfSpeech() {}
                    });

                    Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                    intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                    intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, pendingVoiceLang);
                    intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                    intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
                    speechRecognizer.startListening(intent);
                } catch (Exception e) {
                    dispatchVoiceEvent("filelens-voice-error", "unavailable");
                    dispatchVoiceEvent("filelens-voice-end", "");
                }
            });
            return true;
        }

        @JavascriptInterface
        public void stopVoiceCapture() {
            runOnUiThread(() -> {
                try {
                    if (speechRecognizer != null) {
                        speechRecognizer.stopListening();
                    }
                } catch (Exception ignored) {
                }
            });
        }

        private void dispatchVoiceEvent(String eventName, String text) {
            final String safeText = JSONObject.quote(text != null ? text : "");
            runOnUiThread(() -> {
                if (getBridge() == null || getBridge().getWebView() == null) return;
                String js = "window.dispatchEvent(new CustomEvent('" + eventName + "',{detail:{text:" + safeText + "}}));";
                getBridge().getWebView().evaluateJavascript(js, null);
            });
        }

        @JavascriptInterface
        public String readFileBase64(String path) {
            if (path == null || path.isEmpty()) return "";
            try {
                File f = new File(path);
                if (!f.exists() || !f.isFile() || !f.canRead() || f.length() > 12L * 1024L * 1024L) {
                    return "";
                }
                return readFileToBase64(f);
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public boolean startDeviceIndex(String filtersJson) {
            if (!hasAllFilesAccess()) {
                requestAllFilesAccess();
                return false;
            }
            if (isCrawling.get()) return true;
            cancelRequested.set(false);
            indexExecutor.execute(this::crawlAllVolumesAndDispatch);
            return true;
        }

        private List<File> discoverAllStorageRoots() {
            Set<String> seenCanonical = new LinkedHashSet<>();
            List<File> roots = new ArrayList<>();

            // 1. Primary Internal Storage (/storage/emulated/0)
            File primary = Environment.getExternalStorageDirectory();
            addRootIfValid(primary, seenCanonical, roots);

            // 2. All StorageVolumes (Internal + SD Card + USB OTG) via StorageManager
            try {
                StorageManager sm = (StorageManager) getSystemService(Context.STORAGE_SERVICE);
                if (sm != null) {
                    for (StorageVolume vol : sm.getStorageVolumes()) {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                            File dir = vol.getDirectory();
                            addRootIfValid(dir, seenCanonical, roots);
                        }
                    }
                }
            } catch (Exception ignored) {
            }

            // 3. Fallback via getExternalFilesDirs(null) -> strip /Android/data/<pkg>/files
            try {
                File[] extDirs = getExternalFilesDirs(null);
                if (extDirs != null) {
                    for (File d : extDirs) {
                        if (d == null) continue;
                        String path = d.getAbsolutePath();
                        int idx = path.indexOf("/Android/");
                        if (idx > 0) {
                            addRootIfValid(new File(path.substring(0, idx)), seenCanonical, roots);
                        }
                    }
                }
            } catch (Exception ignored) {
            }

            // 4. Fallback scan /storage/* for any mounted SD card UUIDs
            try {
                File storageDir = new File("/storage");
                File[] children = storageDir.listFiles();
                if (children != null) {
                    for (File child : children) {
                        String n = child.getName();
                        if ("emulated".equals(n) || "self".equals(n)) continue;
                        addRootIfValid(child, seenCanonical, roots);
                    }
                }
            } catch (Exception ignored) {
            }

            return roots;
        }

        private void addRootIfValid(File dir, Set<String> seenCanonical, List<File> roots) {
            if (dir == null || !dir.exists() || !dir.isDirectory() || !dir.canRead()) return;
            try {
                String canon = dir.getCanonicalPath();
                if (!seenCanonical.contains(canon)) {
                    seenCanonical.add(canon);
                    roots.add(dir);
                }
            } catch (Exception ignored) {
            }
        }

        private void crawlAllVolumesAndDispatch() {
            isCrawling.set(true);
            try {
                List<File> roots = discoverAllStorageRoots();
                String sourceLabel = roots.size() > 1
                    ? "Internal & SD Card (" + roots.size() + " volumes)"
                    : "Internal Device Storage";

                List<File> otherFiles = new ArrayList<>();
                JSONArray liveBatch = new JSONArray();
                int priorityCount = 0;
                int foldersScanned = 0;
                final int MAX_FILES = 10000;

                ArrayDeque<File> queue = new ArrayDeque<>(roots);
                while (!queue.isEmpty() && !cancelRequested.get()
                        && (priorityCount + otherFiles.size()) < MAX_FILES) {
                    File dir = queue.poll();
                    if (dir == null || !dir.isDirectory()) continue;
                    foldersScanned++;

                    if (foldersScanned % 12 == 1) {
                        dispatchProgress(
                            priorityCount + otherFiles.size(),
                            foldersScanned,
                            dir.getAbsolutePath()
                        );
                    }

                    File[] children = dir.listFiles();
                    if (children == null) continue;

                    for (File f : children) {
                        if (cancelRequested.get()) break;
                        String name = f.getName();
                        if (name.startsWith(".")) continue;

                        if (f.isDirectory()) {
                            if (!SKIP_DIRS.contains(name.toLowerCase())) {
                                queue.add(f);
                            }
                        } else if (f.isFile() && f.length() > 0) {
                            int dot = name.lastIndexOf('.');
                            String ext = dot > 0 ? name.substring(dot + 1).toLowerCase() : "";
                            if (DOC_OR_IMAGE_EXTS.contains(ext)) {
                                priorityCount++;
                                try {
                                    String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
                                    if (mime == null) mime = "application/octet-stream";
                                    JSONObject obj = new JSONObject();
                                    obj.put("name", name);
                                    obj.put("path", f.getAbsolutePath());
                                    obj.put("size", f.length());
                                    obj.put("mime", mime);
                                    obj.put("lastModified", f.lastModified());
                                    liveBatch.put(obj);
                                    if (liveBatch.length() >= 20) {
                                        dispatchMetaBatchToWebView(liveBatch, sourceLabel, priorityCount + otherFiles.size(), priorityCount);
                                        liveBatch = new JSONArray();
                                    }
                                } catch (Exception ignored) {
                                }
                            } else {
                                otherFiles.add(f);
                            }
                        }
                    }
                }

                if (liveBatch.length() > 0 && !cancelRequested.get()) {
                    dispatchMetaBatchToWebView(liveBatch, sourceLabel, priorityCount + otherFiles.size(), priorityCount);
                }

                otherFiles.sort((a, b) -> Long.compare(b.lastModified(), a.lastModified()));
                final int totalFound = Math.min(priorityCount + otherFiles.size(), MAX_FILES);
                final int remainingCap = Math.max(0, MAX_FILES - priorityCount);
                final int otherCount = Math.min(otherFiles.size(), remainingCap);
                JSONArray batch = new JSONArray();

                for (int i = 0; i < otherCount; i++) {
                    if (cancelRequested.get()) break;
                    File f = otherFiles.get(i);
                    try {
                        String name = f.getName();
                        int dot = name.lastIndexOf('.');
                        String ext = dot > 0 ? name.substring(dot + 1).toLowerCase() : "";
                        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
                        if (mime == null) mime = "application/octet-stream";

                        JSONObject obj = new JSONObject();
                        obj.put("name", name);
                        obj.put("path", f.getAbsolutePath());
                        obj.put("size", f.length());
                        obj.put("mime", mime);
                        obj.put("lastModified", f.lastModified());
                        batch.put(obj);

                        if (batch.length() >= 20) {
                            dispatchMetaBatchToWebView(batch, sourceLabel, totalFound, priorityCount + i + 1);
                            batch = new JSONArray();
                        }
                    } catch (Exception ignored) {
                    }
                }

                if (batch.length() > 0 && !cancelRequested.get()) {
                    dispatchMetaBatchToWebView(batch, sourceLabel, totalFound, totalFound);
                }
                dispatchComplete(sourceLabel, totalFound, foldersScanned, cancelRequested.get());
            } finally {
                isCrawling.set(false);
            }
        }

        private String readFileToBase64(File f) throws Exception {
            try (FileInputStream fis = new FileInputStream(f);
                 ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = fis.read(buf)) != -1) {
                    bos.write(buf, 0, n);
                }
                return Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
            }
        }

        private void dispatchProgress(int found, int folders, String currentFolder) {
            final String safeFolder = JSONObject.quote(currentFolder);
            runOnUiThread(() -> {
                if (getBridge() == null || getBridge().getWebView() == null) return;
                String js = "window.dispatchEvent(new CustomEvent('filelens-android-progress',{detail:{found:" +
                    found + ",folders:" + folders + ",currentFolder:" + safeFolder + "}}));";
                getBridge().getWebView().evaluateJavascript(js, null);
            });
        }

        private void dispatchMetaBatchToWebView(JSONArray batch, String sourceLabel, int totalFound, int sentCount) {
            final String jsonStr = batch.toString();
            final String safeLabel = JSONObject.quote(sourceLabel);
            runOnUiThread(() -> {
                if (getBridge() == null || getBridge().getWebView() == null) return;
                String js = "window.dispatchEvent(new CustomEvent('filelens-android-files-meta',{detail:{items:" +
                    jsonStr + ",sourceLabel:" + safeLabel + ",totalFound:" + totalFound + ",sentCount:" + sentCount + "}}));";
                getBridge().getWebView().evaluateJavascript(js, null);
            });
        }

        @JavascriptInterface
        public String consumePendingShareIntent() {
            String out = pendingShareJson;
            pendingShareJson = null;
            return out != null ? out : "";
        }

        @JavascriptInterface
        public boolean launchGoogleDocScanner(String mode) {
            try {
                int pageLimit = "single".equals(mode) ? 1 : "id_2in1".equals(mode) ? 2 : 50;
                GmsDocumentScannerOptions options = new GmsDocumentScannerOptions.Builder()
                    .setGalleryImportAllowed(true)
                    .setPageLimit(pageLimit)
                    .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_JPEG)
                    .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
                    .build();
                GmsDocumentScanner scanner = GmsDocumentScanning.getClient(options);
                scanner.getStartScanIntent(MainActivity.this)
                    .addOnSuccessListener(intentSender ->
                        docScannerLauncher.launch(new IntentSenderRequest.Builder(intentSender).build())
                    )
                    .addOnFailureListener(e -> runOnUiThread(() -> {
                        if (getBridge() != null && getBridge().getWebView() != null) {
                            getBridge().getWebView().evaluateJavascript(
                                "window.dispatchEvent(new CustomEvent('filelens-google-scan-result',{detail:{pages:[],error:" +
                                    JSONObject.quote(e.getMessage() != null ? e.getMessage() : "Scanner unavailable") + "}}));",
                                null
                            );
                        }
                    }));
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public void extractTextWithMlKitAsync(String requestId, String imageDataUrl, String lang) {
            if (imageDataUrl == null || imageDataUrl.isEmpty()) {
                dispatchMlKitOcrResult(requestId, "");
                return;
            }
            scanExecutor.execute(() -> {
                try {
                    String b64 = imageDataUrl;
                    int comma = b64.indexOf(',');
                    if (comma >= 0) b64 = b64.substring(comma + 1);
                    byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
                    Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                    if (bmp == null) {
                        dispatchMlKitOcrResult(requestId, "");
                        return;
                    }
                    InputImage image = InputImage.fromBitmap(bmp, 0);
                    boolean useDevanagari = lang != null && (lang.contains("hin") || lang.contains("hi") || lang.contains("dev"));
                    TextRecognizer primary = useDevanagari
                        ? getDevanagariRecognizer()
                        : getLatinRecognizer();

                    primary.process(image)
                        .addOnSuccessListener(result -> {
                            String text = result != null && result.getText() != null ? result.getText().trim() : "";
                            if (text.isEmpty() && useDevanagari) {
                                getLatinRecognizer().process(image)
                                    .addOnSuccessListener(fb -> {
                                        bmp.recycle();
                                        dispatchMlKitOcrResult(requestId, fb != null && fb.getText() != null ? fb.getText().trim() : "");
                                    })
                                    .addOnFailureListener(e -> {
                                        bmp.recycle();
                                        dispatchMlKitOcrResult(requestId, "");
                                    });
                            } else {
                                bmp.recycle();
                                dispatchMlKitOcrResult(requestId, text);
                            }
                        })
                        .addOnFailureListener(e -> {
                            if (useDevanagari) {
                                getLatinRecognizer().process(image)
                                    .addOnSuccessListener(fb -> {
                                        bmp.recycle();
                                        dispatchMlKitOcrResult(requestId, fb != null && fb.getText() != null ? fb.getText().trim() : "");
                                    })
                                    .addOnFailureListener(e2 -> {
                                        bmp.recycle();
                                        dispatchMlKitOcrResult(requestId, "");
                                    });
                            } else {
                                bmp.recycle();
                                dispatchMlKitOcrResult(requestId, "");
                            }
                        });
                } catch (Exception e) {
                    dispatchMlKitOcrResult(requestId, "");
                }
            });
        }

        private void dispatchMlKitOcrResult(String requestId, String text) {
            final String safeId = JSONObject.quote(requestId != null ? requestId : "");
            final String safeText = JSONObject.quote(text != null ? text : "");
            runOnUiThread(() -> {
                if (getBridge() == null || getBridge().getWebView() == null) return;
                getBridge().getWebView().evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('filelens-mlkit-ocr-result',{detail:{requestId:" +
                        safeId + ",text:" + safeText + "}}));",
                    null
                );
            });
        }

        @JavascriptInterface
        public void rectifyQuadNativeAsync(
            String requestId,
            String imageDataUrl,
            float tlX, float tlY,
            float trX, float trY,
            float brX, float brY,
            float blX, float blY,
            int rotation,
            int maxDim
        ) {
            scanExecutor.execute(() -> {
                String outDataUrl = "";
                try {
                    String b64 = imageDataUrl;
                    int comma = b64.indexOf(',');
                    if (comma >= 0) b64 = b64.substring(comma + 1);
                    byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
                    Bitmap src = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                    if (src != null) {
                        int sw = src.getWidth();
                        int sh = src.getHeight();
                        float[] srcPts = new float[]{
                            tlX * sw, tlY * sh,
                            trX * sw, trY * sh,
                            brX * sw, brY * sh,
                            blX * sw, blY * sh
                        };
                        double topW = Math.hypot((trX - tlX) * sw, (trY - tlY) * sh);
                        double botW = Math.hypot((brX - blX) * sw, (brY - blY) * sh);
                        double leftH = Math.hypot((blX - tlX) * sw, (blY - tlY) * sh);
                        double rightH = Math.hypot((brX - trX) * sw, (brY - trY) * sh);
                        double avgW = (topW + botW) * 0.5;
                        double avgH = Math.max(1.0, (leftH + rightH) * 0.5);
                        double aspect = Math.max(0.45, Math.min(2.2, avgW / avgH));
                        int baseW = Math.min(maxDim > 0 ? maxDim : 2400, Math.max(700, (int) Math.round(Math.max(topW, botW))));
                        int tw = aspect >= 1.0 ? baseW : Math.max(1, (int) Math.round(baseW * aspect));
                        int th = aspect >= 1.0 ? Math.max(1, (int) Math.round(baseW / aspect)) : baseW;

                        float[] dstPts = new float[]{
                            0f, 0f,
                            (float) tw, 0f,
                            (float) tw, (float) th,
                            0f, (float) th
                        };
                        Matrix polyMatrix = new Matrix();
                        polyMatrix.setPolyToPoly(srcPts, 0, dstPts, 0, 4);

                        Bitmap warped = Bitmap.createBitmap(tw, th, Bitmap.Config.ARGB_8888);
                        Canvas c = new Canvas(warped);
                        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
                        ColorMatrix cm = new ColorMatrix(new float[]{
                            1.06f, 0f, 0f, 0f, -6f,
                            0f, 1.06f, 0f, 0f, -6f,
                            0f, 0f, 1.06f, 0f, -6f,
                            0f, 0f, 0f, 1f, 0f
                        });
                        p.setColorFilter(new ColorMatrixColorFilter(cm));
                        c.drawBitmap(src, polyMatrix, p);
                        src.recycle();

                        Bitmap finalBmp = warped;
                        if (rotation == 90 || rotation == 180 || rotation == 270) {
                            Matrix rm = new Matrix();
                            rm.postRotate((float) rotation);
                            finalBmp = Bitmap.createBitmap(warped, 0, 0, tw, th, rm, true);
                            warped.recycle();
                        }

                        ByteArrayOutputStream bos = new ByteArrayOutputStream();
                        finalBmp.compress(Bitmap.CompressFormat.JPEG, 94, bos);
                        finalBmp.recycle();
                        outDataUrl = "data:image/jpeg;base64," + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
                    }
                } catch (Exception ignored) {
                }
                final String safeId = JSONObject.quote(requestId != null ? requestId : "");
                final String safeUrl = JSONObject.quote(outDataUrl);
                runOnUiThread(() -> {
                    if (getBridge() == null || getBridge().getWebView() == null) return;
                    getBridge().getWebView().evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('filelens-native-rectify-result',{detail:{requestId:" +
                            safeId + ",dataUrl:" + safeUrl + "}}));",
                        null
                    );
                });
            });
        }

        @JavascriptInterface
        public boolean isBatteryOptimizationIgnored() {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
            try {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                return pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
            } catch (Exception e) {
                return true;
            }
        }

        @JavascriptInterface
        public boolean requestIgnoreBatteryOptimizations() {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
            try {
                runOnUiThread(() -> {
                    try {
                        Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                        intent.setData(Uri.parse("package:" + getPackageName()));
                        startActivity(intent);
                    } catch (Exception ignored) {
                    }
                });
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public String startFtpServer() {
            try {
                if (ftpServer == null) {
                    ftpServer = new LanFtpServer(Environment.getExternalStorageDirectory(), 2121);
                }
                return ftpServer.start();
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void stopFtpServer() {
            try {
                if (ftpServer != null) ftpServer.stop();
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public String getFtpServerUrl() {
            return (ftpServer != null && ftpServer.isRunning()) ? ftpServer.getFtpUrl() : "";
        }

        @JavascriptInterface
        public void startBackgroundService(String title, String body, int progress, int max) {
            try {
                bgServiceActive = true;
                Intent svc = new Intent(MainActivity.this, FileLensBackgroundService.class);
                svc.setAction(FileLensBackgroundService.ACTION_START);
                svc.putExtra(FileLensBackgroundService.EXTRA_TITLE, title);
                svc.putExtra(FileLensBackgroundService.EXTRA_BODY, body);
                svc.putExtra(FileLensBackgroundService.EXTRA_PROGRESS, progress);
                svc.putExtra(FileLensBackgroundService.EXTRA_MAX, max);
                ContextCompat.startForegroundService(MainActivity.this, svc);
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void updateBackgroundService(String title, String body, int progress, int max) {
            if (!bgServiceActive) return;
            try {
                Intent svc = new Intent(MainActivity.this, FileLensBackgroundService.class);
                svc.setAction(FileLensBackgroundService.ACTION_UPDATE);
                svc.putExtra(FileLensBackgroundService.EXTRA_TITLE, title);
                svc.putExtra(FileLensBackgroundService.EXTRA_BODY, body);
                svc.putExtra(FileLensBackgroundService.EXTRA_PROGRESS, progress);
                svc.putExtra(FileLensBackgroundService.EXTRA_MAX, max);
                startService(svc);
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void stopBackgroundService() {
            if (!bgServiceActive) return;
            bgServiceActive = false;
            try {
                Intent svc = new Intent(MainActivity.this, FileLensBackgroundService.class);
                svc.setAction(FileLensBackgroundService.ACTION_STOP);
                startService(svc);
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public String saveToPublicDocuments(String fileName, String mimeType, String base64Data) {
            try {
                String b64 = base64Data;
                int comma = b64.indexOf(',');
                if (comma >= 0) b64 = b64.substring(comma + 1);
                byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
                String safeName = (fileName == null || fileName.trim().isEmpty()) ? "FileLens_Export.pdf" : fileName.replaceAll("[\\\\/:*?\"<>|]", "_");

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.DISPLAY_NAME, safeName);
                    values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType != null ? mimeType : "application/octet-stream");
                    values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOCUMENTS + "/FileLensGenius");
                    Uri uri = getContentResolver().insert(MediaStore.Files.getContentUri("external"), values);
                    if (uri != null) {
                        try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                            if (os != null) os.write(bytes);
                        }
                        return "Documents/FileLensGenius/" + safeName;
                    }
                } else {
                    File docsDir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), "FileLensGenius");
                    if (!docsDir.exists()) docsDir.mkdirs();
                    File outFile = new File(docsDir, safeName);
                    try (FileOutputStream fos = new FileOutputStream(outFile)) {
                        fos.write(bytes);
                    }
                    return outFile.getAbsolutePath();
                }
            } catch (Exception ignored) {
            }
            return "";
        }

        @JavascriptInterface
        public boolean openInNativeViewer(String fileName, String mimeType, String base64Data) {
            try {
                String b64 = base64Data;
                int comma = b64.indexOf(',');
                if (comma >= 0) b64 = b64.substring(comma + 1);
                byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
                String safeName = (fileName == null || fileName.trim().isEmpty()) ? "preview.pdf" : fileName.replaceAll("[\\\\/:*?\"<>|]", "_");
                File outFile = new File(getCacheDir(), safeName);
                try (FileOutputStream fos = new FileOutputStream(outFile)) {
                    fos.write(bytes);
                }
                Uri uri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".fileprovider", outFile);
                Intent intent = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, mimeType != null ? mimeType : "application/pdf")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean shareFileViaNativeChooser(String fileName, String mimeType, String base64Data) {
            try {
                String b64 = base64Data;
                int comma = b64.indexOf(',');
                if (comma >= 0) b64 = b64.substring(comma + 1);
                byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
                String safeName = (fileName == null || fileName.trim().isEmpty()) ? "FileLens_Share.pdf" : fileName.replaceAll("[\\\\/:*?\"<>|]", "_");
                File outFile = new File(getCacheDir(), safeName);
                try (FileOutputStream fos = new FileOutputStream(outFile)) {
                    fos.write(bytes);
                }
                Uri uri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".fileprovider", outFile);
                Intent share = new Intent(Intent.ACTION_SEND)
                    .setType(mimeType != null ? mimeType : "application/pdf")
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(Intent.createChooser(share, "Share " + safeName));
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public long clearNativeAppCache() {
            long freed = deleteDirContents(getCacheDir());
            if (getExternalCacheDir() != null) freed += deleteDirContents(getExternalCacheDir());
            return freed;
        }

        private long deleteDirContents(File dir) {
            if (dir == null || !dir.exists()) return 0;
            long total = 0;
            File[] children = dir.listFiles();
            if (children != null) {
                for (File c : children) {
                    if (c.isDirectory()) total += deleteDirContents(c);
                    long len = c.length();
                    if (c.delete()) total += len;
                }
            }
            return total;
        }

        @JavascriptInterface
        public boolean scheduleAutoReminder(String id, long triggerAtMs, String title, String body) {
            try {
                if (triggerAtMs <= System.currentTimeMillis() - 60_000L) return false;
                long fireMs = Math.max(System.currentTimeMillis() + 5_000L, triggerAtMs);
                AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
                if (am == null) return false;

                int reqCode = id != null ? Math.abs(id.hashCode()) : (int) (fireMs & 0x7FFFFFFF);
                Intent intent = new Intent(MainActivity.this, ReminderAlarmReceiver.class);
                intent.putExtra(ReminderAlarmReceiver.EXTRA_TITLE, title != null ? title : "FileLens Reminder");
                intent.putExtra(ReminderAlarmReceiver.EXTRA_BODY, body != null ? body : "Scheduled task");
                intent.putExtra(ReminderAlarmReceiver.EXTRA_NOTIF_ID, reqCode);

                PendingIntent pi = PendingIntent.getBroadcast(
                    MainActivity.this,
                    reqCode,
                    intent,
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                        ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
                        : PendingIntent.FLAG_UPDATE_CURRENT
                );

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    Intent showIntent = new Intent(MainActivity.this, MainActivity.class);
                    PendingIntent showPi = PendingIntent.getActivity(
                        MainActivity.this,
                        reqCode + 100000,
                        showIntent,
                        Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                            ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
                            : PendingIntent.FLAG_UPDATE_CURRENT
                    );
                    am.setAlarmClock(new AlarmManager.AlarmClockInfo(fireMs, showPi), pi);
                } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, fireMs, pi);
                } else {
                    am.setExact(AlarmManager.RTC_WAKEUP, fireMs, pi);
                }
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean setDeviceClockAlarm(int hour, int minute, String label) {
            try {
                Intent intent = new Intent(AlarmClock.ACTION_SET_ALARM)
                    .putExtra(AlarmClock.EXTRA_HOUR, Math.max(0, Math.min(23, hour)))
                    .putExtra(AlarmClock.EXTRA_MINUTES, Math.max(0, Math.min(59, minute)))
                    .putExtra(AlarmClock.EXTRA_MESSAGE, label != null ? label : "FileLens Reminder")
                    .putExtra(AlarmClock.EXTRA_SKIP_UI, false);
                startActivity(intent);
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean openDeviceCalendarEvent(String title, long startEpochMs, String description) {
            try {
                Intent intent = new Intent(Intent.ACTION_INSERT)
                    .setData(CalendarContract.Events.CONTENT_URI)
                    .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, startEpochMs)
                    .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, startEpochMs + 3600_000L)
                    .putExtra(CalendarContract.Events.TITLE, title != null ? title : "FileLens Task")
                    .putExtra(CalendarContract.Events.DESCRIPTION, description != null ? description : "");
                startActivity(intent);
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        private void dispatchComplete(String sourceLabel, int totalFound, int foldersScanned, boolean cancelled) {
            final String safeLabel = JSONObject.quote(sourceLabel);
            runOnUiThread(() -> {
                if (getBridge() == null || getBridge().getWebView() == null) return;
                String js = "window.dispatchEvent(new CustomEvent('filelens-android-complete',{detail:{sourceLabel:" +
                    safeLabel + ",totalFound:" + totalFound + ",foldersScanned:" + foldersScanned + ",cancelled:" + cancelled + "}}));";
                getBridge().getWebView().evaluateJavascript(js, null);
            });
        }
    }
}
