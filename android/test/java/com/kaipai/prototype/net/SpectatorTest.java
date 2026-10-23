package com.kaipai.prototype.net;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 局域网服务的**观战**用例（作者 2026-10-23）。
 *
 * 为什么要有这个桌面测试：net/ 是纯 Java、不含任何 Android 类，所以能直接在
 * 开发机 JVM 上把真服务拉起来、用真 HTTP 打一遍。观战这条链路最容易出的错
 * 都是「服务端语义」而不是界面：
 *   · 观战者发消息 → 必须 403（否则能往锁步流里插操作，两端立刻分叉）
 *   · 观战者来 / 走 → 不能影响两端的 peer-left（否则「有人进来观战，双方都掉线」）
 *   · 两端都离开 → 观战者才收到 peer-left
 *
 * 跑法（不需要 Android SDK）：
 *   javac -encoding UTF-8 -d /tmp/jt android/app/java/com/kaipai/prototype/net/*.java \
 *         android/test/java/com/kaipai/prototype/net/SpectatorTest.java
 *   java -cp /tmp/jt com.kaipai.prototype.net.SpectatorTest
 */
public final class SpectatorTest {

    private static int pass = 0;
    private static int fail = 0;
    private static String base = "";

    public static void main(String[] args) throws Exception {
        AssetSource assets = new AssetSource() {
            @Override public byte[] read(String path) { return null; }
            @Override public boolean exists(String path) { return false; }
        };
        HttpGameServer server = new HttpGameServer(assets, "测试房间", "房主");
        int port = server.start();
        server.awaitReady(3000);
        base = "http://127.0.0.1:" + port;

        try {
            run();
        } finally {
            server.stop();
        }

        System.out.println();
        System.out.println("----------------------------------------------------");
        if (fail > 0) {
            System.out.println("❌ 失败 " + fail + " 项 / 通过 " + pass + " 项");
            System.exit(1);
        }
        System.out.println("✅ 局域网观战测试全部通过：" + pass + " 项");
    }

    private static void run() throws Exception {
        section("1. 两端照常：消息只推给对方");
        send("host", "{\"t\":\"hello\",\"name\":\"房主\"}");
        send("guest", "{\"t\":\"hello\",\"name\":\"客人\"}");
        String hostView = poll("host", 0, "w0");
        ok("房主收到客人的 hello", hostView.contains("客人"), hostView);
        /**
         * ⚠ 局域网服务端**不过滤**自己发的消息（日志按 seq 全存，两端各自按 from 过滤，
         * 见 multiplayer.js 的 loop / onWsMessage）。这一条断言的是这个既有约定，
         * 别把它"修"成服务端过滤 —— 那会让 WebSocket 与长轮询两条路的行为不一致。
         */
        ok("服务端保留全部消息（自己发的也在，由客户端按 from 过滤）", hostView.contains("\"from\":\"host\""), hostView);

        section("2. 观战者：看得见两端，发不出去");
        String watchView = poll("watch", 0, "w1");
        ok("观战者同时拿到两条消息", watchView.contains("房主") && watchView.contains("客人"), watchView);
        Reply denied = send("watch", "{\"t\":\"act\",\"a\":{\"k\":\"p\"},\"n\":0}");
        ok("观战者发消息被拒（403 read-only）", denied.status == 403 && denied.body.contains("read-only"), denied.status + " " + denied.body);
        String watchAgain = poll("watch", 0, "w1");
        ok("被拒的消息没进日志（还是两条）", countMsgs(watchAgain) == 2, watchAgain);
        String info = get("/api/room");
        ok("房间信息带观战人数", info.contains("\"watchers\":1"), info);

        section("3. 观战者不影响两端的在线判断");
        ok("有人观战时房主照常收到消息", poll("host", 0, "w0").contains("\"ok\":true"));
        leave("watch", "w1");
        ok("观战者离开后房间仍可查（人数归零）", get("/api/room").contains("\"watchers\":0"));

        section("4. 两端都走了，观战者才结束");
        leave("guest", "");
        String w2 = poll("watch", 0, "w2");
        ok("只有客人离开时观战者继续看", w2.contains("\"ok\":true"), w2);
        leave("host", "");
        String w3 = poll("watch", 0, "w2");
        ok("两端都走了观战者收到 peer-left", w3.contains("peer-left"), w3);

        section("5. 观战者不能替别人开局");
        String st = post("/api/start?who=watch", null);
        ok("观战者的 /api/start 被忽略", st.contains("\"ignored\":true"), st);
    }

    // ── 小工具 ─────────────────────────────────────────────

    private static final class Reply {
        int status;
        String body;
    }

    private static void section(String t) {
        System.out.println();
        System.out.println("── " + t);
    }

    private static void ok(String name, boolean cond) { ok(name, cond, ""); }

    private static void ok(String name, boolean cond, String extra) {
        if (cond) { pass++; System.out.println("  ✓ " + name); }
        else { fail++; System.out.println("  ✗ " + name + (extra.isEmpty() ? "" : "  —— " + extra)); }
    }

    /** 数一下响应里 msgs 数组有几条（够用的土办法：数 "seq"） */
    private static int countMsgs(String body) {
        int n = 0;
        int i = 0;
        while ((i = body.indexOf("\"seq\"", i)) >= 0) { n++; i += 5; }
        return n;
    }

    private static String get(String path) throws Exception {
        return request("GET", path, null).body;
    }

    private static String post(String path, String body) throws Exception {
        return request("POST", path, body == null ? "{}" : body).body;
    }

    private static Reply send(String who, String json) throws Exception {
        return request("POST", "/api/send?who=" + who, json);
    }

    private static String poll(String who, int since, String wid) throws Exception {
        return request("GET", "/api/poll?who=" + who + "&since=" + since + "&timeout=30&wid=" + wid, null).body;
    }

    private static void leave(String who, String wid) throws Exception {
        request("POST", "/api/leave?who=" + who + (wid.isEmpty() ? "" : "&wid=" + wid), "{}");
    }

    private static Reply request(String method, String path, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(3000);
        c.setReadTimeout(8000);
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream out = c.getOutputStream()) {
                out.write(body.getBytes(StandardCharsets.UTF_8));
            }
        }
        int status = c.getResponseCode();
        InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
        String text = in == null ? "" : readAll(in);
        c.disconnect();
        Reply r = new Reply();
        r.status = status;
        r.body = text;
        return r;
    }

    private static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    private SpectatorTest() { }
}
