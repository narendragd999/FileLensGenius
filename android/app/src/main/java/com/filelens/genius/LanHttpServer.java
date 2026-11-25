package com.filelens.genius;

import android.webkit.MimeTypeMap;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public class LanHttpServer {
    private ServerSocket serverSocket;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final List<File> roots;
    private int boundPort = 8088;

    public LanHttpServer(List<File> roots) {
        this.roots = roots;
    }

    public synchronized String start() {
        if (running.get()) {
            return getServerUrl();
        }
        try {
            try {
                serverSocket = new ServerSocket(8088);
                boundPort = 8088;
            } catch (Exception e) {
                serverSocket = new ServerSocket(0);
                boundPort = serverSocket.getLocalPort();
            }
            running.set(true);
            pool.execute(() -> {
                while (running.get() && serverSocket != null && !serverSocket.isClosed()) {
                    try {
                        Socket client = serverSocket.accept();
                        pool.execute(() -> handleClient(client));
                    } catch (Exception ignored) {
                    }
                }
            });
            return getServerUrl();
        } catch (Exception e) {
            running.set(false);
            return "";
        }
    }

    public synchronized void stop() {
        running.set(false);
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (Exception ignored) {
        }
        serverSocket = null;
    }

    public boolean isRunning() {
        return running.get();
    }

    public String getServerUrl() {
        if (!running.get()) return "";
        String ip = getLocalIpAddress();
        return "http://" + ip + ":" + boundPort;
    }

    private String getLocalIpAddress() {
        try {
            for (NetworkInterface intf : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                for (InetAddress addr : Collections.list(intf.getInetAddresses())) {
                    if (!addr.isLoopbackAddress() && addr instanceof Inet4Address) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return "127.0.0.1";
    }

    private void handleClient(Socket socket) {
        try (Socket s = socket;
             BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream()));
             OutputStream out = s.getOutputStream()) {
            String requestLine = in.readLine();
            if (requestLine == null || requestLine.isEmpty()) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String rawTarget = parts[1];

            String pathOnly = rawTarget;
            String query = "";
            int qIdx = rawTarget.indexOf('?');
            if (qIdx >= 0) {
                pathOnly = rawTarget.substring(0, qIdx);
                query = rawTarget.substring(qIdx + 1);
            }

            String targetPath = extractParam(query, "path");
            if ("/download".equals(pathOnly) || "/view".equals(pathOnly)) {
                serveFile(out, targetPath, "/download".equals(pathOnly));
            } else {
                serveDirectoryHtml(out, targetPath);
            }
        } catch (Exception ignored) {
        }
    }

    private String extractParam(String query, String key) {
        if (query == null || query.isEmpty()) return "";
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq > 0 && pair.substring(0, eq).equals(key)) {
                try {
                    return URLDecoder.decode(pair.substring(eq + 1), "UTF-8");
                } catch (Exception e) {
                    return "";
                }
            }
        }
        return "";
    }

    private void serveDirectoryHtml(OutputStream out, String dirPath) throws Exception {
        StringBuilder html = new StringBuilder();
        html.append("<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>")
            .append("<title>FileLens PC Explorer</title>")
            .append("<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#f8fafc;margin:0;padding:24px}")
            .append("h1{font-size:20px;margin:0 0 12px;color:#fb923c}a{color:#38bdf8;text-decoration:none}")
            .append(".card{background:#1e293b;border-radius:12px;padding:12px 16px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center}")
            .append(".meta{font-size:12px;color:#94a3b8}</style></head><body>")
            .append("<h1>FileLens LAN Explorer</h1>");

        if (dirPath == null || dirPath.isEmpty()) {
            html.append("<p class='meta'>Select a storage volume:</p>");
            for (File r : roots) {
                String enc = URLEncoder.encode(r.getAbsolutePath(), "UTF-8");
                html.append("<div class='card'><a href='/?path=").append(enc).append("'>📁 ")
                    .append(escapeHtml(r.getAbsolutePath())).append("</a><span class='meta'>Volume</span></div>");
            }
        } else {
            File dir = new File(dirPath);
            File parent = dir.getParentFile();
            if (parent != null && parent.canRead()) {
                html.append("<div class='card'><a href='/?path=").append(URLEncoder.encode(parent.getAbsolutePath(), "UTF-8"))
                    .append("'>⬅ Parent Folder</a><span class='meta'>Up</span></div>");
            } else {
                html.append("<div class='card'><a href='/'>🏠 All Volumes</a><span class='meta'>Root</span></div>");
            }
            File[] children = dir.listFiles();
            if (children != null) {
                for (File f : children) {
                    String enc = URLEncoder.encode(f.getAbsolutePath(), "UTF-8");
                    if (f.isDirectory()) {
                        html.append("<div class='card'><a href='/?path=").append(enc).append("'>📁 ")
                            .append(escapeHtml(f.getName())).append("</a><span class='meta'>Folder</span></div>");
                    } else {
                        html.append("<div class='card'><a href='/view?path=").append(enc).append("'>📄 ")
                            .append(escapeHtml(f.getName())).append("</a><div><span class='meta'>")
                            .append(f.length() / 1024).append(" KB</span> &nbsp; <a href='/download?path=")
                            .append(enc).append("'>⬇ Download</a></div></div>");
                    }
                }
            }
        }
        html.append("</body></html>");
        byte[] body = html.toString().getBytes(StandardCharsets.UTF_8);
        String header = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n";
        out.write(header.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    private void serveFile(OutputStream out, String filePath, boolean asAttachment) throws Exception {
        File f = new File(filePath);
        if (!f.exists() || !f.isFile() || !f.canRead()) {
            byte[] msg = "404 Not Found".getBytes(StandardCharsets.UTF_8);
            out.write(("HTTP/1.1 404 Not Found\r\nContent-Length: " + msg.length + "\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            out.write(msg);
            return;
        }
        int dot = f.getName().lastIndexOf('.');
        String ext = dot > 0 ? f.getName().substring(dot + 1).toLowerCase() : "";
        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        if (mime == null) mime = "application/octet-stream";
        String disp = asAttachment ? "attachment; filename=\"" + f.getName().replace("\"", "") + "\"" : "inline";
        String header = "HTTP/1.1 200 OK\r\nContent-Type: " + mime + "\r\nContent-Length: " + f.length() +
            "\r\nContent-Disposition: " + disp + "\r\nConnection: close\r\n\r\n";
        out.write(header.getBytes(StandardCharsets.UTF_8));
        try (BufferedInputStream bis = new BufferedInputStream(new FileInputStream(f))) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = bis.read(buf)) != -1) {
                out.write(buf, 0, n);
            }
        }
        out.flush();
    }

    private String escapeHtml(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }
}
