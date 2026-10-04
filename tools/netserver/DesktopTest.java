import com.kaipai.prototype.net.DiscoveredRoom;
import com.kaipai.prototype.net.HttpGameServer;
import com.kaipai.prototype.net.Json;
import com.kaipai.prototype.net.JsonException;
import com.kaipai.prototype.net.NetUtil;
import com.kaipai.prototype.net.RoomDiscovery;
import com.kaipai.prototype.net.RoomResponder;

import netserver.DesktopServer;

import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.io.File;
import java.nio.charset.Charset;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 联机服务端的桌面集成测试（不进 APK）。
 *
 * 为什么这件事非做不可：
 *   联机最要命的三处 —— 长轮询到底有没有挂住、seq 有没有乱、peer-left 会不会误报 ——
 *   在手机上只能靠"两台机器试一下"，而且很难复现。这些逻辑全部写在纯 Java 的 net/ 包里，
 *   就是为了能在这里用真 socket、真并发、真计时跑一遍。
 *
 * 原则：**只断言协议文档写死的东西**。断言不通过就改实现，绝不改松断言。
 *
 * 用法：见 tools/netserver/run-test.ps1（编译到临时目录再 java -cp 运行）。
 */
public final class DesktopTest {

    private static final String ASSET_ROOT = System.getProperty("assets", new File(System.getProperty("user.dir"), "app").getAbsolutePath());

    private static int passed = 0;
    private static int failed = 0;
    private static final List<String> failures = new ArrayList<String>();

    public static void main(String[] args) throws Exception {
        System.out.println("=== 卡牌对决 · 局域网服务端 桌面集成测试 ===");
        System.out.println("JDK      " + System.getProperty("java.version"));
        System.out.println("资产目录 " + ASSET_ROOT);
        System.out.println("本机 IP  " + NetUtil.getLocalIp());
        System.out.println("广播地址 " + NetUtil.getBroadcastAddresses());
        System.out.println();

        testJson();
        testJsonCornerCases();
        testStaticAssets();
        testMessaging();
        testPeerLeftExplicit();
        testPeerLeftTimeout();
        testDiscovery();
        testWebSocket();

        System.out.println();
        System.out.println("──────────────────────────────────────────────");
        System.out.println("通过 " + passed + " / 失败 " + failed);
        if (failed > 0) {
            System.out.println("失败项：");
            for (String f : failures) System.out.println("  ✗ " + f);
            System.out.println();
            System.out.println("!!! 有断言未通过，请修实现（不要改松断言）!!!");
            System.exit(1);
        }
        System.out.println("全部通过 ✅");
        System.exit(0);
    }

    // ══════════════════════════════════════════════════════════
    // §0 手写 JSON
    // ══════════════════════════════════════════════════════════

    private static void testJson() {
        section("0. Json 编解码");

        Map<String, Object> m = Json.obj();
        m.put("t", "start");
        m.put("seed", 12345L);
        m.put("firstPlayer", 0L);
        m.put("hostSide", 0L);
        List<Object> deck = new ArrayList<Object>();
        deck.add("knight");
        deck.add("drag on");
        m.put("deck", deck);
        m.put("flag", Boolean.TRUE);
        m.put("none", null);

        String s = Json.encode(m);
        check("编码出的 JSON 不含多余转义", s.contains("\"knight\""), s);

        Map<String, Object> back = Json.decodeObject(s);
        check("往返后 t 一致", "start".equals(Json.str(back, "t", "")), String.valueOf(back.get("t")));
        check("往返后 seed 一致", Json.intVal(back, "seed", -1) == 12345,
                String.valueOf(back.get("seed")));
        check("往返后 deck 长度一致",
                back.get("deck") instanceof List && ((List<?>) back.get("deck")).size() == 2,
                String.valueOf(back.get("deck")));
        check("含空格的字符串原样保留",
                "drag on".equals(((List<?>) back.get("deck")).get(1)),
                String.valueOf(((List<?>) back.get("deck")).get(1)));
        check("true 往返正确", Boolean.TRUE.equals(back.get("flag")), String.valueOf(back.get("flag")));
        check("null 字段保留为 null", back.containsKey("none") && back.get("none") == null,
                String.valueOf(back.get("none")));
    }

    private static void testJsonCornerCases() {
        section("0b. Json 边界情况（转义 / 中文 / 非法输入）");

        // 引号、反斜杠、换行、控制字符都必须被转义，否则产生的就是非法 JSON
        String nasty = "他说\"你好\"\\ok\n\t\u0001";
        Map<String, Object> wrapper = Json.obj();
        wrapper.put("v", nasty);
        String enc = Json.encode(wrapper);
        check("转义后不含裸的控制字符", enc.indexOf('\n') < 0 && enc.indexOf('\u0001') < 0, enc);
        Map<String, Object> rt = Json.decodeObject(enc);
        check("含引号/反斜杠/控制字符的字符串往返一致", nasty.equals(rt.get("v")),
                String.valueOf(rt.get("v")));

        Map<String, Object> cn = Json.obj();
        cn.put("room", "张三的房间");
        Map<String, Object> cnBack = Json.decodeObject(Json.encode(cn));
        check("中文往返一致", "张三的房间".equals(cnBack.get("room")),
                String.valueOf(cnBack.get("room")));

        Map<String, Object> uni = Json.decodeObject("{\"a\":\"\\u4e2d\\u6587\"}");
        check("\\uXXXX 能解码", "中文".equals(uni.get("a")), String.valueOf(uni.get("a")));

        boolean threw = false;
        try {
            Json.decode("{不是合法 JSON");
        } catch (JsonException e) {
            threw = true;
        }
        check("非法 JSON 抛 JsonException", threw, "");

        Map<String, Object> nested = Json.decodeObject(
                "{\"a\":[1,2.5,{\"b\":false}],\"c\":null}");
        check("嵌套数组/对象能解析",
                nested.get("a") instanceof List && ((List<?>) nested.get("a")).size() == 3,
                String.valueOf(nested.get("a")));
        check("小数解析成 2.5",
                ((Number) ((List<?>) nested.get("a")).get(1)).doubleValue() == 2.5,
                String.valueOf(((List<?>) nested.get("a")).get(1)));
    }

    // ══════════════════════════════════════════════════════════
    // §2 静态资源
    // ══════════════════════════════════════════════════════════

    private static void testStaticAssets() throws Exception {
        section("2. 静态资源（协议 §2.1）");

        HttpGameServer server = DesktopServer.startHttpOnly("测试房间", "张三",
                new DesktopServer.FileAssetSource(new File(ASSET_ROOT)));
        try {
            DesktopServer.RawHttp http = new DesktopServer.RawHttp(server.getPort());

            // §2.6 健康检查
            DesktopServer.Resp h = http.get("/api/health");
            check("GET /api/health → 200", h.status == 200, "status=" + h.status);
            Map<String, Object> hm = Json.decodeObject(h.body);
            check("health.ok = true", Json.boolVal(hm, "ok", false), h.body);
            check("health.version = 1", Json.intVal(hm, "version", -1) == 1, h.body);

            // §2.2 房间信息
            DesktopServer.Resp room = http.get("/api/room");
            Map<String, Object> rm = Json.decodeObject(room.body);
            check("room 返回房间名", "测试房间".equals(Json.str(rm, "room", "")), room.body);
            check("room 返回主机名", "张三".equals(Json.str(rm, "host", "")), room.body);
            check("room 返回实际端口", Json.intVal(rm, "port", -1) == server.getPort(), room.body);
            check("room.players 初始为 1", Json.intVal(rm, "players", -1) == 1, room.body);
            check("room.started 初始为 false", !Json.boolVal(rm, "started", true), room.body);
            check("room.version = 1", Json.intVal(rm, "version", -1) == 1, room.body);

            byte[] indexBytes = Files.readAllBytes(new File(ASSET_ROOT, "index.html").toPath());
            String indexText = new String(indexBytes, Charset.forName("UTF-8"));

            DesktopServer.Resp root = http.get("/");
            check("GET / → 200", root.status == 200, "status=" + root.status);
            check("GET / 返回的就是 index.html",
                    root.body.equals(indexText), "长度 " + root.body.length() + " vs " + indexText.length());
            check("GET / 的 Content-Type 是 text/html",
                    ct(root).startsWith("text/html"), ct(root));
            check("GET / 带 charset=utf-8", ct(root).contains("charset=utf-8"), ct(root));
            check("GET / 有 Cache-Control: no-store",
                    "no-store".equals(root.headers.get("cache-control")),
                    String.valueOf(root.headers.get("cache-control")));
            check("GET / 有 Access-Control-Allow-Origin: *",
                    "*".equals(root.headers.get("access-control-allow-origin")),
                    String.valueOf(root.headers.get("access-control-allow-origin")));
            check("GET / 有 Content-Length 且与实际字节数一致",
                    String.valueOf(root.body.getBytes(Charset.forName("UTF-8")).length)
                            .equals(root.headers.get("content-length")),
                    String.valueOf(root.headers.get("content-length")));

            DesktopServer.Resp idx = http.get("/index.html");
            check("GET /index.html 与 / 一致", idx.body.equals(root.body),
                    "长度 " + idx.body.length());

            byte[] cssBytes = Files.readAllBytes(new File(ASSET_ROOT, "style.css").toPath());
            DesktopServer.Resp css = http.get("/style.css");
            check("GET /style.css → 200", css.status == 200, "status=" + css.status);
            check("style.css 的 Content-Type 是 text/css",
                    ct(css).startsWith("text/css"), ct(css));
            check("style.css 内容正确",
                    css.body.equals(new String(cssBytes, Charset.forName("UTF-8"))),
                    "长度 " + css.body.length() + " vs " + cssBytes.length);

            DesktopServer.Resp screens = http.get("/screens.css");
            check("GET /screens.css → 200 且是 text/css",
                    screens.status == 200 && ct(screens).startsWith("text/css"), ct(screens));

            byte[] jsBytes = Files.readAllBytes(new File(new File(ASSET_ROOT, "dist"), "bundle.js").toPath());
            DesktopServer.Resp js = http.get("/dist/bundle.js");
            check("GET /dist/bundle.js → 200", js.status == 200, "status=" + js.status);
            check("bundle.js 的 Content-Type 是 application/javascript",
                    ct(js).startsWith("application/javascript"), ct(js));
            check("bundle.js 内容正确",
                    js.body.equals(new String(jsBytes, Charset.forName("UTF-8"))),
                    "长度 " + js.body.length() + " vs " + jsBytes.length);

            // §2.1 单页应用兜底
            DesktopServer.Resp fallback = http.get("/some/deep/route");
            check("未知路径兜底回 index.html",
                    fallback.body.equals(indexText), "长度 " + fallback.body.length());

            DesktopServer.Resp unknownApi = http.get("/api/nope");
            check("未知 /api/* 返回 404 且不是 HTML",
                    unknownApi.status == 404 && unknownApi.body.contains("unknown-api"),
                    unknownApi.status + " " + unknownApi.body);

            // §2.5 写操作必须 POST（GET 能被 <img src> 打出去）
            DesktopServer.Resp getLeave = http.get("/api/leave?who=guest");
            check("GET /api/leave 被拒（405）", getLeave.status == 405,
                    "status=" + getLeave.status + " body=" + getLeave.body);

            // 长轮询没有新消息且 timeout=0 时立刻回空
            long t0 = System.nanoTime();
            DesktopServer.Resp empty = http.get("/api/poll?who=host&since=0&timeout=0");
            long ms = (System.nanoTime() - t0) / 1000000L;
            Map<String, Object> em = Json.decodeObject(empty.body);
            check("timeout=0 的 poll 立刻返回空数组",
                    Json.boolVal(em, "ok", false) && ms < 400,
                    ms + "ms " + empty.body);
            check("空 poll 的 now = 0", Json.intVal(em, "now", -1) == 0, empty.body);
        } finally {
            server.stop();
        }
    }

    // ══════════════════════════════════════════════════════════
    // §2.3 §2.4 消息中继 / seq / 长轮询
    // ══════════════════════════════════════════════════════════

    private static void testMessaging() throws Exception {
        section("3. 消息中继 + seq + 长轮询（协议 §2.3 §2.4）");

        HttpGameServer server = DesktopServer.startHttpOnly("测试房间", "张三",
                new DesktopServer.FileAssetSource(new File(ASSET_ROOT)));
        try {
            DesktopServer.RawHttp http = new DesktopServer.RawHttp(server.getPort());

            // 双方先"报到"：客人一进来就 poll，主机也在 poll
            http.get("/api/poll?who=guest&since=0&timeout=0");
            http.get("/api/poll?who=host&since=0&timeout=0");

            // ── 主机发，客人收 ──
            DesktopServer.Resp send0 = http.post("/api/send?who=host",
                    "{\"t\":\"act\",\"a\":{\"k\":\"a\"}}");
            Map<String, Object> s0 = Json.decodeObject(send0.body);
            check("host 的第一条消息 seq = 0",
                    Json.boolVal(s0, "ok", false) && Json.intVal(s0, "seq", -1) == 0, send0.body);

            DesktopServer.Resp pollGuest = http.get("/api/poll?who=guest&since=0&timeout=3000");
            Map<String, Object> pg = Json.decodeObject(pollGuest.body);
            check("guest 能收到 host 发的消息",
                    Json.boolVal(pg, "ok", false)
                            && pg.get("msgs") instanceof List
                            && ((List<?>) pg.get("msgs")).size() == 1, pollGuest.body);
            Map<String, Object> m0 = firstMsg(pg);
            check("消息带 seq = 0", Json.intVal(m0, "seq", -1) == 0, pollGuest.body);
            check("消息 from = host", "host".equals(Json.str(m0, "from", "")), pollGuest.body);
            check("消息 msg.t = act",
                    "act".equals(Json.str(asMap(m0.get("msg")), "t", "")), pollGuest.body);
            check("poll 的 now 反映总条数 = 1", Json.intVal(pg, "now", -1) == 1, pollGuest.body);

            // ── 客人发，主机收 ──
            DesktopServer.Resp send1 = http.post("/api/send?who=guest",
                    "{\"t\":\"act\",\"a\":{\"k\":\"p\",\"s\":1,\"i\":7}}");
            Map<String, Object> s1 = Json.decodeObject(send1.body);
            check("guest 的消息 seq = 1", Json.intVal(s1, "seq", -1) == 1, send1.body);

            // 再补两条，验证 seq 连续 + 顺序
            http.post("/api/send?who=host", "{\"t\":\"hash\",\"step\":8,\"h\":\"deadbeef\"}");
            http.post("/api/send?who=guest", "{\"t\":\"ping\"}");

            DesktopServer.Resp all = http.get("/api/poll?who=host&since=0&timeout=3000");
            Map<String, Object> am = Json.decodeObject(all.body);
            List<?> msgs = (List<?>) am.get("msgs");
            check("since=0 能取回全部 4 条", msgs != null && msgs.size() == 4, all.body);
            boolean seqOk = true;
            StringBuilder seqSeen = new StringBuilder();
            for (int i = 0; i < (msgs == null ? 0 : msgs.size()); i++) {
                int seq = Json.intVal(asMap(msgs.get(i)), "seq", -1);
                seqSeen.append(seq).append(' ');
                if (seq != i) seqOk = false;
            }
            check("seq 从 0 开始且连续递增", seqOk, "实际: " + seqSeen);
            check("顺序是 host,guest,host,guest",
                    msgs != null
                            && "host".equals(Json.str(asMap(msgs.get(0)), "from", ""))
                            && "guest".equals(Json.str(asMap(msgs.get(1)), "from", ""))
                            && "host".equals(Json.str(asMap(msgs.get(2)), "from", ""))
                            && "guest".equals(Json.str(asMap(msgs.get(3)), "from", "")),
                    all.body);
            check("消息体原样中继（hash 的 h 字段）",
                    "deadbeef".equals(Json.str(asMap(asMap(msgs.get(2)).get("msg")), "h", "")),
                    all.body);

            // since 语义：只拿 >= since 的
            DesktopServer.Resp rest = http.get("/api/poll?who=host&since=3&timeout=0");
            Map<String, Object> rsm = Json.decodeObject(rest.body);
            List<?> restMsgs = (List<?>) rsm.get("msgs");
            check("since=3 只返回 seq>=3 的消息",
                    restMsgs != null && restMsgs.size() == 1
                            && Json.intVal(asMap(restMsgs.get(0)), "seq", -1) == 3,
                    rest.body);
            check("now 反映总条数 4", Json.intVal(rsm, "now", -1) == 4, rest.body);

            DesktopServer.Resp beyond = http.get("/api/poll?who=host&since=99&timeout=0");
            Map<String, Object> bm = Json.decodeObject(beyond.body);
            check("since 超过总数时返回空数组",
                    ((List<?>) bm.get("msgs")).isEmpty(), beyond.body);

            // §2.3 坏 body
            DesktopServer.Resp bad = http.post("/api/send?who=host", "{不是JSON");
            check("非法 JSON body → 400", bad.status == 400, bad.status + " " + bad.body);
            DesktopServer.Resp emptyBody = http.post("/api/send?who=host", null);
            check("空 body → 400", emptyBody.status == 400,
                    emptyBody.status + " " + emptyBody.body);

            // ── 长轮询：没有消息时必须挂住 ──
            long t0 = System.nanoTime();
            DesktopServer.Resp hung = http.get("/api/poll?who=host&since=4&timeout=800&", 15000);
            long hungMs = (System.nanoTime() - t0) / 1000000L;
            Map<String, Object> hm = Json.decodeObject(hung.body);
            check("无新消息时 poll 确实挂起（> 500ms）", hungMs > 500, hungMs + "ms");
            check("挂起期间没有忙等（不会超过 timeout 太多）", hungMs < 2500, hungMs + "ms");
            check("挂起到点后返回空数组",
                    Json.boolVal(hm, "ok", false) && ((List<?>) hm.get("msgs")).isEmpty(),
                    hung.body);

            // ── 长轮询：有新消息时必须立刻返回 ──
            final DesktopServer.RawHttp bg = new DesktopServer.RawHttp(server.getPort());
            final AtomicReference<DesktopServer.Resp> polled = new AtomicReference<DesktopServer.Resp>();
            final AtomicReference<Long> pollMs = new AtomicReference<Long>();
            final CountDownLatch started = new CountDownLatch(1);

            Thread poller = new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        started.countDown();
                        long a = System.nanoTime();
                        polled.set(bg.get("/api/poll?who=guest&since=4&timeout=20000", 25000));
                        pollMs.set((System.nanoTime() - a) / 1000000L);
                    } catch (Exception e) {
                        polled.set(null);
                    }
                }
            });
            poller.start();
            started.await();
            Thread.sleep(300);                     // 让长轮询真的挂上去

            long sendAt = System.nanoTime();
            http.post("/api/send?who=host", "{\"t\":\"act\",\"a\":{\"k\":\"a\"}}");
            poller.join(10000);

            long wakeMs = pollMs.get() == null ? -1 : pollMs.get();
            DesktopServer.Resp pr = polled.get();
            check("有新消息时长轮询立刻返回（< 1s）",
                    pr != null && wakeMs >= 0 && wakeMs < 1000,
                    "耗时 " + wakeMs + "ms");
            check("被唤醒的 poll 拿到了新消息",
                    pr != null && Json.decodeObject(pr.body).get("msgs") instanceof List
                            && ((List<?>) Json.decodeObject(pr.body).get("msgs")).size() == 1,
                    pr == null ? "(无响应)" : pr.body);
            check("唤醒延迟很短（< 500ms）",
                    (System.nanoTime() - sendAt) / 1000000L < 500,
                    "(粗略) " + (System.nanoTime() - sendAt) / 1000000L + "ms");
            // 长轮询被唤醒后，别再让这个线程占着端口
            poller.interrupt();

            // §2.5 /api/start
            DesktopServer.Resp st = http.post("/api/start?who=host", null);
            check("POST /api/start → ok", st.status == 200 && st.body.contains("\"ok\":true"), st.body);
            Map<String, Object> startedRoom = Json.decodeObject(http.get("/api/room").body);
            check("start 后 room.started = true",
                    Json.boolVal(startedRoom, "started", false), startedRoom.toString());

            // 客人进来后 players = 2
            check("客人出现过之后 players = 2",
                    Json.intVal(startedRoom, "players", -1) == 2, startedRoom.toString());
        } finally {
            server.stop();
        }
    }

    // ══════════════════════════════════════════════════════════
    // §2.4 peer-left（主动离开）
    // ══════════════════════════════════════════════════════════

    private static void testPeerLeftExplicit() throws Exception {
        section("4. peer-left：主动 /api/leave（协议 §2.4）");

        // 场景 1：客人离开 → 主机下一次 poll 立刻拿到 peer-left
        HttpGameServer s1 = DesktopServer.startHttpOnly("测试房间", "张三",
                new DesktopServer.FileAssetSource(new File(ASSET_ROOT)));
        try {
            DesktopServer.RawHttp http = new DesktopServer.RawHttp(s1.getPort());
            http.get("/api/poll?who=guest&since=0&timeout=0");
            http.get("/api/poll?who=host&since=0&timeout=0");
            http.post("/api/send?who=guest", "{\"t\":\"hello\",\"name\":\"李四\"}");

            DesktopServer.Resp lv = http.post("/api/leave?who=guest", null);
            check("POST /api/leave → ok", lv.status == 200 && lv.body.contains("\"ok\":true"), lv.body);

            long t0 = System.nanoTime();
            DesktopServer.Resp poll = http.get("/api/poll?who=host&since=1&timeout=20000", 25000);
            long ms = (System.nanoTime() - t0) / 1000000L;
            Map<String, Object> pm = Json.decodeObject(poll.body);
            check("客人离开后主机 poll 立刻返回 peer-left",
                    Boolean.FALSE.equals(pm.get("ok"))
                            && "peer-left".equals(Json.str(pm, "error", "")), poll.body);
            check("peer-left 是立刻返回的（不是等满 timeout）", ms < 1500, ms + "ms");

            // 离开状态是持续的，不能只报一次
            DesktopServer.Resp poll2 = http.get("/api/poll?who=host&since=1&timeout=20000", 25000);
            Map<String, Object> pm2 = Json.decodeObject(poll2.body);
            check("peer-left 会持续返回（不是一次性）",
                    "peer-left".equals(Json.str(pm2, "error", "")), poll2.body);
        } finally {
            s1.stop();
        }

        // 场景 2：主机离开 → 客人下一次 poll 拿到 peer-left
        HttpGameServer s2 = DesktopServer.startHttpOnly("测试房间", "张三",
                new DesktopServer.FileAssetSource(new File(ASSET_ROOT)));
        try {
            DesktopServer.RawHttp http = new DesktopServer.RawHttp(s2.getPort());
            http.get("/api/poll?who=host&since=0&timeout=0");
            http.get("/api/poll?who=guest&since=0&timeout=0");
            http.post("/api/leave?who=host", null);

            DesktopServer.Resp poll = http.get("/api/poll?who=guest&since=0&timeout=20000", 25000);
            Map<String, Object> pm = Json.decodeObject(poll.body);
            check("主机离开后客人 poll 立刻返回 peer-left",
                    Boolean.FALSE.equals(pm.get("ok"))
                            && "peer-left".equals(Json.str(pm, "error", "")), poll.body);
        } finally {
            s2.stop();
        }

        // 场景 3：没人对局时（只有自己）不该误报 peer-left —— 否则一开房就"对手已离开"
        HttpGameServer s3 = DesktopServer.startHttpOnly("测试房间", "张三",
                new DesktopServer.FileAssetSource(new File(ASSET_ROOT)));
        try {
            DesktopServer.RawHttp http = new DesktopServer.RawHttp(s3.getPort());
            DesktopServer.Resp poll = http.get("/api/poll?who=host&since=0&timeout=600", 15000);
            Map<String, Object> pm = Json.decodeObject(poll.body);
            check("大厅里一个人时不会误报 peer-left",
                    Json.boolVal(pm, "ok", false), poll.body);
        } finally {
            s3.stop();
        }

        // 场景 4：双方都在长轮询等待时，不该把对方误判成掉线
        // （这是 peer-left 最容易写错的地方：一端正在挂 20 秒的 poll，另一端就以为它没了）
        HttpGameServer s4 = DesktopServer.startHttpOnly("测试房间", "张三",
                new DesktopServer.FileAssetSource(new File(ASSET_ROOT)));
        try {
            final DesktopServer.RawHttp http = new DesktopServer.RawHttp(s4.getPort());
            final AtomicReference<DesktopServer.Resp> guestPoll = new AtomicReference<DesktopServer.Resp>();
            Thread guestThread = new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        guestPoll.set(http.get("/api/poll?who=guest&since=0&timeout=6000", 20000));
                    } catch (Exception ignored) {
                    }
                }
            });
            guestThread.start();
            Thread.sleep(200);

            DesktopServer.Resp hostPoll = http.get("/api/poll?who=host&since=0&timeout=6000", 20000);
            Map<String, Object> hp = Json.decodeObject(hostPoll.body);
            check("对方正在长轮询时，自己不会误收 peer-left",
                    Json.boolVal(hp, "ok", false), hostPoll.body);
            guestThread.join(10000);
            check("对方的长轮询是正常返回（空数组）而不是 peer-left",
                    guestPoll.get() != null
                            && Json.boolVal(Json.decodeObject(guestPoll.get().body), "ok", false),
                    guestPoll.get() == null ? "(无响应)" : guestPoll.get().body);
        } finally {
            s4.stop();
        }
    }

    // ══════════════════════════════════════════════════════════
    // §5 peer-left（超时判定）
    // ══════════════════════════════════════════════════════════

    private static void testPeerLeftTimeout() throws Exception {
        section("5. peer-left：15 秒没有任何请求（协议 §5 要求）");

        // 这里必须真等 15 秒以上 —— 协议写死的时间常数，改不动也不该改。
        HttpGameServer s = DesktopServer.startHttpOnly("测试房间", "张三",
                new DesktopServer.FileAssetSource(new File(ASSET_ROOT)));
        try {
            DesktopServer.RawHttp http = new DesktopServer.RawHttp(s.getPort());
            http.get("/api/poll?who=host&since=0&timeout=0");       // 主机报到
            http.post("/api/send?who=guest", "{\"t\":\"hello\"}");  // 客人报到后就没动静了

            long t0 = System.nanoTime();
            // timeout 给足，让服务端有时间在挂起期间完成超时判定
            DesktopServer.Resp poll = http.get("/api/poll?who=host&since=1&timeout=20000", 30000);
            long ms = (System.nanoTime() - t0) / 1000000L;
            Map<String, Object> pm = Json.decodeObject(poll.body);
            check("对方静默超时后 poll 返回 peer-left",
                    Boolean.FALSE.equals(pm.get("ok"))
                            && "peer-left".equals(Json.str(pm, "error", "")),
                    poll.body + "  (耗时 " + ms + "ms)");
            check("超时判定不早于 15 秒", ms >= 14000, ms + "ms");
            check("超时判定不会拖太久（< 20 秒）", ms < 20000, ms + "ms");
        } finally {
            s.stop();
        }
    }

    // ══════════════════════════════════════════════════════════
    // §6 UDP 房间发现
    // ══════════════════════════════════════════════════════════

    private static void testDiscovery() throws Exception {
        section("6. UDP 房间发现（协议 §6）");

        if (!NetUtil.isUdpPortFree(RoomDiscovery.DISCOVER_PORT)) {
            check("UDP " + RoomDiscovery.DISCOVER_PORT + " 可用（本机已被别的进程占用，跳过）",
                    true, "SKIPPED");
            return;
        }

        HttpGameServer server = DesktopServer.startHttpOnly("张三的房间", "张三",
                new DesktopServer.FileAssetSource(new File(ASSET_ROOT)));
        RoomResponder responder = null;
        try {
            responder = new RoomResponder("张三的房间", "张三", server.getPort());
            responder.start();

            long t0 = System.nanoTime();
            List<DiscoveredRoom> rooms = RoomDiscovery.scan(1500);
            long ms = (System.nanoTime() - t0) / 1000000L;

            check("扫描能发现本机的应答器", rooms.size() >= 1,
                    "收到 " + rooms.size() + " 个房间，耗时 " + ms + "ms");
            if (rooms.isEmpty()) return;

            DiscoveredRoom r = null;
            for (DiscoveredRoom x : rooms) {
                if (x.port == server.getPort()) r = x;
            }
            check("发现的房间端口与 HTTP 服务一致",
                    r != null, "期望 port=" + server.getPort() + "，实际 " + describe(rooms));
            if (r == null) r = rooms.get(0);

            check("房间名正确", "张三的房间".equals(r.room), r.room);
            check("主机名正确", "张三".equals(r.host), r.host);
            check("ip 是局域网地址（不是空的）", r.ip != null && !r.ip.isEmpty(), r.ip);
            check("started 初始为 false", !r.started, String.valueOf(r.started));
            check("version = 1", r.version == 1, String.valueOf(r.version));
            check("players >= 1", r.players >= 1, String.valueOf(r.players));
            check("扫描耗时接近 1500ms 窗口（不是立刻返回）",
                    ms >= 1200 && ms < 4000, ms + "ms");

            // 去重：同一台机器多网卡/多广播地址会回多份，必须按 ip:port 去重
            boolean dup = false;
            for (int i = 0; i < rooms.size(); i++) {
                for (int j = i + 1; j < rooms.size(); j++) {
                    if (rooms.get(i).key().equals(rooms.get(j).key())) dup = true;
                }
            }
            check("结果按 ip:port 去重", !dup, describe(rooms));

            // started 变化要能反映到应答里（协议 §6：开局后客人应看到"已开始"）
            responder.setStarted(true);
            List<DiscoveredRoom> again = RoomDiscovery.scan(1500);
            boolean sawStarted = false;
            for (DiscoveredRoom x : again) {
                if (x.port == server.getPort() && x.started) sawStarted = true;
            }
            check("开局后应答里 started = true", sawStarted, describe(again));

            // 应答 JSON 的字段名必须和协议一致（JS 按字段名解析）
            String json = rooms.get(0).toJson();
            Map<String, Object> jm = Json.decodeObject(json);
            check("应答 JSON 带 t=room", "room".equals(Json.str(jm, "t", "")), json);
            check("应答 JSON 带 room/host/ip/port/players/started/version",
                    jm.containsKey("room") && jm.containsKey("host") && jm.containsKey("ip")
                            && jm.containsKey("port") && jm.containsKey("players")
                            && jm.containsKey("started") && jm.containsKey("version"), json);

            // 停掉应答器后，列表里不该再有这个房间（否则会残留死房间）
            responder.stop();
            responder = null;
            Thread.sleep(200);
            List<DiscoveredRoom> after = RoomDiscovery.scan(1200);
            boolean stillThere = false;
            for (DiscoveredRoom x : after) {
                if (x.port == server.getPort()) stillThere = true;
            }
            check("停掉应答器后不再被扫描到", !stillThere, describe(after));
        } finally {
            if (responder != null) responder.stop();
            server.stop();
        }

        // 协议 §6：非 KAPAI_DISCOVER/1 的包必须被无视，不能瞎应答
        check("探测魔法串与协议一致",
                "KAPAI_DISCOVER/1".equals(RoomDiscovery.MAGIC), RoomDiscovery.MAGIC);
        check("发现端口与协议一致（8766）",
                RoomDiscovery.DISCOVER_PORT == 8766,
                String.valueOf(RoomDiscovery.DISCOVER_PORT));

        // 端口占用时往上找（协议 §2）
        java.net.ServerSocket blocker = new java.net.ServerSocket();
        blocker.setReuseAddress(true);
        blocker.bind(new java.net.InetSocketAddress(HttpGameServer.DEFAULT_PORT));
        try {
            check("8765 被占用时能找到下一个可用端口",
                    !NetUtil.isPortFree(HttpGameServer.DEFAULT_PORT)
                            && NetUtil.findFreePort(HttpGameServer.DEFAULT_PORT, 10)
                            == HttpGameServer.DEFAULT_PORT + 1,
                    "findFreePort → " + NetUtil.findFreePort(HttpGameServer.DEFAULT_PORT, 10));

            HttpGameServer srv2 = new HttpGameServer(
                    new DesktopServer.FileAssetSource(new File(ASSET_ROOT)), "测试", "张三");
            int p2 = srv2.start();
            try {
                check("start() 在 8765 被占时自动上移端口",
                        p2 == HttpGameServer.DEFAULT_PORT + 1, "实际端口 " + p2);
                DesktopServer.RawHttp h2 = new DesktopServer.RawHttp(p2);
                check("上移后的端口真的在服务",
                        h2.get("/api/health").status == 200, "");
                Map<String, Object> rm = Json.decodeObject(h2.get("/api/room").body);
                check("room 里的 port 是上移后的端口",
                        Json.intVal(rm, "port", -1) == p2, rm.toString());
            } finally {
                srv2.stop();
            }
        } finally {
            blocker.close();
        }
        check("8765 释放后又能被找到", NetUtil.isPortFree(HttpGameServer.DEFAULT_PORT), "");
    }

    // ══════════════════════════════════════════════════════════
    // §8 WebSocket 推送通道
    // ══════════════════════════════════════════════════════════

    /**
     * 手写的 RFC 6455 必须用**真 socket** 测 —— 它是二进制帧协议，
     * 拿浏览器或者 fetch 都验不到握手算法和掩码解码是否正确。
     *
     * 握手那一步用的是 RFC 文档里的官方示例 key/accept 对，
     * 所以「算错了」会被直接抓出来，而不会被自己的实现对冲掉。
     */
    private static void testWebSocket() throws Exception {
        section("8. WebSocket 推送通道（协议 §2.7）");

        HttpGameServer server = DesktopServer.startHttpOnly("测试房间", "张三",
                new DesktopServer.FileAssetSource(new File(ASSET_ROOT)));
        try {
            int port = server.getPort();
            Socket sock = new Socket("127.0.0.1", port);
            sock.setSoTimeout(6000);
            OutputStream out = sock.getOutputStream();
            InputStream in = sock.getInputStream();

            // RFC 6455 §1.3 的官方示例
            String key = "dGhlIHNhbXBsZSBub25jZQ==";
            String req = "GET /ws?who=guest&since=0 HTTP/1.1\r\n"
                    + "Host: 127.0.0.1:" + port + "\r\n"
                    + "Upgrade: websocket\r\n"
                    + "Connection: Upgrade\r\n"
                    + "Sec-WebSocket-Key: " + key + "\r\n"
                    + "Sec-WebSocket-Version: 13\r\n"
                    + "\r\n";
            out.write(req.getBytes("UTF-8"));
            out.flush();

            String head = readHttpHead(in);
            check("握手返回 101 Switching Protocols", head.startsWith("HTTP/1.1 101"), head);
            check("Sec-WebSocket-Accept 与 RFC 示例值一致（校验 SHA-1+Base64 实现）",
                    head.contains("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="), head);

            DesktopServer.RawHttp http = new DesktopServer.RawHttp(port);

            // 主机发一条 → 已经挂着的 WS 应当**立刻**收到文本帧
            http.post("/api/send?who=host", "{\"t\":\"hello\",\"name\":\"张三\"}");
            String f1 = readWsText(in);
            check("WS 能把新消息推成文本帧", f1 != null && f1.contains("\"hello\""), String.valueOf(f1));
            check("推的帧里带 seq=0", f1 != null && f1.contains("\"seq\":0"), String.valueOf(f1));
            check("推的帧里带 from=host", f1 != null && f1.contains("\"from\":\"host\""), String.valueOf(f1));

            // 第二条要能接着推（验证它是「一直等新消息」，不是只推一次就退出）
            http.post("/api/send?who=host", "{\"t\":\"start\",\"seed\":7}");
            String f2 = readWsText(in);
            check("第二条消息接着推过来", f2 != null && f2.contains("\"start\""), String.valueOf(f2));

            // 自己发的消息不该推回给自己（否则本地会重复执行一次）
            http.post("/api/send?who=guest", "{\"t\":\"act\",\"a\":{\"k\":\"a\"}}");
            http.post("/api/send?who=host", "{\"t\":\"hash\",\"step\":1}");
            String f3 = readWsText(in);
            check("把自己发的消息过滤掉（只推对方的）",
                    f3 != null && f3.contains("\"hash\"") && !f3.contains("\"act\""), String.valueOf(f3));

            // 客户端 ping（带掩码）→ 服务端必须回 pong
            writeWsMasked(out, 0x9, new byte[0]);
            WsFrame pong = readWsRaw(in);
            check("客户端 ping → 服务端回 pong",
                    pong != null && pong.opcode == 0xA, pong == null ? "null" : ("opcode=" + pong.opcode));

            // 长轮询那条路**没有被破坏**：换成一端用 /api/poll 仍然拿得到同样的消息
            DesktopServer.Resp pollHost = http.get("/api/poll?who=host&since=0&timeout=1000");
            Map<String, Object> ph = Json.decodeObject(pollHost.body);
            check("WebSocket 上线后长轮询仍然可用（回落路径没坏）",
                    Json.boolVal(ph, "ok", false) && ph.get("msgs") instanceof List
                            && ((List<?>) ph.get("msgs")).size() >= 2, pollHost.body);

            NetUtil.closeQuietly(in);
            NetUtil.closeQuietly(out);
            NetUtil.closeQuietly(sock);
        } finally {
            server.stop();
        }
    }

    // ── WebSocket 测试用的小工具（客户端侧）──────────────

    private static final class WsFrame {
        int opcode;
        byte[] payload = new byte[0];
        String text;
    }

    /** 读到 `\r\n\r\n` 为止，返回整个响应头（状态行 + 各字段 + 结尾空行） */
    private static String readHttpHead(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        while (true) {
            int c = in.read();
            if (c < 0) break;
            sb.append((char) c);
            int n = sb.length();
            // ⚠ 不能在第一个 \r\n 就断：那是**状态行**的结尾。
            //   响应头要读到连续的空行才算完，否则剩下的字段会被当成 WS 帧读走。
            if (n >= 4 && sb.charAt(n - 4) == '\r' && sb.charAt(n - 3) == '\n'
                    && sb.charAt(n - 2) == '\r' && sb.charAt(n - 1) == '\n') {
                break;
            }
        }
        return sb.toString();
    }

    private static int readByteOrThrow(InputStream in) throws IOException {
        int v = in.read();
        if (v < 0) throw new EOFException("对端关闭");
        return v;
    }

    /** 读一个帧。服务端发来的帧按规范不加掩码。 */
    private static WsFrame readWsRaw(InputStream in) throws IOException {
        int b0 = in.read();
        if (b0 < 0) return null;
        int b1 = readByteOrThrow(in);
        WsFrame f = new WsFrame();
        f.opcode = b0 & 0x0F;
        long len = b1 & 0x7F;
        if (len == 126) {
            len = ((long) readByteOrThrow(in) << 8) | readByteOrThrow(in);
        } else if (len == 127) {
            len = 0;
            for (int i = 0; i < 8; i++) len = (len << 8) | readByteOrThrow(in);
        }
        byte[] p = new byte[(int) len];
        int r = 0;
        while (r < p.length) {
            int k = in.read(p, r, p.length - r);
            if (k < 0) throw new EOFException("帧不完整");
            r += k;
        }
        f.payload = p;
        if (f.opcode == 0x1) f.text = new String(p, "UTF-8");
        return f;
    }

    /** 读下一个**文本**帧，跳过 ping/pong（服务端每 20 秒 ping 一次） */
    private static String readWsText(InputStream in) throws IOException {
        for (int i = 0; i < 8; i++) {
            WsFrame f = readWsRaw(in);
            if (f == null) return null;
            if (f.opcode == 0x1) return f.text;
            if (f.opcode == 0x8) return null;
        }
        return null;
    }

    /** 客户端发帧**必须加掩码**（RFC 6455 §5.3）；顺便验证服务端能正确解掩码 */
    private static void writeWsMasked(OutputStream out, int opcode, byte[] payload) throws IOException {
        byte[] mask = new byte[] { 0x12, 0x34, 0x56, 0x78 };
        byte[] masked = new byte[payload.length];
        for (int i = 0; i < payload.length; i++) masked[i] = (byte) (payload[i] ^ mask[i & 3]);
        out.write(0x80 | opcode);
        out.write(0x80 | payload.length);
        out.write(mask);
        out.write(masked);
        out.flush();
    }

    // ══════════════════════════════════════════════════════════
    // 断言与输出
    // ══════════════════════════════════════════════════════════

    private static void section(String title) {
        System.out.println();
        System.out.println("── " + title + " ──────────────────────────");
    }

    private static void check(String label, boolean ok, String detail) {
        if (ok) {
            passed++;
            System.out.println("  OK   " + label);
        } else {
            failed++;
            failures.add(label + "   [" + detail + "]");
            System.out.println("  FAIL " + label + "   [" + detail + "]");
        }
    }

    private static String ct(DesktopServer.Resp r) {
        String v = r.headers.get("content-type");
        return v == null ? "(缺 Content-Type)" : v;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object o) {
        return o instanceof Map ? (Map<String, Object>) o : Json.obj();
    }

    private static Map<String, Object> firstMsg(Map<String, Object> pollResult) {
        Object list = pollResult.get("msgs");
        if (!(list instanceof List) || ((List<?>) list).isEmpty()) return Json.obj();
        return asMap(((List<?>) list).get(0));
    }

    private static String describe(List<DiscoveredRoom> rooms) {
        StringBuilder sb = new StringBuilder();
        for (DiscoveredRoom r : rooms) {
            sb.append('[').append(r.room).append('@').append(r.key())
                    .append(" started=").append(r.started).append(']');
        }
        return sb.length() == 0 ? "(空)" : sb.toString();
    }
}
