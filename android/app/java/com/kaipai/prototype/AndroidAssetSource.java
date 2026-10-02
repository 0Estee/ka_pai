package com.kaipai.prototype;

import android.content.res.AssetManager;

import com.kaipai.prototype.net.AssetSource;
import com.kaipai.prototype.net.NetUtil;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * 从 APK 的 assets/ 读网页资源：主机要把自己打包的页面发给客人（协议 §1）。
 *
 * 原先是 NativeBridge 的私有静态内部类（NativeBridge$AndroidAssetSource），
 * 提成顶层类是为了让 class 名里不含 '$'（原因见 NativeBridge 的类注释）。
 */
final class AndroidAssetSource implements AssetSource {

    private final AssetManager mgr;

    AndroidAssetSource(AssetManager mgr) {
        this.mgr = mgr;
    }

    @Override
    public byte[] read(String path) {
        if (path == null || path.isEmpty()) return null;
        InputStream in = null;
        try {
            in = mgr.open(path, AssetManager.ACCESS_STREAMING);
            ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } catch (IOException e) {
            return null;
        } catch (RuntimeException e) {
            return null;
        } finally {
            NetUtil.closeQuietly(in);
        }
    }

    @Override
    public boolean exists(String path) {
        try {
            // 用 open 而不是 list：list 对 "dist/bundle.js" 这种带子目录的名字也能用，
            // 但 open 才是真正决定「服务端能不能把它发出去」的那一步，探测就得探它。
            InputStream in = mgr.open(path, AssetManager.ACCESS_STREAMING);
            NetUtil.closeQuietly(in);
            return true;
        } catch (IOException e) {
            return false;
        }
    }
}
