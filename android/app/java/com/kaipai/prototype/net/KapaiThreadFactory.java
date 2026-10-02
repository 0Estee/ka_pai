package com.kaipai.prototype.net;

import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * HTTP 线程池的线程工厂：给线程起个能认出来的名字（真机排错时一眼看出是谁），
 * 并设成守护线程（进程退出时不会因为线程池把 VM 挂住）。
 *
 * 原先是 HttpGameServer 构造器里的匿名 ThreadFactory；提成顶层类后，
 * 计数器 n 变成这个类自己的字段，行为与原来完全一样。
 */
final class KapaiThreadFactory implements ThreadFactory {

    private final AtomicInteger n = new AtomicInteger();

    @Override
    public Thread newThread(Runnable r) {
        Thread t = new Thread(r, "kapai-http-" + n.incrementAndGet());
        t.setDaemon(true);
        return t;
    }
}
