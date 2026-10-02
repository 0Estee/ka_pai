package com.kaipai.prototype.net;

import java.net.Socket;

/**
 * 单连接任务：丢给线程池执行，长轮询最多占住一个线程 30 秒。
 *
 * 原先是 HttpGameServer.acceptLoop() 里的匿名 Runnable；处理逻辑仍在
 * HttpGameServer 上（handleConnection），连接对象通过构造器显式传入。
 */
final class ConnectionTask implements Runnable {

    private final HttpGameServer server;
    private final Socket sock;

    ConnectionTask(HttpGameServer server, Socket sock) {
        this.server = server;
        this.sock = sock;
    }

    @Override
    public void run() {
        server.handleConnection(sock);
    }
}
