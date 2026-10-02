package com.kaipai.prototype;

import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * 让所有跳转都留在 WebView 里，不交给系统浏览器。
 *
 * 必须有 WebViewClient，且 shouldOverrideUrlLoading 返回 false：
 * 客人加入房间时要导航到 http://192.168.x.x:8765/（主机提供的页面），
 * 没有 WebViewClient 时 WebView 会把 http:// 交给系统浏览器去开，
 * 结果自己停在原页面 —— 表现是"点了加入没反应"，极难查。
 *
 * 两个重载都要覆盖：API 24 及以上走 WebResourceRequest 版，
 * 24 以下只认 String 版。返回 false = 交给 WebView 自己加载。
 *
 * 为什么是顶层类而不是内部类：
 *   d8（build-tools 34.0.0 自带的 R8 8.2.2-dev）解析**匿名内部类**时会内部 NPE
 *   （class 文件里带 EnclosingMethod 属性的那些）——
 *     java.lang.NullPointerException: Cannot invoke "String.length()"
 *     because "&lt;parameter1&gt;" is null
 *   所以工程里所有内部类都提成了顶层类，class 名里不再出现 '$'。
 */
final class KeepInWebViewClient extends WebViewClient {

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        return false;
    }

    @Override
    @SuppressWarnings("deprecation")
    public boolean shouldOverrideUrlLoading(WebView view, String url) {
        return false;
    }
}
