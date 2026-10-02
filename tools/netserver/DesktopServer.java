package netserver;

import com.kaipai.prototype.net.AssetSource;
import com.kaipai.prototype.net.HttpGameServer;
import com.kaipai.prototype.net.NetUtil;
import com.kaipai.prototype.net.RoomDiscovery;
import com.kaipai.prototype.net.RoomResponder;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.Socket;
import java.nio.charset.Charset;
import java.nio.file.Files;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 桌面联机服务器（开发/测试用，不打进 APK）。
 *
 * 用途：不装 APK、不开两台手机，就能在开发机上把「主机」跑起来，
 * 用浏览器或 DesktopTest 真刀真枪地跑一遍协议。
 *
 * 为什么放在 tools/ 而不是 android/：
 *   构建脚本只编译 android/app/java 下的 Java，tools/ 里的东西永远不进包 ——
 *   桌面测试代码混进 APK 只会白占体积、还可能被 d8 报错。
 *
 * 用法：
 *   java -cp &lt;classes&gt; netserver.DesktopServer [房间名] [主机名]
 *   java ... -Dassets=E:\ka_pai\app netserver.DesktopServer
 */
public final class DesktopServer {

    public static void main(String[] args) throws Exception {
        String room = args.length > 0 ? args[0] : "卡牌对决";
        String host = args.length > 1 ? args[1] : "桌面主机";
        String assetRoot = System.getProperty("assets", "E:\\ka_pai\\app");

        AssetSource assets = new FileAssetSource(new File(assetRoot));
        HttpGameServer server = new HttpGameServer(assets, room, host);
        int port = server.start();
        server.awaitReady(2000);

        RoomResponder responder = null;
        try {
            responder = new RoomResponder(room, host, port);
            responder.start();
        } catch (IOException e) {
            System.out.println("  (UDP 8766 起不来，房间扫不到： " + e.getMessage() + ")");
        }

        String ip = NetUtil.getLocalIp();
        System.out.println("卡牌对决 - 局域网主机已启动");
        System.out.println("  房间    " + room + "  (主机: " + host + ")");
        System.out.println("  本机    " + (ip.isEmpty() ? "(没找到局域网 IP)" : ip));
        System.out.println("  主机开  http://127.0.0.1:" + port + "/?net=host&room=" + room);
        System.out.println("  客人开  http://" + ip + ":" + port + "/?net=guest&room=" + room);
        System.out.println("  UDP     " + RoomDiscovery.DISCOVER_PORT + "  " + RoomDiscovery.MAGIC);
        System.out.println("按 Ctrl+C 停止。");

        final HttpGameServer srv = server;
        final RoomResponder rsp = responder;
        Runtime.getRuntime().addShutdownHook(new Thread(new Runnable() {
            @Override
            public void run() {
                if (rsp != null) rsp.stop();
                srv.stop();
            }
        }));
        Thread.currentThread().join();
    }

    /**
     * 用文件系统当 AssetSource：把 {@code E:\ka_pai\app\} 映射成 APK 里的 {@code assets/}。
     * 这样桌面跑的就是真文件，改完网页资源不用重打包就能验证服务端行为。
     */
    public static final class FileAssetSource implements AssetSource {

        private final File root;

        public FileAssetSource(File root) {
            this.root = root;
        }

        @Override
        public byte[] read(String path) {
            if (path == null || path.isEmpty()) return null;
            File f = new File(root, path.replace('/', File.separatorChar));
            if (!f.isFile()) return null;
            try {
                return Files.readAllBytes(f.toPath());
            } catch (IOException e) {
                return null;
            }
        }

        @Override
        public boolean exists(String path) {
            if (path == null || path.isEmpty()) return false;
            return new File(root, path.replace('/', File.separatorChar)).isFile();
        }
    }

    // ══════════════════════════════════════════════════════════
    // 手写 HTTP 客户端
    // ══════════════════════════════════════════════════════════
    //
    // 刻意不用 HttpURLConnection：它是"帮忙"的，会自动补 Host、自动重试、
    // 自己解析 chunked —— 而这里要验证的恰恰是**我们自己写的 HTTP 解析器**
    // 能不能扛住浏览器/我们自己发的真实报文。所以直接往 socket 里写字节，
    // 只依赖最原始的那几个头，看到的就是服务端真正吐出来的东西。

    public static final class Resp {
        public int status;
        public final Map<String, String> headers = new LinkedHashMap<String, String>();
        public String body = "";

        @Override
        public String toString() {
            return status + " " + body;
        }
    }

    /** 极简 HTTP/1.1 客户端，一个请求一个连接（Connection: close）。 */
    public static final class RawHttp {

        private final String host;
        private final int port;

        public RawHttp(int port) {
            this("127.0.0.1", port);
        }

        public RawHttp(String host, int port) {
            this.host = host;
            this.port = port;
        }

        public Resp get(String pathAndQuery) throws IOException {
            return request("GET", pathAndQuery, null, 30000);
        }

        public Resp get(String pathAndQuery, int readTimeoutMs) throws IOException {
            return request("GET", pathAndQuery, null, readTimeoutMs);
        }

        public Resp post(String pathAndQuery, String body) throws IOException {
            return request("POST", pathAndQuery, body, 30000);
        }

        public Resp request(String method, String pathAndQuery, String body, int readTimeoutMs)
                throws IOException {
            Socket sock = new Socket();
            try {
                sock.connect(new java.net.InetSocketAddress(host, port), 4000);
                sock.setSoTimeout(readTimeoutMs);
                sock.setTcpNoDelay(true);

                byte[] bodyBytes = body == null
                        ? new byte[0]
                        : body.getBytes(Charset.forName("UTF-8"));

                StringBuilder head = new StringBuilder();
                head.append(method).append(' ').append(pathAndQuery).append(" HTTP/1.1\r\n");
                head.append("Host: ").append(host).append(':').append(port).append("\r\n");
                head.append("Connection: close\r\n");
                if (body != null) {
                    head.append("Content-Type: application/json\r\n");
                    head.append("Content-Length: ").append(bodyBytes.length).append("\r\n");
                }
                head.append("\r\n");

                java.io.OutputStream out = sock.getOutputStream();
                out.write(head.toString().getBytes(Charset.forName("US-ASCII")));
                if (bodyBytes.length > 0) out.write(bodyBytes);
                out.flush();

                return readResponse(sock.getInputStream());
            } finally {
                try {
                    sock.close();
                } catch (IOException ignored) {
                }
            }
        }

        private Resp readResponse(InputStream in) throws IOException {
            String statusLine = readLine(in);
            if (statusLine == null) throw new IOException("服务端没有返回状态行");
            Resp r = new Resp();
            String[] parts = statusLine.split(" ", 3);
            try {
                r.status = Integer.parseInt(parts[1]);
            } catch (RuntimeException e) {
                throw new IOException("非法状态行: " + statusLine);
            }

            int contentLength = -1;
            boolean chunked = false;
            while (true) {
                String line = readLine(in);
                if (line == null || line.isEmpty()) break;
                int c = line.indexOf(':');
                if (c <= 0) continue;
                String k = line.substring(0, c).trim().toLowerCase();
                String v = line.substring(c + 1).trim();
                r.headers.put(k, v);
                if (k.equals("content-length")) {
                    try {
                        contentLength = Integer.parseInt(v);
                    } catch (NumberFormatException ignored) {
                    }
                } else if (k.equals("transfer-encoding") && v.toLowerCase().contains("chunked")) {
                    chunked = true;
                }
            }

            ByteArrayOutputStream body = new ByteArrayOutputStream();
            if (chunked) {
                while (true) {
                    String sizeLine = readLine(in);
                    if (sizeLine == null) break;
                    int size;
                    try {
                        size = Integer.parseInt(sizeLine.trim().split(";")[0], 16);
                    } catch (NumberFormatException e) {
                        break;
                    }
                    if (size == 0) {
                        readLine(in);
                        break;
                    }
                    byte[] buf = new byte[size];
                    int read = 0;
                    while (read < size) {
                        int n = in.read(buf, read, size - read);
                        if (n < 0) break;
                        read += n;
                    }
                    body.write(buf, 0, read);
                    readLine(in);
                }
            } else if (contentLength >= 0) {
                byte[] buf = new byte[contentLength];
                int read = 0;
                while (read < contentLength) {
                    int n = in.read(buf, read, contentLength - read);
                    if (n < 0) break;
                    read += n;
                }
                body.write(buf, 0, read);
            } else {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) body.write(buf, 0, n);
            }

            r.body = new String(body.toByteArray(), Charset.forName("UTF-8"));
            return r;
        }

        private static String readLine(InputStream in) throws IOException {
            ByteArrayOutputStream buf = new ByteArrayOutputStream(128);
            int c;
            while ((c = in.read()) >= 0) {
                if (c == '\n') {
                    byte[] b = buf.toByteArray();
                    int len = b.length;
                    if (len > 0 && b[len - 1] == '\r') len--;
                    return new String(b, 0, len, Charset.forName("UTF-8"));
                }
                buf.write(c);
            }
            return buf.size() == 0 ? null : new String(buf.toByteArray(), Charset.forName("UTF-8"));
        }
    }

    /** 供外部（测试）复用的小工具：起一个 HTTP 服务 + 应答器。 */
    public static final class Bundle {
        public final HttpGameServer server;
        public final RoomResponder responder;

        Bundle(HttpGameServer server, RoomResponder responder) {
            this.server = server;
            this.responder = responder;
        }

        public void stop() {
            if (responder != null) responder.stop();
            if (server != null) server.stop();
        }
    }

    /** 起一套完整的联机服务（HTTP + UDP），测试和手工调试都用它。 */
    public static Bundle start(String room, String host, AssetSource assets) throws IOException {
        HttpGameServer server = new HttpGameServer(assets, room, host);
        server.start();
        server.awaitReady(2000);
        RoomResponder responder = null;
        try {
            responder = new RoomResponder(room, host, server.getPort());
            responder.start();
        } catch (IOException ignored) {
            // 8766 被占：HTTP 测试不受影响，UDP 测试自己会跳过
        }
        return new Bundle(server, responder);
    }

    /** 起一套不占 8766 的 HTTP-only 服务：多组测试并行/连续跑时不会互相抢 UDP。 */
    public static HttpGameServer startHttpOnly(String room, String host, AssetSource assets)
            throws IOException {
        HttpGameServer server = new HttpGameServer(assets, room, host);
        server.start();
        server.awaitReady(2000);
        return server;
    }
}

