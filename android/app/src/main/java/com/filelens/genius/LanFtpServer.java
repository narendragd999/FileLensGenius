package com.filelens.genius;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Enumeration;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Lightweight RFC 959 Passive-Mode FTP Server (port 2121) for LAN/PC file access.
 */
public class LanFtpServer {

    private final File rootDir;
    private final int port;
    private volatile boolean running = false;
    private ServerSocket serverSocket = null;
    private ExecutorService clientPool = null;
    private Thread acceptThread = null;

    public LanFtpServer(File rootDir, int port) {
        this.rootDir = rootDir;
        this.port = port;
    }

    public synchronized String start() throws IOException {
        if (running && serverSocket != null && !serverSocket.isClosed()) {
            return getFtpUrl();
        }
        serverSocket = new ServerSocket(port);
        running = true;
        clientPool = Executors.newCachedThreadPool();
        acceptThread = new Thread(() -> {
            while (running && serverSocket != null && !serverSocket.isClosed()) {
                try {
                    Socket client = serverSocket.accept();
                    clientPool.execute(new FtpSession(client, rootDir));
                } catch (IOException ignored) {
                    break;
                }
            }
        }, "FileLens-FTP-Accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
        return getFtpUrl();
    }

    public synchronized void stop() {
        running = false;
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (IOException ignored) {
        }
        serverSocket = null;
        if (clientPool != null) clientPool.shutdownNow();
        clientPool = null;
    }

    public boolean isRunning() {
        return running && serverSocket != null && !serverSocket.isClosed();
    }

    public String getFtpUrl() {
        return "ftp://" + getLocalIpAddress() + ":" + port;
    }

    public static String getLocalIpAddress() {
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            while (ifaces.hasMoreElements()) {
                NetworkInterface iface = ifaces.nextElement();
                if (!iface.isUp() || iface.isLoopback()) continue;
                Enumeration<InetAddress> addrs = iface.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress addr = addrs.nextElement();
                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return "127.0.0.1";
    }

    private static class FtpSession implements Runnable {
        private final Socket controlSocket;
        private final File rootDir;
        private File currentDir;
        private ServerSocket passiveServer = null;
        private File renameFrom = null;
        private final SimpleDateFormat lsFmt = new SimpleDateFormat("MMM dd HH:mm", Locale.US);

        FtpSession(Socket socket, File rootDir) {
            this.controlSocket = socket;
            this.rootDir = rootDir;
            this.currentDir = rootDir;
        }

        @Override
        public void run() {
            try (BufferedReader in = new BufferedReader(new InputStreamReader(controlSocket.getInputStream()));
                 PrintWriter out = new PrintWriter(new OutputStreamWriter(controlSocket.getOutputStream()), true)) {

                out.print("220 FileLens Genius FTP Server Ready\r\n");
                out.flush();

                String line;
                while ((line = in.readLine()) != null) {
                    int space = line.indexOf(' ');
                    String cmd = (space > 0 ? line.substring(0, space) : line).toUpperCase(Locale.US).trim();
                    String arg = space > 0 ? line.substring(space + 1).trim() : "";

                    switch (cmd) {
                        case "USER":
                            send(out, "331 Anonymous login ok, send password");
                            break;
                        case "PASS":
                            send(out, "230 User logged in");
                            break;
                        case "SYST":
                            send(out, "215 UNIX Type: L8");
                            break;
                        case "FEAT":
                            send(out, "211-Features:\r\n UTF8\r\n PASV\r\n SIZE\r\n211 End");
                            break;
                        case "OPTS":
                            send(out, "200 OK");
                            break;
                        case "TYPE":
                            send(out, "200 Type set to " + arg);
                            break;
                        case "PWD":
                        case "XPWD":
                            send(out, "257 \"" + getVirtualPath(currentDir) + "\" is current directory");
                            break;
                        case "CWD":
                            File targetCwd = resolvePath(arg);
                            if (targetCwd != null && targetCwd.isDirectory()) {
                                currentDir = targetCwd;
                                send(out, "250 Directory changed");
                            } else {
                                send(out, "550 Directory not found");
                            }
                            break;
                        case "CDUP":
                            if (!currentDir.equals(rootDir) && currentDir.getParentFile() != null) {
                                currentDir = currentDir.getParentFile();
                            }
                            send(out, "250 Directory changed");
                            break;
                        case "PASV":
                            closePassive();
                            passiveServer = new ServerSocket(0);
                            int p = passiveServer.getLocalPort();
                            String ip = getLocalIpAddress().replace('.', ',');
                            send(out, "227 Entering Passive Mode (" + ip + "," + (p >> 8) + "," + (p & 0xFF) + ")");
                            break;
                        case "LIST":
                        case "NLST":
                            handleList(out, arg, "LIST".equals(cmd));
                            break;
                        case "SIZE":
                            File sf = resolvePath(arg);
                            if (sf != null && sf.isFile()) send(out, "213 " + sf.length());
                            else send(out, "550 File not found");
                            break;
                        case "RETR":
                            handleRetr(out, arg);
                            break;
                        case "STOR":
                            handleStor(out, arg);
                            break;
                        case "MKD":
                        case "XMKD":
                            File mk = resolvePath(arg);
                            if (mk != null && mk.mkdirs()) send(out, "257 Directory created");
                            else send(out, "550 Failed to create directory");
                            break;
                        case "DELE":
                            File del = resolvePath(arg);
                            if (del != null && del.isFile() && del.delete()) send(out, "250 File deleted");
                            else send(out, "550 Delete failed");
                            break;
                        case "RMD":
                        case "XRMD":
                            File rmd = resolvePath(arg);
                            if (rmd != null && rmd.isDirectory() && rmd.delete()) send(out, "250 Directory removed");
                            else send(out, "550 Remove failed");
                            break;
                        case "RNFR":
                            renameFrom = resolvePath(arg);
                            if (renameFrom != null && renameFrom.exists()) send(out, "350 Ready for RNTO");
                            else send(out, "550 File not found");
                            break;
                        case "RNTO":
                            File renameTo = resolvePath(arg);
                            if (renameFrom != null && renameTo != null && renameFrom.renameTo(renameTo)) {
                                send(out, "250 Renamed");
                            } else {
                                send(out, "550 Rename failed");
                            }
                            renameFrom = null;
                            break;
                        case "NOOP":
                            send(out, "200 OK");
                            break;
                        case "QUIT":
                            send(out, "221 Goodbye");
                            return;
                        default:
                            send(out, "502 Command not implemented");
                            break;
                    }
                }
            } catch (Exception ignored) {
            } finally {
                closePassive();
                try {
                    controlSocket.close();
                } catch (IOException ignored) {
                }
            }
        }

        private void handleList(PrintWriter out, String arg, boolean full) {
            if (passiveServer == null) {
                send(out, "425 Use PASV first");
                return;
            }
            File dir = (arg == null || arg.isEmpty() || arg.startsWith("-")) ? currentDir : resolvePath(arg);
            if (dir == null || !dir.isDirectory()) {
                send(out, "550 Directory not found");
                return;
            }
            send(out, "150 Opening ASCII mode data connection");
            try (Socket data = passiveServer.accept();
                 PrintWriter dataOut = new PrintWriter(new OutputStreamWriter(data.getOutputStream()), true)) {
                File[] list = dir.listFiles();
                if (list != null) {
                    for (File f : list) {
                        if (full) {
                            String perm = f.isDirectory() ? "drwxr-xr-x" : "-rw-r--r--";
                            String dt = lsFmt.format(new Date(f.lastModified()));
                            dataOut.print(String.format(Locale.US, "%s 1 owner group %10d %s %s\r\n",
                                perm, f.isDirectory() ? 0L : f.length(), dt, f.getName()));
                        } else {
                            dataOut.print(f.getName() + "\r\n");
                        }
                    }
                }
                dataOut.flush();
                send(out, "226 Transfer complete");
            } catch (Exception e) {
                send(out, "426 Transfer aborted");
            } finally {
                closePassive();
            }
        }

        private void handleRetr(PrintWriter out, String arg) {
            if (passiveServer == null) {
                send(out, "425 Use PASV first");
                return;
            }
            File f = resolvePath(arg);
            if (f == null || !f.isFile()) {
                send(out, "550 File not found");
                return;
            }
            send(out, "150 Opening BINARY mode data connection");
            try (Socket data = passiveServer.accept();
                 BufferedInputStream bis = new BufferedInputStream(new FileInputStream(f));
                 BufferedOutputStream bos = new BufferedOutputStream(data.getOutputStream())) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = bis.read(buf)) != -1) bos.write(buf, 0, n);
                bos.flush();
                send(out, "226 Transfer complete");
            } catch (Exception e) {
                send(out, "426 Transfer aborted");
            } finally {
                closePassive();
            }
        }

        private void handleStor(PrintWriter out, String arg) {
            if (passiveServer == null) {
                send(out, "425 Use PASV first");
                return;
            }
            File f = resolvePath(arg);
            if (f == null) {
                send(out, "550 Invalid path");
                return;
            }
            send(out, "150 Opening BINARY mode data connection");
            try (Socket data = passiveServer.accept();
                 BufferedInputStream bis = new BufferedInputStream(data.getInputStream());
                 BufferedOutputStream bos = new BufferedOutputStream(new FileOutputStream(f))) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = bis.read(buf)) != -1) bos.write(buf, 0, n);
                bos.flush();
                send(out, "226 Transfer complete");
            } catch (Exception e) {
                send(out, "426 Transfer aborted");
            } finally {
                closePassive();
            }
        }

        private File resolvePath(String path) {
            try {
                File f = (path == null || path.isEmpty())
                    ? currentDir
                    : (path.startsWith("/") ? new File(rootDir, path.substring(1)) : new File(currentDir, path));
                String rootCanon = rootDir.getCanonicalPath();
                String targetCanon = f.getCanonicalPath();
                if (!targetCanon.startsWith(rootCanon)) return rootDir;
                return f;
            } catch (IOException e) {
                return null;
            }
        }

        private String getVirtualPath(File dir) {
            try {
                String rootCanon = rootDir.getCanonicalPath();
                String dirCanon = dir.getCanonicalPath();
                if (dirCanon.equals(rootCanon)) return "/";
                return dirCanon.substring(rootCanon.length()).replace('\\', '/');
            } catch (IOException e) {
                return "/";
            }
        }

        private void send(PrintWriter out, String msg) {
            out.print(msg + "\r\n");
            out.flush();
        }

        private void closePassive() {
            try {
                if (passiveServer != null) passiveServer.close();
            } catch (IOException ignored) {
            }
            passiveServer = null;
        }
    }
}
