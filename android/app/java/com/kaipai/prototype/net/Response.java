package com.kaipai.prototype.net;

/**
 * 一条待写出的 HTTP 响应。
 *
 * 原先是 HttpGameServer 的私有静态内部类，提成顶层类是为了让 class 名里不含 '$'。
 * 工厂方法保持包内可见，只有 HttpGameServer 会构造它。
 */
final class Response {
    int status = 200;
    String contentType = "text/html; charset=utf-8";
    byte[] body = new byte[0];

    static Response json(int status, String json) {
        Response r = new Response();
        r.status = status;
        r.contentType = "application/json; charset=utf-8";
        r.body = json.getBytes(java.nio.charset.Charset.forName("UTF-8"));
        return r;
    }

    static Response bytes(int status, String ct, byte[] data) {
        Response r = new Response();
        r.status = status;
        r.contentType = ct;
        r.body = data;
        return r;
    }

    static Response empty(int status) {
        Response r = new Response();
        r.status = status;
        r.body = null;
        return r;
    }
}
