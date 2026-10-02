package com.kaipai.prototype.net;

/**
 * accept 循环体：单独的线程跑，绝不能阻塞 —— 长轮询会占住工作线程最多 30 秒。
 *
 * 原先是 HttpGameServer.start() 里的匿名 Runnable；循环逻辑仍在 HttpGameServer
 * 上（acceptLoop 方法），这里只负责把它挂到线程上。
 */
final class AcceptLoop implements Runnable {

    private final HttpGameServer server;

    AcceptLoop(HttpGameServer server) {
        this.server = server;
    }

    @Override
    public void run() {
        server.acceptLoop();
    }
}
