package com.kaipai.prototype.net;

import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;
import java.net.SocketTimeoutException;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 主机侧 UDP 房间应答器（协议 §6）。
 *
 * 生命周期与 HTTP 服务绑定：房间开着就应答，关掉就停 —— 否则手机的房间列表里
 * 会残留一堆已经点不进去的「死房间」，这在真机上非常难查（看起来像连不上，其实是幽灵条目）。
 *
 * 原先是 RoomDiscovery 的公有静态内部类（RoomDiscovery$Responder），提成顶层类
 * 是为了让 class 名里不含 '$'。名字从 Responder 改成 RoomResponder 以免和其它
 * 包的通用名字混淆，行为一行未改；应答循环体在 ResponderLoop 里。
 */
public final class RoomResponder {

    private final Object lock = new Object();
    private final String room;
    private final String host;
    private final int httpPort;

    private DatagramSocket socket;
    private Thread thread;
    private volatile boolean running = false;

    // 房间状态由 NativeBridge 随游戏进程更新 —— 协议 §6 要求开局后 started=true，
    // 否则客人会看到一个"点得进去但其实已经开打"的房间。
    private volatile boolean started = false;
    private volatile int players = 1;

    public RoomResponder(String room, String host, int httpPort) {
        this.room = room == null ? "卡牌对决" : room;
        this.host = host == null ? "主机" : host;
        this.httpPort = httpPort;
    }

    public void setStarted(boolean v) {
        this.started = v;
    }

    public void setPlayers(int n) {
        this.players = n <= 0 ? 1 : n;
    }

    /**
     * 绑定 0.0.0.0:8766 并开始应答。
     *
     * 一定要 bind 到通配地址：绑定到具体网卡（比如 127.0.0.1）就收不到广播包了，
     * 而广播包的目标地址看起来并不属于这块网卡。
     *
     * @throws IOException 端口被占用（比如同一台机上已经开了一个房间）
     */
    public void start() throws IOException {
        DatagramSocket s = new DatagramSocket(null);
        s.setReuseAddress(true);
        s.bind(new InetSocketAddress(RoomDiscovery.DISCOVER_PORT));
        s.setBroadcast(true);          // 单播应答不需要它，但保留以免实现里将来改成广播回
        s.setSoTimeout(500);           // 定期醒来检查 running，否则 stop() 要等一个包才能退出
        socket = s;
        running = true;

        thread = new Thread(new ResponderLoop(this), "kapai-udp-responder");
        thread.setDaemon(true);
        thread.start();
    }

    /** 应答循环体。包内可见：由顶层类 ResponderLoop 调用。 */
    void loop() {
        byte[] buf = new byte[512];
        while (running) {
            DatagramPacket pkt = new DatagramPacket(buf, buf.length);
            try {
                socket.receive(pkt);
            } catch (SocketTimeoutException e) {
                continue;              // 正常：只是醒来看看要不要退
            } catch (IOException e) {
                if (!running) return;  // stop() 关掉了 socket
                continue;              // 单个坏包不能让应答器死掉
            }
            try {
                String text = new String(pkt.getData(), pkt.getOffset(), pkt.getLength(),
                        java.nio.charset.Charset.forName("UTF-8")).trim();
                if (!RoomDiscovery.MAGIC.equals(text)) continue;

                // 协议 §6：单播回给发问的那个地址（不是广播回），
                // 这样同网段里问的人能精确收到，别人不会被打扰。
                byte[] reply = buildReply().getBytes(java.nio.charset.Charset.forName("UTF-8"));
                DatagramPacket out = new DatagramPacket(reply, reply.length,
                        pkt.getAddress(), pkt.getPort());
                socket.send(out);
            } catch (IOException e) {
                // 应答发失败只说明这一个客人没收到，他自然会再广播一次
            } catch (RuntimeException e) {
            }
        }
    }

    /** 协议 §6 的应答 JSON。ip 用探测时的本机地址 —— 客人真正要连的就是它。 */
    private String buildReply() {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("t", "room");
        m.put("room", room);
        m.put("host", host);
        m.put("ip", NetUtil.getLocalIp());
        m.put("port", (long) httpPort);
        m.put("players", (long) players);
        m.put("started", started);
        m.put("version", (long) HttpGameServer.VERSION);
        return Json.encode(m);
    }

    public boolean isRunning() {
        return running;
    }

    public void stop() {
        running = false;
        synchronized (lock) {
            if (socket != null) {
                socket.close();        // close 会让阻塞中的 receive 抛异常，线程自己退出
                socket = null;
            }
        }
        if (thread != null) {
            thread.interrupt();
            thread = null;
        }
    }
}
