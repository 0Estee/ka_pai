package com.kaipai.prototype.net;

/**
 * 应答循环体：每 500ms 醒一次检查 running，收到 KAPAI_DISCOVER/1 就单播回房间信息。
 *
 * 原先是 RoomResponder.start() 里的匿名 Runnable；提成顶层类后，
 * 应答器实例通过构造器显式传入，循环逻辑仍在 RoomResponder.loop() 上。
 */
final class ResponderLoop implements Runnable {

    private final RoomResponder responder;

    ResponderLoop(RoomResponder responder) {
        this.responder = responder;
    }

    @Override
    public void run() {
        responder.loop();
    }
}
