package com.kaipai.prototype.net;

/**
 * 记录「谁曾经出现过」，供 getPlayers() 与超时判定使用。
 *
 * 原先是 HttpGameServer 的私有静态内部类（HttpGameServer$PeerState），
 * 提成顶层类是为了让 class 名里不含 '$'。所有可变状态由 HttpGameServer.lock 保护。
 */
final class PeerState {
    boolean seen;                 // 至少发过一次请求
    long lastActivityNanos;       // 最后一次请求的时间
    int activePolls;              // 正挂起在这个 peer 名下的 long-poll 数
    boolean left;                 // 已明确离开（/api/leave 或已被判定超时）
}
