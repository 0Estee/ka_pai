package com.kaipai.prototype;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;

/**
 * 唯一的 Activity：全屏 WebView 加载 assets/index.html。
 *
 * 设计取舍：
 *  · 不引入 AndroidX / 任何第三方库 —— 这样才能绕开不可达的 Gradle 与 Maven 源，
 *    只用 SDK build-tools 手工构建 APK。
 *  · 网页资源已由 tools/build-web.mjs 打成单个传统脚本，
 *    所以不需要 setAllowFileAccessFromFileURLs（ES Module 才需要，且该设置在新版已失效）。
 *  · 联机时页面由**主机的 HTTP 服务**提供（协议 §1），WebView 会导航到
 *    http://192.168.x.x:8765/，所以必须有 WebViewClient，见下面 shouldOverrideUrlLoading。
 */
public class MainActivity extends Activity {

    private WebView web;
    private NativeBridge bridge;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 游戏过程中不熄屏
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // 沉浸式全屏（这些 flag 虽已废弃，但从 API 19 到最新都有效，最省事）
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#FF0B0F14"));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setHorizontalScrollBarEnabled(false);
        web.setVerticalScrollBarEnabled(false);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(false);
        // 关键：忽略系统「字体大小」设置，否则用户调大字号会把布局撑坏
        s.setTextZoom(100);

        web.setWebChromeClient(new WebChromeClient());

        // 必须有 WebViewClient，且 shouldOverrideUrlLoading 返回 false：
        // 客人加入房间时要导航到 http://192.168.x.x:8765/（主机提供的页面），
        // 没有 WebViewClient 时 WebView 会把 http:// 交给系统浏览器去开，
        // 结果自己停在原页面 —— 表现是"点了加入没反应"，极难查。
        //
        // 实现放在**顶层类** KeepInWebViewClient 里，而不是内部类：d8
        // （build-tools 34.0.0 自带的 R8 8.2.2-dev）解析匿名内部类时会内部 NPE
        // （Cannot invoke "String.length()" because "<parameter1>" is null），
        // 构建直接失败。顺带让 class 名里不再出现 '$'。功能完全一样。
        web.setWebViewClient(new KeepInWebViewClient());

        // 联机能力交给原生层（HTTP 服务 / UDP 发现）。API 17+ 必须给方法加
        // @JavascriptInterface，否则 JS 根本看不到这些方法。
        bridge = new NativeBridge(this, web);
        web.addJavascriptInterface(bridge, "KapaiNative");

        web.loadUrl("file:///android_asset/index.html");
        setContentView(web);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        // 关掉房间：UDP 应答器不停的话，别的手机的房间列表里会一直留着这个
        // 已经点不进去的死房间（协议 §6 明确要求）
        if (bridge != null) {
            bridge.shutdown();
            bridge = null;
        }
        if (web != null) {
            web.removeJavascriptInterface("KapaiNative");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
