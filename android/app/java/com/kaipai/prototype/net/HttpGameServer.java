package com.kaipai.prototype.net;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * 局域网主机侧的 HTTP 服务：静态资源 + 消息中继（协议 §1 §2 §3）。
 *
 * 为什么页面也由主机提供（而不是两端各自跑 APK / 客人直连 API）：
 *   APK 里的页面是 file:// 源，从 file:// 发 fetch 到 http:// 会被 WebView 的
 *   setAllowUniversalAccessFromFileURLs（默认关）直接拦掉，加 CORS 头也没用。
 *   让客人导航到 http://主机:8765/ 就从根上绕开了跨源问题，还顺带保证两端同版本。
 *
 * 纯 Java，不含任何 Android 类 —— 联机逻辑（长轮询、seq、peer-left）是本项目里
 * 最需要被反复验证的部分，放在这里才能在开发机 JVM 上直接跑 DesktopTest。
 *
 * 线程模型：
 *   · 一个 accept 线程，每个连接丢给线程池的独立任务 —— 长轮询会占住线程最多 30 秒，
 *     绝不能阻塞 accept 循环。
 *   · 所有可变状态由 lock 保护，长轮询用 wait/notifyAll（不忙等）。
 */
public final class HttpGameServer {

    public static final int VERSION = 1;
    public static final int DEFAULT_PORT = 8765;
    private static final int PORT_ATTEMPTS = 10;

    /** 超过这个时间没有任何请求，就认为对方离开了（协议 §5 requirement：15 秒）。 */
    private static final long PEER_TIMEOUT_NANOS = 15L * 1000 * 1000 * 1000;

    private static final int POLL_TIMEOUT_DEFAULT_MS = 20000;
    private static final int POLL_TIMEOUT_MAX_MS = 30000;

    private static final int MAX_HEADER_BYTES = 32 * 1024;
    private static final int MAX_BODY_BYTES = 4 * 1024 * 1024;
    private static final int SOCKET_READ_TIMEOUT_MS = 30000;

    /** WebSocket 心跳间隔：既保活，也用来及早发现对端已经不在 */
    private static final long WS_PING_INTERVAL_MS = 20000L;

    private static final String WHO_HOST = "host";
    private static final String WHO_GUEST = "guest";

    private final AssetSource assets;
    private final Object lock = new Object();

    private final ExecutorService pool;

    private ServerSocket serverSocket;
    private Thread acceptThread;
    private volatile int port = DEFAULT_PORT;
    private volatile boolean running = false;

    /** 就绪信号：桌面测试不必靠 sleep-grace 去猜服务什么时候开始监听。 */
    private final CountDownLatch ready = new CountDownLatch(1);

    // ── 房间元信息（协议 §2.2 §6） ─────────────────────────────
    private volatile String roomName;
    private volatile String hostName;
    private volatile boolean started = false;

    // ── 消息日志（协议 §5 requirement：seq 从 0 开始，永久保留） ──────
    /** 全部消息，按到达顺序。seq 就是这个 list 的下标。 */
    private final List<Map<String, Object>> log = new ArrayList<Map<String, Object>>();

    // ── 在线状态（协议 §5 requirement：peer-left） ──────────────
    private final PeerState host = new PeerState();
    private final PeerState guest = new PeerState();

    public HttpGameServer(AssetSource assets) {
        this(assets, "卡牌对决", "主机");
    }

    public HttpGameServer(AssetSource assets, String roomName, String hostName) {
        this.assets = assets;
        this.roomName = roomName == null ? "卡牌对决" : roomName;
        this.hostName = hostName == null ? "主机" : hostName;
        // 固定大小：单次请求都很快，唯一会长期占用线程的是长轮询，24 个足够两端 +
        // 浏览器预连接 + 重试。用 cached 池反而可能被异常客户端拖出一堆线程。
        this.pool = Executors.newFixedThreadPool(24, new KapaiThreadFactory());
    }

    // ── 生命周期 ────────────────────────────────────────────

    /**
     * 绑定端口并开始服务。端口从 8765 往上试，最多 10 个（协议 §2）。
     *
     * @return 实际监听的端口
     * @throws IOException 10 个端口全部被占用
     */
    public int start() throws IOException {
        IOException last = null;
        for (int i = 0; i < PORT_ATTEMPTS; i++) {
            int candidate = DEFAULT_PORT + i;
            if (candidate > 65535) break;
            ServerSocket ss = null;
            try {
                ss = new ServerSocket();
                ss.setReuseAddress(true);
                // bind 到通配地址：这样 127.0.0.1（主机自己）和 192.168.x.x（客人）都能连上
                ss.bind(new InetSocketAddress(candidate), 64);
            } catch (IOException e) {
                last = e;
                NetUtil.closeQuietly(ss);
                continue;
            }
            serverSocket = ss;
            port = candidate;
            break;
        }
        if (serverSocket == null) {
            throw last != null ? last : new IOException("8765 起 10 个端口都被占用");
        }

        running = true;
        synchronized (lock) {
            // 复用同一个实例重新开局时，清掉上一局的在线状态
            host.seen = false;
            host.left = false;
            host.activePolls = 0;
            guest.seen = false;
            guest.left = false;
            guest.activePolls = 0;
            log.clear();
            started = false;
            lock.notifyAll();
        }

        acceptThread = new Thread(new AcceptLoop(this), "kapai-http-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();

        ready.countDown();
        return port;
    }

    /** 等 accept 线程真正开始跑（桌面测试用；真机上不需要）。 */
    public void awaitReady(long timeoutMs) {
        try {
            ready.await(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    public int getPort() {
        return port;
    }

    public boolean isRunning() {
        return running;
    }

    public void setRoomName(String room) {
        if (room != null && !room.isEmpty()) this.roomName = room;
    }

    public String getRoomName() {
        return roomName;
    }

    public void setHostName(String name) {
        if (name != null && !name.isEmpty()) this.hostName = name;
    }

    public String getHostName() {
        return hostName;
    }

    public boolean isStarted() {
        return started;
    }

    /** 当前在线人数：主机 + 已出现的客人（主机房间天然算 1 人）。 */
    public int getPlayers() {
        synchronized (lock) {
            return playersLocked();
        }
    }

    /** 必须在持有 lock 时调用。 */
    private int playersLocked() {
        return 1 + (guest.seen && !guest.left ? 1 : 0);
    }

    public String getUrl() {
        return "http://127.0.0.1:" + port + "/";
    }

    /** 停服：唤醒所有挂起的长轮询，否则它们要等满 timeout 才退，关房间会卡一下。 */
    public void stop() {
        running = false;
        synchronized (lock) {
            lock.notifyAll();
        }
        NetUtil.closeQuietly(serverSocket);
        serverSocket = null;
        pool.shutdownNow();
        if (acceptThread != null) {
            acceptThread.interrupt();
            acceptThread = null;
        }
        try {
            pool.awaitTermination(2, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    // ── accept 循环 ─────────────────────────────────────────

    /** 循环体提成了顶层类 AcceptLoop 的调用目标：包内可见即可。 */
    void acceptLoop() {
        while (running) {
            Socket sock = null;
            try {
                sock = serverSocket.accept();
            } catch (IOException e) {
                // 停服时 close(serverSocket) 会让 accept 抛 SocketException —— 这是正常退出路径
                if (!running) return;
                continue;
            }
            final Socket s = sock;
            try {
                pool.execute(new ConnectionTask(this, s));
            } catch (RuntimeException e) {
                // 池已关闭（正在停服）：直接放弃这个连接，但别让 accept 线程死掉
                NetUtil.closeQuietly(s);
            }
        }
    }

    // ── 单连接处理 ──────────────────────────────────────────

    /** 处理体提成了顶层类 ConnectionTask 的调用目标：包内可见即可。 */
    void handleConnection(Socket sock) {
        InputStream in = null;
        OutputStream out = null;
        // WebSocket 连接要长期持有，不能走下面的 finally 关闭流程
        boolean keepOpen = false;
        try {
            sock.setSoTimeout(SOCKET_READ_TIMEOUT_MS);
            sock.setTcpNoDelay(true);   // 小消息立刻发出去，别等 Nagle 攒包
            in = new BufferedInputStream(sock.getInputStream(), 8192);
            out = new BufferedOutputStream(sock.getOutputStream(), 8192);

            Request req = readRequest(in);
            if (req == null) return;    // 对端开了连接又立刻关（浏览器预连接很常见）

            // 推送通道：升级成 WebSocket 之后这条连接归 serveWebSocket 自己管
            if (req.path.equals("/ws")) {
                sock.setSoTimeout(0);   // 长连接不能带读超时
                keepOpen = true;
                serveWebSocket(sock, in, out, req);
                return;
            }

            // 协议里的请求都很小，一次性构造 + 一把写出足够；分块传输（chunked）没实现，
            // 因为两端都是我们自己的 fetch 客户端，不会用 chunked 发请求体。
            Response res = route(req);
            sendResponse(out, res, req.closeAfter);
        } catch (SocketTimeoutException e) {
            // 读请求头超时：静默丢弃。日志刷屏对真机排错没帮助。
        } catch (EOFException e) {
        } catch (IOException e) {
            // 单个连接的异常绝不能影响其它连接，更不能弄死 accept 线程
        } catch (RuntimeException e) {
            // route() 里的意外（比如手写 JSON 的 bug）也只影响当前连接
        } finally {
            if (!keepOpen) {
                NetUtil.closeQuietly(in);
                NetUtil.closeQuietly(out);
                NetUtil.closeQuietly(sock);
            }
        }
    }

    // ── WebSocket 推送通道（协议 §2.7）────────────────────────
    //
    // 为什么加它：长轮询要一直挂着一个 20 秒的 HTTP 连接，有些路由器/WebView
    // 会把空闲连接掐掉，而且**断线要等下一次轮询失败才知道**。
    // WebSocket 是常连接：有新消息立刻推，断了立刻知道。
    //
    // 发送仍然走 `/api/send`（HTTP POST）—— 这样发送路径完全没变，
    // 已有的测试和错误处理继续有效；这里只替代 `/api/poll`。

    /** 每个 peer 当前挂着的推送通道（重复连接会顶掉旧的） */
    private final Map<String, OutputStream> wsOut = new HashMap<String, OutputStream>();

    private void serveWebSocket(Socket sock, InputStream in, OutputStream out, Request req) {
        String who = req.who == null ? WHO_GUEST : req.who;
        String key = req.headers.get("sec-websocket-key");
        if (key == null || key.isEmpty()) return;

        try {
            WebSocketPeer.writeHandshake(out, key);
        } catch (IOException e) {
            return;
        }

        synchronized (lock) {
            OutputStream old = wsOut.put(who, out);
            if (old != null) NetUtil.closeQuietly(old);   // 同一方重复连：顶掉旧的
            touch(who);
            lock.notifyAll();
        }

        int since = Json.intVal(req.query, "since", 0);
        if (since < 0) since = 0;

        // 读线程：只负责发现对端关闭 / 回 pong。不读的话，对端断线我们要等
        // 到下一次写失败才知道，而 TCP 写失败可能要好几分钟才报出来。
        final boolean[] closed = new boolean[] { false };
        Thread reader = new Thread(new WsReader(in, out, out, closed, lock), "kapai-ws-reader-" + who);
        reader.setDaemon(true);
        reader.start();

        long lastPing = System.currentTimeMillis();
        try {
            while (running && !closed[0]) {
                List<Object> batch = null;
                synchronized (lock) {
                    if (log.size() <= since && !closed[0]) {
                        lock.wait(500);
                    }
                    if (log.size() > since) {
                        batch = new ArrayList<Object>(log.subList(since, log.size()));
                        since = log.size();
                    }
                }
                if (batch != null) {
                    for (Object entry : batch) {
                        // 只推**对方**发的：自己发的本地已经执行过一次了，
                        // 推回来会让它再执行一遍（JS 侧虽然也过滤，但那是兜底，不该是正确性的依赖）。
                        if (entry instanceof Map) {
                            Object from = ((Map<?, ?>) entry).get("from");
                            if (from != null && who.equals(String.valueOf(from))) continue;
                        }
                        synchronized (out) {
                            WebSocketPeer.writeText(out, Json.encode(entry));
                        }
                    }
                    touch(who);
                }
                long now = System.currentTimeMillis();
                if (now - lastPing > WS_PING_INTERVAL_MS) {
                    lastPing = now;
                    synchronized (out) {
                        WebSocketPeer.writeControl(out, WebSocketPeer.OP_PING, new byte[0]);
                    }
                }
            }
        } catch (IOException e) {
            // 对端断了
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            synchronized (lock) {
                // 只有当前注册的还是我这一条时才摘掉，避免把后来者的通道误删
                if (wsOut.get(who) == out) wsOut.remove(who);
                lock.notifyAll();
            }
            NetUtil.closeQuietly(in);
            NetUtil.closeQuietly(out);
            NetUtil.closeQuietly(sock);
        }
    }

    // ── 路由 ────────────────────────────────────────────────

    private Response route(Request req) {
        String path = req.path;

        // 任何请求都刷新该 peer 的活跃时间：判定「离开」的依据就是「还有没有请求」
        touch(req.who);

        if (path.equals("/api/health")) {
            return health();
        }
        if (path.equals("/api/room")) {
            return roomInfo();
        }
        // 写操作用 POST 是协议规定的，也是必要的：GET 能被 <img src> 这类
        // 跨站请求白打出去（局域网里访问一个网页就能让别人掉线），必须挡住。
        // /api/send 不在此列：它本来就要 body，GET 打不出有效消息。
        if (path.equals("/api/leave") || path.equals("/api/start")) {
            if (!"POST".equals(req.method)) {
                return Response.json(405, "{\"ok\":false,\"error\":\"method-not-allowed\"}");
            }
        }
        if (path.equals("/api/send")) {
            return send(req);
        }
        if (path.equals("/api/poll")) {
            return poll(req);
        }
        if (path.equals("/api/leave")) {
            return leave(req);
        }
        if (path.equals("/api/start")) {
            return startGame(req);
        }
        if (path.startsWith("/api/")) {
            return Response.json(404, "{\"ok\":false,\"error\":\"unknown-api\"}");
        }
        return staticAsset(path);
    }

    private Response health() {
        Map<String, Object> m = Json.obj();
        m.put("ok", Boolean.TRUE);
        m.put("version", VERSION);
        return Response.json(200, Json.encode(m));
    }

    private Response roomInfo() {
        Map<String, Object> m = Json.obj();
        m.put("ok", Boolean.TRUE);
        synchronized (lock) {
            m.put("room", roomName);
            m.put("host", hostName);
            m.put("port", port);
            m.put("players", playersLocked());
            m.put("started", started);
            m.put("version", VERSION);
        }
        return Response.json(200, Json.encode(m));
    }

    // ── /api/send ───────────────────────────────────────────

    private Response send(Request req) {
        if (req.body == null || req.body.isEmpty()) {
            return Response.json(400, "{\"ok\":false,\"error\":\"empty-body\"}");
        }
        Map<String, Object> msg;
        try {
            msg = Json.decodeObject(req.body);
        } catch (JsonException e) {
            return Response.json(400, "{\"ok\":false,\"error\":\"bad-json\"}");
        }

        String from = req.who;
        if (from == null) from = "guest";

        synchronized (lock) {
            // 已离开的一方不该再往日志里塞消息：否则另一端重连后会看到"幽灵对手"还在动
            if (peerOf(from) != null && peerOf(from).left) {
                return Response.json(409, "{\"ok\":false,\"error\":\"you-left\"}");
            }
            int seq = log.size();
            Map<String, Object> entry = new LinkedHashMap<String, Object>();
            entry.put("seq", (long) seq);
            entry.put("from", from);
            // name 优先用请求里带的；JS 侧的 Transport.send 不带 name，
            // 那就回落到开局时登记的名字，否则界面上「谁说的话」会全是空的
            String display = req.name;
            if (display == null || display.isEmpty()) {
                display = WHO_HOST.equals(from) ? hostName : "";
            }
            entry.put("name", display);
            entry.put("msg", msg);
            log.add(entry);

            // 协议 §3 说 start 之后房间进入 started 状态；用消息本身兜底，
            // 这样即便 JS 忘了调 /api/start，房间列表上的"已开始"也是对的。
            if ("start".equals(Json.str(msg, "t", ""))) started = true;

            // 新消息到达：唤醒所有挂起的长轮询
            lock.notifyAll();
            return Response.json(200, "{\"ok\":true,\"seq\":" + seq + "}");
        }
    }

    // ── /api/poll ───────────────────────────────────────────

    private Response poll(Request req) {
        String me = req.who == null ? "guest" : req.who;
        int since = Json.intVal(req.query, "since", 0);
        if (since < 0) since = 0;
        int timeout = Json.intVal(req.query, "timeout", POLL_TIMEOUT_DEFAULT_MS);
        if (timeout < 0) timeout = 0;
        if (timeout > POLL_TIMEOUT_MAX_MS) timeout = POLL_TIMEOUT_MAX_MS;

        PeerState mine = peerOf(me);
        synchronized (lock) {
            if (mine != null) mine.activePolls++;
        }
        try {
            long deadline = System.nanoTime() + timeout * 1000000L;
            synchronized (lock) {
                while (true) {
                    if (!running) return Response.json(503, "{\"ok\":false,\"error\":\"server-stopped\"}");

                    PeerState other = peerOf(otherOf(me));
                    if (other != null && other.left) {
                        // 协议 §2.4：一方离开后，另一方下一次 poll 立刻返回 peer-left
                        return peerLeft();
                    }

                    List<Object> msgs = messagesSince(since);
                    if (!msgs.isEmpty()) {
                        return pollOk(since, msgs);
                    }

                    // 超时判定：对方「出现过、但 15 秒没有任何请求、且此刻没有挂着的 poll」。
                    // 那个 activePolls 条件是必须的 —— 否则两端互相长轮询时，
                    // 谁先把 20 秒的 poll 挂出去，对方就会在自己 poll 返回的间隙被误判成掉线。
                    if (other != null && other.seen && !other.left && other.activePolls == 0
                            && System.nanoTime() - other.lastActivityNanos > PEER_TIMEOUT_NANOS) {
                        other.left = true;
                        lock.notifyAll();
                        return peerLeft();
                    }

                    long remainMs = (deadline - System.nanoTime()) / 1000000L;
                    if (remainMs <= 0) {
                        // 真的到点了就回空数组，让 JS 立刻再发一轮 —— 比在服务端续挂更好排查
                        return pollOk(since, new ArrayList<Object>());
                    }
                    try {
                        // wait 而不是忙等；被 notifyAll 唤醒后会重新检查上面所有条件
                        lock.wait(Math.min(remainMs, 1000L));
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        return Response.json(503, "{\"ok\":false,\"error\":\"interrupted\"}");
                    }
                }
            }
        } finally {
            synchronized (lock) {
                if (mine != null && mine.activePolls > 0) mine.activePolls--;
            }
        }
    }

    private List<Object> messagesSince(int since) {
        List<Object> out = new ArrayList<Object>();
        for (int i = Math.max(0, since); i < log.size(); i++) {
            out.add(log.get(i));
        }
        return out;
    }

    private Response pollOk(int since, List<Object> msgs) {
        Map<String, Object> m = Json.obj();
        m.put("ok", Boolean.TRUE);
        m.put("now", (long) log.size());
        m.put("msgs", msgs);
        return Response.json(200, Json.encode(m));
    }

    private Response peerLeft() {
        // 用 200：客户端是看 body 里的 ok 判断的，非 2xx 只会让 fetch 走到 catch 分支，
        // 反而让"对手离开"这种正常业务状态表现成网络错误。
        return Response.json(200, "{\"ok\":false,\"error\":\"peer-left\"}");
    }

    // ── /api/leave、/api/start ───────────────────────────────

    private Response leave(Request req) {
        String who = req.who == null ? "guest" : req.who;
        synchronized (lock) {
            PeerState p = peerOf(who);
            if (p != null) p.left = true;
            lock.notifyAll();
        }
        return Response.json(200, "{\"ok\":true}");
    }

    private Response startGame(Request req) {
        synchronized (lock) {
            started = true;
            lock.notifyAll();
        }
        return Response.json(200, "{\"ok\":true}");
    }

    // ── 静态资源 ────────────────────────────────────────────

    private Response staticAsset(String rawPath) {
        String path = rawPath;
        // 去掉查询串（assets 里的文件名不含 '?'），再剥掉前导 '/' 拼成资产路径
        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);
        int h = path.indexOf('#');
        if (h >= 0) path = path.substring(0, h);
        if (path.isEmpty() || path.equals("/")) path = "/index.html";

        String assetPath = path.startsWith("/") ? path.substring(1) : path;

        if (assetPath.contains("..") || assetPath.contains("\\")) {
            // 单页应用的兜底会把一切非 /api 路径都变成 index.html，
            // 所以这里不能"穿越"，直接按未知资源处理
            return Response.json(400, "{\"ok\":false,\"error\":\"bad-path\"}");
        }

        byte[] data = null;
        if (assets != null) {
            try {
                data = assets.read(assetPath);
            } catch (RuntimeException e) {
                data = null;
            }
        }
        if (data == null) {
            // 协议 §2.1：任何其它非 /api 路径都回 index.html（单页应用兜底）。
            // 但浏览器请求 favicon.ico 时回一个 HTML 会让控制台一直报错，所以特例掉。
            if (assetPath.equals("favicon.ico")) {
                return Response.empty(404);
            }
            data = assets == null ? null : assets.read("index.html");
            if (data == null) return Response.empty(404);
            return Response.bytes(200, "text/html; charset=utf-8", data);
        }
        return Response.bytes(200, contentTypeOf(assetPath), data);
    }

    private static String contentTypeOf(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".css")) return "text/css; charset=utf-8";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "application/javascript; charset=utf-8";
        if (p.endsWith(".json")) return "application/json; charset=utf-8";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".woff2")) return "font/woff2";
        return "text/html; charset=utf-8";
    }

    // ── 在线状态维护 ────────────────────────────────────────

    /** 记录该 peer 的一次请求活动。who 为空（静态资源请求）不记账。 */
    private void touch(String who) {
        PeerState p = peerOf(who);
        if (p == null) return;
        synchronized (lock) {
            p.seen = true;
            p.lastActivityNanos = System.nanoTime();
        }
    }

    private PeerState peerOf(String who) {
        if (WHO_HOST.equals(who)) return host;
        if (WHO_GUEST.equals(who)) return guest;
        return null;
    }

    private static String otherOf(String who) {
        return WHO_HOST.equals(who) ? WHO_GUEST : WHO_HOST;
    }

    // ── HTTP 解析 / 写出 ────────────────────────────────────

    /** 手写 HTTP/1.1 请求解析：只支持 GET/POST —— 协议只用到这两个。 */
    private Request readRequest(InputStream in) throws IOException {
        Request req = new Request();

        // 先读请求行，再读头。按字节读，避免 BufferedReader 把 body 一起缓冲走。
        String requestLine = readLine(in);
        if (requestLine == null) return null;             // 对端直接关了
        requestLine = requestLine.trim();
        if (requestLine.isEmpty()) return null;

        String[] parts = requestLine.split(" ");
        if (parts.length < 2) throw new IOException("非法请求行: " + requestLine);
        req.method = parts[0].toUpperCase();
        String target = parts[1];

        int q = target.indexOf('?');
        req.path = q >= 0 ? target.substring(0, q) : target;
        if (q >= 0) req.query = parseQuery(target.substring(q + 1));

        Object whoV = req.query.get("who");
        req.who = whoV == null ? null : String.valueOf(whoV);
        Object nameV = req.query.get("name");
        req.name = nameV == null ? null : String.valueOf(nameV);

        int contentLength = 0;
        boolean chunked = false;
        int headerBytes = requestLine.length();

        while (true) {
            String line = readLine(in);
            if (line == null) break;
            headerBytes += line.length();
            if (headerBytes > MAX_HEADER_BYTES) throw new IOException("请求头过大");
            if (line.isEmpty()) break;
            int colon = line.indexOf(':');
            if (colon <= 0) continue;
            String key = line.substring(0, colon).trim().toLowerCase();
            String val = line.substring(colon + 1).trim();
            req.headers.put(key, val);
            if (key.equals("content-length")) {
                try {
                    contentLength = Integer.parseInt(val);
                } catch (NumberFormatException e) {
                    throw new IOException("非法 Content-Length: " + val);
                }
            } else if (key.equals("transfer-encoding") && val.toLowerCase().contains("chunked")) {
                // 我们自己的 fetch 客户端不会用 chunked 发请求体，真收到就当成不支持
                chunked = true;
            } else if (key.equals("connection") && val.toLowerCase().contains("close")) {
                req.closeAfter = true;
            }
        }

        if (chunked) throw new IOException("不支持 chunked 请求体");
        if (contentLength > 0) {
            if (contentLength > MAX_BODY_BYTES) throw new IOException("请求体过大");
            byte[] buf = new byte[contentLength];
            int read = 0;
            while (read < contentLength) {
                int n = in.read(buf, read, contentLength - read);
                if (n < 0) throw new EOFException("请求体不完整");
                read += n;
            }
            req.body = new String(buf, java.nio.charset.Charset.forName("UTF-8"));
        }
        return req;
    }

    /** 读一行（CRLF 或 LF 结尾），不含行尾。返回 null 表示对端已关闭。 */
    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream(128);
        int c;
        while ((c = in.read()) >= 0) {
            if (c == '\n') {
                byte[] b = buf.toByteArray();
                int len = b.length;
                if (len > 0 && b[len - 1] == '\r') len--;
                return new String(b, 0, len, java.nio.charset.Charset.forName("UTF-8"));
            }
            buf.write(c);
            if (buf.size() > MAX_HEADER_BYTES) throw new IOException("请求行/头过长");
        }
        return buf.size() == 0 ? null : new String(buf.toByteArray(), java.nio.charset.Charset.forName("UTF-8"));
    }

    /** 只解析 GET 的查询串；百分号解码按 UTF-8 做，房间名/显示名里有中文所以要解对。 */
    private static Map<String, Object> parseQuery(String q) {
        Map<String, Object> m = Json.obj();
        if (q == null || q.isEmpty()) return m;
        for (String pair : q.split("&")) {
            if (pair.isEmpty()) continue;
            int eq = pair.indexOf('=');
            String k = eq >= 0 ? pair.substring(0, eq) : pair;
            String v = eq >= 0 ? pair.substring(eq + 1) : "";
            m.put(urlDecode(k), urlDecode(v));
        }
        return m;
    }

    private static String urlDecode(String s) {
        if (s.indexOf('%') < 0 && s.indexOf('+') < 0) return s;
        ByteArrayOutputStream out = new ByteArrayOutputStream(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '+') {
                out.write(' ');
            } else if (c == '%' && i + 2 < s.length()) {
                try {
                    out.write(Integer.parseInt(s.substring(i + 1, i + 3), 16));
                    i += 2;
                } catch (NumberFormatException e) {
                    out.write(c);
                }
            } else {
                // 非 ASCII 字符先按 UTF-8 拆字节，否则中文会被截断
                byte[] b = String.valueOf(c).getBytes(java.nio.charset.Charset.forName("UTF-8"));
                out.write(b, 0, b.length);
            }
        }
        return new String(out.toByteArray(), java.nio.charset.Charset.forName("UTF-8"));
    }

    private static void sendResponse(OutputStream out, Response res, boolean close) throws IOException {
        StringBuilder head = new StringBuilder(256);
        head.append("HTTP/1.1 ").append(res.status).append(' ').append(reasonOf(res.status)).append("\r\n");
        head.append("Content-Type: ").append(res.contentType).append("\r\n");
        int len = res.body == null ? 0 : res.body.length;
        head.append("Content-Length: ").append(len).append("\r\n");
        // no-store：两端跑的是同一份 bundle，任何中间缓存都会造成"一边新一边旧"的操作流不一致
        head.append("Cache-Control: no-store\r\n");
        head.append("Access-Control-Allow-Origin: *\r\n");
        head.append("Access-Control-Allow-Headers: *\r\n");
        head.append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
        head.append("Connection: ").append(close ? "close" : "keep-alive").append("\r\n");
        head.append("\r\n");

        out.write(head.toString().getBytes(java.nio.charset.Charset.forName("US-ASCII")));
        if (len > 0) out.write(res.body);
        out.flush();
    }

    private static String reasonOf(int status) {
        switch (status) {
            case 200: return "OK";
            case 400: return "Bad Request";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 409: return "Conflict";
            case 500: return "Internal Server Error";
            case 503: return "Service Unavailable";
            default:  return "OK";
        }
    }
}
