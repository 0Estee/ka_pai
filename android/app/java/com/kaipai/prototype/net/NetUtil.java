package com.kaipai.prototype.net;

import java.io.IOException;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.SocketException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 网络小工具：本机 IPv4、广播地址、端口探测。
 *
 * 全部是标准库实现，不碰任何 Android 类 —— 桌面测试才能覆盖到这些逻辑。
 * 联机问题里最容易出错的恰恰是「选错了网卡 / 算错了广播地址」，
 * 这类 bug 在真机上极难定位，所以宁可在这里多些防御。
 */
public final class NetUtil {

    private NetUtil() {
    }

    /**
     * 取一个「客人真能连上」的本机 IPv4。
     *
     * 优先回环之外的、已启用、非虚拟的网卡地址。
     * 排序上优先 192.168 > 10. > 172.16-31，因为家里的路由器基本都是 192.168.x.x，
     * 而 USB 网络共享 / 虚拟网卡经常是 10.x 或 172.x —— 报错了 IP 客人就永远连不上。
     */
    public static String getLocalIp() {
        List<String> candidates = new ArrayList<String>();
        try {
            Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
            if (nis != null) {
                for (NetworkInterface ni : Collections.list(nis)) {
                    if (ni == null || !ni.isUp() || ni.isLoopback() || ni.isVirtual()) continue;
                    for (InetAddress addr : Collections.list(ni.getInetAddresses())) {
                        if (!(addr instanceof Inet4Address)) continue;
                        if (addr.isLoopbackAddress() || addr.isLinkLocalAddress()) continue;
                        String ip = addr.getHostAddress();
                        if (ip == null || ip.isEmpty()) continue;
                        candidates.add(ip);
                    }
                }
            }
        } catch (SocketException ignored) {
            // 拿不到网卡列表不致命：下面还有回环兜底
        }
        if (candidates.isEmpty()) return "";

        String best = candidates.get(0);
        int bestScore = -1;
        for (String ip : candidates) {
            int score = scoreOf(ip);
            if (score > bestScore) {
                bestScore = score;
                best = ip;
            }
        }
        return best;
    }

    private static int scoreOf(String ip) {
        if (ip.startsWith("192.168.")) return 40;
        if (ip.startsWith("10.")) return 30;
        if (isPrivate172(ip)) return 25;
        return 10;
    }

    private static boolean isPrivate172(String ip) {
        if (!ip.startsWith("172.")) return false;
        int dot = ip.indexOf('.', 4);
        if (dot < 0) return false;
        try {
            int second = Integer.parseInt(ip.substring(4, dot));
            return second >= 16 && second <= 31;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    /**
     * 所有网卡的 IPv4 广播地址。
     *
     * 协议 §6 特别强调：不能只发 255.255.255.255。
     * 部分路由器/手机会把定向广播（子网广播）和受限广播区别对待，
     * 只发 255.255.255.255 会漏掉某些设备。所以这里把两者都收集起来。
     *
     * 注意 InetAddress.getBroadcast() 对点对点接口可能返回 null 或非 IPv4，都要跳过。
     */
    public static List<String> getBroadcastAddresses() {
        // LinkedHashSet：去重但保序，调试输出时顺序稳定
        Set<String> out = new LinkedHashSet<String>();
        try {
            Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
            if (nis != null) {
                for (NetworkInterface ni : Collections.list(nis)) {
                    if (ni == null || !ni.isUp() || ni.isLoopback()) continue;
                    List<InterfaceAddress> addrs;
                    try {
                        addrs = ni.getInterfaceAddresses();
                    } catch (Exception ignored) {
                        continue;
                    }
                    for (InterfaceAddress ia : addrs) {
                        if (ia == null) continue;
                        InetAddress b = ia.getBroadcast();
                        if (b == null) continue;             // 点对点接口没有广播地址
                        if (!(b instanceof Inet4Address)) continue;
                        out.add(b.getHostAddress());
                    }
                }
            }
        } catch (SocketException ignored) {
        }
        // 受限广播始终加在最后：即使网卡信息拿不到，探测也还有一次机会
        out.add("255.255.255.255");
        return new ArrayList<String>(out);
    }

    /**
     * 从一个基端口往上找可用的 TCP 端口。
     *
     * 协议 §2 要求「被占用时往上找，最多试 10 个」。
     * 这里只探测不占用（短暂的 bind-close），真正的独占交给 HttpGameServer 的 ServerSocket。
     * 中间存在竞态窗口，但局域网房间里不可能同时有人抢同一端口，不值得为此加锁。
     */
    public static int findFreePort(int base, int attempts) {
        for (int i = 0; i < attempts; i++) {
            int port = base + i;
            if (port > 65535) break;
            if (isPortFree(port)) return port;
        }
        return -1;
    }

    /** 端口是否可被本机独占绑定（含通配地址）。 */
    public static boolean isPortFree(int port) {
        ServerSocket ss = null;
        try {
            ss = new ServerSocket();
            ss.setReuseAddress(false);
            ss.bind(new InetSocketAddress(port));
            return true;
        } catch (IOException e) {
            return false;
        } finally {
            if (ss != null) {
                try {
                    ss.close();
                } catch (IOException ignored) {
                }
            }
        }
    }

    /** 端口是否还能被 UDP 绑定（发现端口 8766 的可用性检查）。 */
    public static boolean isUdpPortFree(int port) {
        DatagramSocket ds = null;
        try {
            ds = new DatagramSocket(null);
            ds.setReuseAddress(false);
            ds.bind(new InetSocketAddress(port));
            return true;
        } catch (IOException e) {
            return false;
        } finally {
            if (ds != null) ds.close();
        }
    }

    /** 关掉一个 socket 且不让 close 抛出的异常污染日志。 */
    public static void closeQuietly(java.io.Closeable c) {
        if (c == null) return;
        try {
            c.close();
        } catch (IOException ignored) {
        }
    }
}
