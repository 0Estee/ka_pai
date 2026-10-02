package com.kaipai.prototype.net;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * WebSocket 连接的**读线程**：只负责两件事 —— 发现对端关闭、应答 ping。
 * 游戏数据不走这个方向（客户端用 HTTP POST 发消息），所以收到的文本帧直接忽略。
 *
 * ⚠️ 为什么是顶层类而不是匿名内部类：
 * 匿名内部类会带一个 `this$0` 合成字段，而**这个项目用的 d8 在遇到任何带该字段的类时
 * 会直接内部错误**（`Compilation failed with an internal error`）。
 * 以前为此抽过 14 个类出来，这里是第 15 个。
 */
final class WsReader implements Runnable {

    private final InputStream in;
    private final OutputStream out;
    /** 写帧要串行化：主推送线程也会写同一个 out */
    private final Object writeLock;
    /** 由读线程置位的「已关闭」标志（数组为了能按引用改） */
    private final boolean[] closed;
    /** 关闭时唤醒推送线程，让它别干等到超时 */
    private final Object wakeLock;

    WsReader(InputStream in, OutputStream out, Object writeLock, boolean[] closed, Object wakeLock) {
        this.in = in;
        this.out = out;
        this.writeLock = writeLock;
        this.closed = closed;
        this.wakeLock = wakeLock;
    }

    @Override
    public void run() {
        try {
            while (!closed[0]) {
                WebSocketPeer.Frame f = WebSocketPeer.readFrame(in);
                if (f.opcode == WebSocketPeer.OP_CLOSE) break;
                if (f.opcode == WebSocketPeer.OP_PING) {
                    synchronized (writeLock) {
                        WebSocketPeer.writeControl(out, WebSocketPeer.OP_PONG, f.payload);
                    }
                }
                // 文本/二进制帧：客户端不用这条通道发数据，忽略即可
            }
        } catch (IOException e) {
            // 对端正常关闭也会走到这里，不是错误
        } finally {
            closed[0] = true;
            synchronized (wakeLock) {
                wakeLock.notifyAll();
            }
        }
    }
}
