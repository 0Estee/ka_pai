package com.kaipai.prototype.net;

/**
 * 解析失败。调用方通常只需把它当成「请求体不是合法 JSON」。
 *
 * 原先是 Json 的公有静态内部类（Json$JsonException），提成顶层类是为了让
 * class 名里不含 '$'。名字保持不变，只是不再需要写 Json.JsonException。
 */
public class JsonException extends RuntimeException {
    public JsonException(String msg) {
        super(msg);
    }
}
