package com.kaipai.prototype;

import android.app.Activity;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.kaipai.prototype.net.AssetSource;
import com.kaipai.prototype.net.DiscoveredRoom;
import com.kaipai.prototype.net.HttpGameServer;
import com.kaipai.prototype.net.Json;
import com.kaipai.prototype.net.NetUtil;
import com.kaipai.prototype.net.RoomDiscovery;
import com.kaipai.prototype.net.RoomResponder;

import java.io.IOException;
import java.nio.charset.Charset;
import java.util.List;
import java.util.Map;

/**
 * 暴露给网页的 {@code window.KapaiNative}。
 *
 * 几条硬性约束（踩过就知道疼）：
 *
 *  1. **返回值必须是字符串。** addJavascriptInterface 对返回类型有限制，
 *     返回对象会被包成一个不透明的 JS 对象，只能用 toString()，拿不到字段。
 *     所以这里全部返回 JSON 字符串，由 JS 侧 JSON.parse。
 *
 *  2. **这些方法不在主线程。** WebView 把它们调在 JavaBridge 线程上。
 *     好处是 scanRooms 可以安心阻塞 1.5 秒（主线程上会 ANR）；
 *     坏处是任何 UI/WebView 操作都必须 runOnUiThread 切回去。
 *
 *  3. **@JavascriptInterface 注解不能漏。** API 17 起，没有注解的方法对 JS 不可见，
 *     症状是「JS 说 KapaiNative.startHost is not a function」——不看文档很难猜到。
 *
 *  4. **内部类一律提成顶层类。** d8（build-tools 34.0.0 自带的 R8 8.2.2-dev）
 *     解析匿名内部类（class 文件里带 EnclosingMethod 属性的那些）时会内部 NPE，
 *     构建直接失败。所以这里的资源适配器与主线程任务分别是顶层类
 *     AndroidAssetSource / UiThreadTask，class 名里不含 '$'。
 */
public final class NativeBridge {

    private static final int SCAN_DEFAULT_MS = 1500;
    private static final int SCAN_MAX_MS = 10000;

    private final Activity activity;
    private final WebView web;

    private final AssetSource assets;
    private final Object lock = new Object();

    private HttpGameServer server;
    private RoomResponder responder;

    public NativeBridge(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
        this.assets = new AndroidAssetSource(activity.getAssets());
    }

    // ── JS 可调用的方法 ──────────────────────────────────────

    @JavascriptInterface
    public String isSupported() {
        // 桌面浏览器里根本没有 window.KapaiNative，JS 侧拿不到这个对象；
        // 能调到这一行就说明是在 APK 的 WebView 里
        return "true";
    }

    /**
     * 开房间：起 HTTP 服务（对方从这里加载页面）+ UDP 应答器（让对方能扫到）。
     *
     * @return {@code {"ok":true,"port":8765,"url":"http://127.0.0.1:8765/?net=host&room=..."}}
     */
    @JavascriptInterface
    public String startHost(String roomName, String hostName) {
        String room = (roomName == null || roomName.trim().isEmpty()) ? "卡牌对决" : roomName.trim();
        String host = (hostName == null || hostName.trim().isEmpty()) ? "主机" : hostName.trim();
        try {
            synchronized (lock) {
                stopLocked();     // 重复点「开房间」时先收掉旧的，否则端口会一个个被占掉

                HttpGameServer srv = new HttpGameServer(assets, room, host);
                int port = srv.start();
                srv.awaitReady(2000);

                RoomResponder rsp = new RoomResponder(room, host, port);
                try {
                    rsp.start();
                } catch (IOException e) {
                    // UDP 起不来（8766 被占）不该让整个房间开不出来：HTTP 是主链路，
                    // 只是客人扫不到，主机可以把地址念给对方。降级而不是失败。
                    rsp = null;
                }

                server = srv;
                responder = rsp;

                Map<String, Object> m = Json.obj();
                m.put("ok", Boolean.TRUE);
                m.put("port", (long) port);
                m.put("ip", NetUtil.getLocalIp());
                m.put("players", (long) srv.getPlayers());
                // 主机自己走 127.0.0.1：绕开路由器对「自己访问自己的局域网 IP」的处理差异
                m.put("url", "http://127.0.0.1:" + port + "/?net=host&room=" + urlEncode(room));
                return Json.encode(m);
            }
        } catch (IOException e) {
            Map<String, Object> m = Json.obj();
            m.put("ok", Boolean.FALSE);
            m.put("error", "端口被占用（8765 起 10 个都试过了）");
            return Json.encode(m);
        } catch (RuntimeException e) {
            Map<String, Object> m = Json.obj();
            m.put("ok", Boolean.FALSE);
            m.put("error", "开启房间失败: " + e.getClass().getSimpleName());
            return Json.encode(m);
        }
    }

    @JavascriptInterface
    public String stopHost() {
        synchronized (lock) {
            stopLocked();
        }
        return "{\"ok\":true}";
    }

    /**
     * 扫描局域网房间。**同步阻塞**，最多等 timeoutMs。
     *
     * 阻塞是刻意的：JS 侧是 `const rooms = KapaiNative.scanRooms(1500)` 这种同步调用，
     * 界面在这 1.5 秒里转个 loading 就行。
     * 之所以安全，是因为 JavaBridge 跑在自己的线程上（见类注释第 2 点）。
     */
    @JavascriptInterface
    public String scanRooms(int timeoutMs) {
        int wait = timeoutMs <= 0 ? SCAN_DEFAULT_MS : Math.min(timeoutMs, SCAN_MAX_MS);
        List<DiscoveredRoom> rooms;
        try {
            rooms = RoomDiscovery.scan(wait);
        } catch (RuntimeException e) {
            return "[]";
        }
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < rooms.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append(rooms.get(i).toJson());
        }
        sb.append(']');
        return sb.toString();
    }

    @JavascriptInterface
    public String getLocalIp() {
        try {
            String ip = NetUtil.getLocalIp();
            return ip == null ? "" : ip;
        } catch (RuntimeException e) {
            return "";
        }
    }

    /** 客人加入房间：让 WebView 导航到主机的地址（协议 §1 的页面由主机提供）。 */
    @JavascriptInterface
    public void navigate(String url) {
        if (url == null || url.isEmpty()) return;
        // WebView 只能在主线程碰。JavaBridge 线程直接 loadUrl 在部分机型上会崩或静默无效。
        // 任务体在顶层类 UiThreadTask 里（原先是匿名 Runnable，会让 d8 崩，见类注释）。
        activity.runOnUiThread(new UiThreadTask(web, url));
    }

    // ── 跨来源的存档（联机必须用）────────────────────────────
    //
    // ⚠️ 为什么不能用 localStorage：
    //   WebView 里 localStorage 是**按来源隔离**的。首页来自 file://，
    //   而联机页来自 http://主机:8765 —— 两者是两个来源，读到的是**两份不同的存档**。
    //   症状：一进联机就变成 0 金币、1 级的新账号；联机里赚的金币也回不到主存档。
    //   作者的需求是「联机影响本地金币、归零就不能和真人对决」，
    //   所以两边必须读**同一份**。改存 SharedPreferences（进程级、与来源无关）。

    private static final String PREFS = "kapai_store";
    private static final String KEY_PROFILE = "profile.v1";
    /** 回放档案。和主存档共用 SharedPreferences，理由见上面 176-180 行 */
    private static final String KEY_REPLAYS = "replays.v1";

    /** 读主存档（没有则返回空字符串，JS 侧按「还没有档案」处理） */
    @JavascriptInterface
    public String readProfile() {
        try {
            String v = activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE)
                    .getString(KEY_PROFILE, "");
            return v == null ? "" : v;
        } catch (RuntimeException e) {
            return "";
        }
    }

    /** 写主存档。返回是否成功（配额/权限问题不至于把游戏搞崩，由 JS 侧退化处理） */
    @JavascriptInterface
    public String writeProfile(String json) {
        if (json == null || json.isEmpty()) return "false";
        try {
            // apply() 是异步落盘，但同一进程内立刻读得到 —— 足够用了，
            // 而且它不会在主线程上卡 I/O。
            activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE)
                    .edit().putString(KEY_PROFILE, json).apply();
            return "true";
        } catch (RuntimeException e) {
            return "false";
        }
    }

    /**
     * 读回放档案（没有则返回空字符串，JS 侧按「还没有档案」处理）。
     *
     * 为什么回放也要放这里（作者反馈：每局打完不会生成回放）：
     * 回放原先存在 WebView 的 localStorage 里，而 localStorage 是**按来源隔离**的：
     * 首页来自 file:///android_asset/index.html，联机页来自 http://主机:8765，
     * 于是联机打完的那局回放回首页就看不到；file:// 来源在部分设备上还干脆
     * 拿不到 localStorage，只能退化到内存，关掉页面就没了。
     */
    @JavascriptInterface
    public String readReplays() {
        try {
            String v = activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE)
                    .getString(KEY_REPLAYS, "");
            return v == null ? "" : v;
        } catch (RuntimeException e) {
            return "";
        }
    }

    /** 写回放档案。返回是否成功；写不下(见下面的体积上限)返回 false，JS 侧会丢旧的一半再试 */
    @JavascriptInterface
    public String writeReplays(String json) {
        if (json == null || json.isEmpty()) return "false";
        // SharedPreferences 是把整份 XML 读进内存的，不能让回放无限长大：
        // 超过这个量直接回 false，交给 JS 侧的「丢一半重试」处理。
        if (json.length() > 1500000) return "false";
        try {
            activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE)
                    .edit().putString(KEY_REPLAYS, json).apply();
            return "true";
        } catch (RuntimeException e) {
            return "false";
        }
    }

    // ── 生命周期 ────────────────────────────────────────────

    /** 房间状态变化时同步给 UDP 应答器，否则客人列表里会显示成「可加入」。 */
    public void setStarted(boolean started) {
        synchronized (lock) {
            if (responder != null) {
                responder.setStarted(started);
                if (server != null) responder.setPlayers(server.getPlayers());
            }
        }
    }

    /** Activity 销毁时收尾：房间和 UDP 监听都必须在，否则列表里会残留连不上的死房间。 */
    public void shutdown() {
        synchronized (lock) {
            stopLocked();
        }
    }

    /** 必须在持有 lock 时调用。 */
    private void stopLocked() {
        if (responder != null) {
            responder.stop();
            responder = null;
        }
        if (server != null) {
            server.stop();
            server = null;
        }
    }

    // ── 小工具 ──────────────────────────────────────────────

    /**
     * 只做查询串需要的百分号编码。
     *
     * 不用 Uri.encode：它对 "&" 和 "=" 的处理是按整串（含分隔符）来的，
     * 拼进 URL 里会把房间名的边界弄丢。手写一份，规则简单、行为可预期。
     * 中文房间名必须编码，否则 URL 里的裸 UTF-8 字节在 WebView 里表现不一致。
     */
    private static String urlEncode(String s) {
        byte[] bytes = s.getBytes(Charset.forName("UTF-8"));
        StringBuilder sb = new StringBuilder(bytes.length * 3);
        for (byte b : bytes) {
            int c = b & 0xFF;
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                    || c == '-' || c == '_' || c == '.' || c == '~') {
                sb.append((char) c);
            } else {
                sb.append('%');
                sb.append(Character.toUpperCase(Character.forDigit((c >> 4) & 0xF, 16)));
                sb.append(Character.toUpperCase(Character.forDigit(c & 0xF, 16)));
            }
        }
        return sb.toString();
    }
}
