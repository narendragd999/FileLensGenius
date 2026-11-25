package com.filelens.genius;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.PowerManager;
import android.os.StatFs;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;
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
import java.io.InputStream;
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
    private SpeechRecognizer speechRecognizer = null;
    private String pendingVoiceLang = "en-US";
    private String pendingShareJson = null;

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

                List<File> priorityFiles = new ArrayList<>();
                List<File> otherFiles = new ArrayList<>();
                int foldersScanned = 0;
                final int MAX_FILES = 2500;

                ArrayDeque<File> queue = new ArrayDeque<>(roots);
                while (!queue.isEmpty() && !cancelRequested.get()
                        && (priorityFiles.size() + otherFiles.size()) < MAX_FILES) {
                    File dir = queue.poll();
                    if (dir == null || !dir.isDirectory()) continue;
                    foldersScanned++;

                    if (foldersScanned % 12 == 1) {
                        dispatchProgress(
                            priorityFiles.size() + otherFiles.size(),
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
                                priorityFiles.add(f);
                            } else {
                                otherFiles.add(f);
                            }
                        }
                    }
                }

                priorityFiles.sort((a, b) -> Long.compare(b.lastModified(), a.lastModified()));
                otherFiles.sort((a, b) -> Long.compare(b.lastModified(), a.lastModified()));

                List<File> allFiles = new ArrayList<>(priorityFiles.size() + otherFiles.size());
                allFiles.addAll(priorityFiles);
                allFiles.addAll(otherFiles);

                final int totalFound = Math.min(allFiles.size(), MAX_FILES);
                JSONArray batch = new JSONArray();

                for (int i = 0; i < totalFound; i++) {
                    if (cancelRequested.get()) break;
                    File f = allFiles.get(i);
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
                            dispatchMetaBatchToWebView(batch, sourceLabel, totalFound, i + 1);
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
        public String extractTextWithMlKit(String imageDataUrl, String lang) {
            if (imageDataUrl == null || imageDataUrl.isEmpty()) return "";
            try {
                String b64 = imageDataUrl;
                int comma = b64.indexOf(',');
                if (comma >= 0) b64 = b64.substring(comma + 1);
                byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
                Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (bmp == null) return "";

                InputImage image = InputImage.fromBitmap(bmp, 0);
                boolean useDevanagari = lang != null && (lang.contains("hin") || lang.contains("hi") || lang.contains("dev"));
                TextRecognizer primary = useDevanagari
                    ? TextRecognition.getClient(new DevanagariTextRecognizerOptions.Builder().build())
                    : TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);

                Text result = Tasks.await(primary.process(image), 12, TimeUnit.SECONDS);
                String text = result != null && result.getText() != null ? result.getText().trim() : "";

                if (text.isEmpty() && useDevanagari) {
                    TextRecognizer fallback = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
                    Text fbRes = Tasks.await(fallback.process(image), 8, TimeUnit.SECONDS);
                    if (fbRes != null && fbRes.getText() != null) text = fbRes.getText().trim();
                }
                bmp.recycle();
                return text;
            } catch (Exception e) {
                return "";
            }
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
