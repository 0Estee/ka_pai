package com.kaipai.prototype.net;

/**
 * 「去哪里读资产字节」的抽象。
 *
 * 存在的唯一理由：让 net/ 下的 HTTP 服务既能跑在 Android（资产在 APK 的 assets/ 里，
 * 只能通过 AssetManager 读），又能跑在开发机的桌面 JVM（资产在文件系统里）。
 * 没有这层抽象，HttpGameServer 就必须写在 Android 里，于是联机逻辑只剩真机可测。
 *
 * 实现方约定：
 *   · path 用 APK assets 里的相对路径，正斜杠分隔，不带前导 "/"，例如 "dist/bundle.js"。
 *   · read 读不到时返回 null（不要抛异常），调用方据此回 404。
 *   · 返回的字节原样发送，服务端不做任何转码。
 */
public interface AssetSource {

    /** 读取资产；不存在时返回 null。 */
    byte[] read(String path);

    /** 资产是否存在。默认实现够用，实现类可按需覆盖成更廉价的探测。 */
    boolean exists(String path);
}
