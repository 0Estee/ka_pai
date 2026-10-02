package com.kaipai.prototype.net;

import java.util.Map;

/**
 * 一条已解析的 HTTP 请求（只支持 GET/POST —— 协议只用到这两个）。
 *
 * 原先是 HttpGameServer 的私有静态内部类，提成顶层类是为了让 class 名里不含 '$'。
 * 字段保持包内可见：解析与路由都在同一个包的 HttpGameServer 里做。
 */
final class Request {
    String method = "GET";
    String path = "/";
    Map<String, Object> query = Json.obj();
    String body = "";
    String who;
    String name;
    boolean closeAfter = true;
    /** 全部请求头，key 统一小写。WebSocket 握手要读 Sec-WebSocket-Key。 */
    Map<String, String> headers = new java.util.LinkedHashMap<String, String>();
}
