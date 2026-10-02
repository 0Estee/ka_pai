package com.kaipai.prototype.net;

import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * UDP 房间发现（协议 §6）：主机侧应答器 + 客人侧探测器。
 *
 * 为什么不扫网段：C 段 254 个地址挨个探，几秒钟都出不来结果，还很容易被路由器/防火墙
 * 当成扫描行为拦掉。广播 + 单播应答是局域网里唯一又快又稳的做法。
 *
 * 探测必须发多个广播地址：255.255.255.255 是「受限广播」，很多路由器不发出去，
 * 手机在有的 Wi-Fi 上收不到；子网定向广播（192.168.1.255）才能穿透。
 * 所以这里把两者都发一遍，并各自去重。
 *
 * 注：应答器与探测结果类型原先是本类的静态内部类，现在分别是顶层类
 * RoomResponder / DiscoveredRoom —— 工程里不再有 class 名带 '$' 的产物。
 */
public final class RoomDiscovery {

    /** 发现端口：与 HTTP 的 8765 错开，避免和游戏数据的端口语义混淆。 */
    public static final int DISCOVER_PORT = 8766;

    public static final String MAGIC = "KAPAI_DISCOVER/1";

    /** 协议 §6：客人等待 1500ms 收集应答。 */
    public static final int DEFAULT_COLLECT_MS = 1500;

    private RoomDiscovery() {
    }

    // ── 客人侧：探测器 ───────────────────────────────────────

    /**
     * 广播 {@code KAPAI_DISCOVER/1} 并收集应答。
     *
     * 阻塞式：调用方（NativeBridge）必须放在后台线程，否则 WebView 这边会 ANR。
     *
     * @param timeoutMs 收集时长，0 或负数取默认 1500ms
     * @return 按 ip:port 去重后的房间列表；一个都没收到就是空列表（不是异常）
     */
    public static List<DiscoveredRoom> scan(int timeoutMs) {
        int wait = timeoutMs > 0 ? timeoutMs : DEFAULT_COLLECT_MS;
        List<DiscoveredRoom> found = new ArrayList<DiscoveredRoom>();
        List<String> seen = new ArrayList<String>();

        DatagramSocket socket = null;
        try {
            // 必须用 DatagramSocket(null) + 显式 bind 到通配地址：
            // 直接 new DatagramSocket() 在部分安卓版本上绑定的是具体地址，收不到定向广播。
            socket = new DatagramSocket(null);
            socket.setReuseAddress(true);
            socket.setBroadcast(true);
            socket.bind(new InetSocketAddress(0));
            socket.setSoTimeout(150);

            byte[] payload = MAGIC.getBytes(java.nio.charset.Charset.forName("UTF-8"));
            for (String bc : NetUtil.getBroadcastAddresses()) {
                try {
                    InetAddress addr = InetAddress.getByName(bc);
                    DatagramPacket pkt = new DatagramPacket(payload, payload.length,
                            addr, DISCOVER_PORT);
                    socket.send(pkt);
                } catch (IOException e) {
                    // 某块网卡的广播发不出去（比如 VPN 接口）不影响其它网卡，继续
                }
            }

            long deadline = System.nanoTime() + wait * 1000000L;
            byte[] buf = new byte[2048];
            while (System.nanoTime() < deadline) {
                DatagramPacket pkt = new DatagramPacket(buf, buf.length);
                try {
                    socket.receive(pkt);
                } catch (SocketTimeoutException e) {
                    continue;              // 没包就继续等，直到 deadline
                } catch (IOException e) {
                    break;
                }
                try {
                    String text = new String(pkt.getData(), pkt.getOffset(), pkt.getLength(),
                            java.nio.charset.Charset.forName("UTF-8"));
                    Map<String, Object> m = Json.decodeObject(text);
                    if (!"room".equals(Json.str(m, "t", ""))) continue;   // 不是我们的协议
                    DiscoveredRoom r = new DiscoveredRoom(m, pkt.getAddress().getHostAddress());
                    // 同一台机器可能从多块网卡各回一份（或同时收到两张网卡的广播），按 ip:port 去重
                    if (seen.contains(r.key())) continue;
                    seen.add(r.key());
                    found.add(r);
                } catch (RuntimeException e) {
                    // 收到别的程序发来的、恰好落在 8766 上的包 —— 忽略就好
                }
            }
        } catch (SocketException e) {
            // 端口/网卡有问题就返回空列表：界面显示"没找到房间"比抛异常好处理
        } finally {
            if (socket != null) socket.close();
        }
        return found;
    }
}
