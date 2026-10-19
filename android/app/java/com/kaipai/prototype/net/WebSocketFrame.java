package com.kaipai.prototype.net;

/**
 * 一个已解析的 WebSocket 帧：opcode + 去掩码后的载荷。
 *
 * ⚠️ 为什么是顶层类而不是 WebSocketPeer 里的嵌套类：
 * 这个项目用的 d8 处理**类名带 `$` 的产物**会内部错误（见 tools/build-apk.sh 的 [6]），
 * 所以 android/app/java 下所有匿名类与具名嵌套类都提成了顶层类。
 * 这里是第 16 个 —— 以前公网联机那一版把 Frame 写成嵌套类，
 * 在只保证「零 $ 产物」的构建里直接卡住的正是这一步。
 */
final class WebSocketFrame {
    int opcode;
    byte[] payload = new byte[0];
}
