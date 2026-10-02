package com.kaipai.prototype.net;

import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.Charset;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * 最小可用的 WebSocket **服务端**（RFC 6455）。手写是为了这个项目零依赖。
 *
 * 用途很窄：只做**服务端 → 客户端**的推送通道，替代长轮询。
 * 客户端仍然用 HTTP POST 发消息（`/api/send`），这样发送路径完全不变、
 * 已有的测试继续有效；WebSocket 只负责「有新消息就立刻推给你」。
 *
 * 因此这里只实现了必要的那部分：
 *   · 握手（Sec-WebSocket-Accept）
 *   · 写文本帧（不加掩码 —— 服务端按规范就是不加的）
 *   · 写/读控制帧（ping / pong / close）
 *   · 读客户端帧（客户端发来的**必须**带掩码，要解掩码）
 *
 * **没实现**：分片消息（continuation）、扩展（permessage-deflate）、二进制帧。
 * 我们的消息都是我们自己发的短 JSON，一条一个帧，用不上那些。
 */
final class WebSocketPeer {

    /** 规范里写死的魔法字符串，握手要用 */
    private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final Charset UTF8 = Charset.forName("UTF-8");

    static final int OP_TEXT = 0x1;
    static final int OP_CLOSE = 0x8;
    static final int OP_PING = 0x9;
    static final int OP_PONG = 0xA;

    /** 单帧上限：我们的消息都是短 JSON，超过就是出了别的问题 */
    private static final int MAX_FRAME = 1 << 20;

    private WebSocketPeer() {
    }

    // ── 握手 ──────────────────────────────────────────────

    /** 算 Sec-WebSocket-Accept：base64(sha1(key + GUID)) */
    static String acceptKey(String clientKey) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            byte[] sha = md.digest((clientKey + GUID).getBytes(UTF8));
            return base64(sha);
        } catch (NoSuchAlgorithmException e) {
            // SHA-1 在 Android 上必然存在；真出不来就当成握手失败
            throw new IllegalStateException("SHA-1 不可用", e);
        }
    }

    /** 回 101，把连接升级成 WebSocket。调用方之后不能再发 HTTP 响应。 */
    static void writeHandshake(OutputStream out, String clientKey) throws IOException {
        StringBuilder sb = new StringBuilder();
        sb.append("HTTP/1.1 101 Switching Protocols\r\n");
        sb.append("Upgrade: websocket\r\n");
        sb.append("Connection: Upgrade\r\n");
        sb.append("Sec-WebSocket-Accept: ").append(acceptKey(clientKey)).append("\r\n");
        sb.append("\r\n");
        synchronized (out) {
            out.write(sb.toString().getBytes(UTF8));
            out.flush();
        }
    }

    // ── 写帧 ──────────────────────────────────────────────

    /** 写一个文本帧。**调用方要自己保证不并发**（同一时刻只在一个线程里写）。 */
    static void writeText(OutputStream out, String text) throws IOException {
        byte[] payload = text.getBytes(UTF8);
        writeFrame(out, OP_TEXT, payload);
    }

    /** 写一个控制帧（ping / pong / close）。控制帧载荷必须 ≤125 字节。 */
    static void writeControl(OutputStream out, int opcode, byte[] payload) throws IOException {
        byte[] p = payload == null ? new byte[0] : payload;
        if (p.length > 125) throw new IOException("控制帧载荷过长");
        writeFrame(out, opcode, p);
    }

    private static void writeFrame(OutputStream out, int opcode, byte[] payload) throws IOException {
        int len = payload.length;
        byte[] header;
        if (len <= 125) {
            header = new byte[2];
            header[1] = (byte) len;
        } else if (len <= 0xFFFF) {
            header = new byte[4];
            header[1] = (byte) 126;
            header[2] = (byte) ((len >>> 8) & 0xFF);
            header[3] = (byte) (len & 0xFF);
        } else {
            header = new byte[10];
            header[1] = (byte) 127;
            // 长度按 64 位大端写；我们不可能超过 2^31，高 4 字节写 0
            header[6] = (byte) ((len >>> 24) & 0xFF);
            header[7] = (byte) ((len >>> 16) & 0xFF);
            header[8] = (byte) ((len >>> 8) & 0xFF);
            header[9] = (byte) (len & 0xFF);
        }
        header[0] = (byte) (0x80 | opcode);   // FIN=1
        // header[1] 的掩码位保持 0：服务端发出的帧不加掩码
        out.write(header);
        if (len > 0) out.write(payload);
        out.flush();
    }

    // ── 读帧 ──────────────────────────────────────────────

    /** 一个已解析的帧 */
    static final class Frame {
        int opcode;
        byte[] payload = new byte[0];
    }

    /**
     * 读一个帧。客户端发来的帧**必须带掩码**，这里负责解掉。
     * 对端正常关闭时返回 opcode=CLOSE 的帧；流结束抛 EOFException。
     */
    static Frame readFrame(InputStream in) throws IOException {
        int b0 = in.read();
        if (b0 < 0) throw new EOFException("对端关闭");
        int b1 = in.read();
        if (b1 < 0) throw new EOFException("对端关闭");

        Frame f = new Frame();
        f.opcode = b0 & 0x0F;
        boolean masked = (b1 & 0x80) != 0;
        long len = b1 & 0x7F;

        if (len == 126) {
            len = ((long) readByte(in) << 8) | readByte(in);
        } else if (len == 127) {
            len = 0;
            for (int i = 0; i < 8; i++) len = (len << 8) | readByte(in);
        }
        if (len > MAX_FRAME) throw new IOException("帧过大: " + len);

        byte[] mask = null;
        if (masked) {
            mask = new byte[4];
            readFully(in, mask, 4);
        }
        byte[] payload = new byte[(int) len];
        readFully(in, payload, (int) len);
        if (mask != null) {
            for (int i = 0; i < payload.length; i++) {
                payload[i] = (byte) (payload[i] ^ mask[i & 3]);
            }
        }
        f.payload = payload;
        return f;
    }

    private static int readByte(InputStream in) throws IOException {
        int v = in.read();
        if (v < 0) throw new EOFException("对端关闭");
        return v;
    }

    private static void readFully(InputStream in, byte[] buf, int n) throws IOException {
        int read = 0;
        while (read < n) {
            int k = in.read(buf, read, n - read);
            if (k < 0) throw new EOFException("对端关闭");
            read += k;
        }
    }

    // ── 自带的 Base64 ─────────────────────────────────────
    //
    // 不用 java.util.Base64：那是 API 26 才有的，而这个 App 的 minSdk 更低。
    // 只做编码（握手只需要编码），二十行的事。

    private static final char[] B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();

    static String base64(byte[] data) {
        StringBuilder sb = new StringBuilder(((data.length + 2) / 3) * 4);
        int i = 0;
        while (i + 2 < data.length) {
            int n = ((data[i] & 0xFF) << 16) | ((data[i + 1] & 0xFF) << 8) | (data[i + 2] & 0xFF);
            sb.append(B64[(n >>> 18) & 63]).append(B64[(n >>> 12) & 63])
              .append(B64[(n >>> 6) & 63]).append(B64[n & 63]);
            i += 3;
        }
        int rest = data.length - i;
        if (rest == 1) {
            int n = (data[i] & 0xFF) << 16;
            sb.append(B64[(n >>> 18) & 63]).append(B64[(n >>> 12) & 63]).append("==");
        } else if (rest == 2) {
            int n = ((data[i] & 0xFF) << 16) | ((data[i + 1] & 0xFF) << 8);
            sb.append(B64[(n >>> 18) & 63]).append(B64[(n >>> 12) & 63])
              .append(B64[(n >>> 6) & 63]).append('=');
        }
        return sb.toString();
    }
}
