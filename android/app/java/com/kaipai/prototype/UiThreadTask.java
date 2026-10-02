package com.kaipai.prototype;

import android.webkit.WebView;

/**
 * 把一次 WebView.loadUrl 切回主线程执行。
 *
 * 原先是 NativeBridge.navigate 里的匿名 Runnable；提成顶层类后，
 * 外层变量（web / url）通过构造器显式传入，语义与原来完全一样：
 * JavaBridge 线程直接 loadUrl 在部分机型上会崩或静默无效，必须走主线程。
 */
final class UiThreadTask implements Runnable {

    private final WebView web;
    private final String url;

    UiThreadTask(WebView web, String url) {
        this.web = web;
        this.url = url;
    }

    @Override
    public void run() {
        if (web != null) web.loadUrl(url);
    }
}
