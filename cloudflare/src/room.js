/**
 * 房间服务（Durable Object）。
 *
 * 这是 `docs/联机协议.md` 的服务端实现之一：Java 那份跑在手机本机（局域网），
 * 这一份跑在 Cloudflare 边缘（互联网联机）。两边的 HTTP 契约**逐字一致**，
 * 客户端 `app/js/multiplayer.js` 一行都不用为「局域网 / 互联网」分叉。
 *
 * 为什么是 Durable Object 而不是普通的 Worker 变量：
 *  1. 每个房间需要一个**唯一串行**的写点 —— 两个人几乎同时发消息时，seq 必须
 *     不重不漏，普通 Worker 的多个 isolate 各记各的就会撞号；
 *  2. 长轮询要「挂起等新消息」，这要求请求和「谁在等」住在同一个对象里；
 *  3. WebSocket 要能在对象休眠后继续收消息（hibernation API）。
 *
 * 存储用 `ctx.storage`（SQLite 后端）：房间的存活时间跟玩家最后一句话绑定，
 * 两小时没人动就整个消失，不留垃圾。
 */

/** 房间最多留多少条消息（一场对局约 200~600 条；超了就丢最旧的） */
const LOG_CAP = 600;
/** 长轮询最长挂多久（协议 §2.4：上限 30000，默认 20000） */
const POLL_MAX_MS = 25000;
const POLL_DEFAULT_MS = 20000;
/** 房间闲置多久后允许被回收 */
const IDLE_MS = 2 * 60 * 60 * 1000;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 云存档（账号 / 存档 / 管理员）住在另一个 Durable Object 里。
 * Wrangler 要求 **入口模块** 导出所有 DO 类，所以这里转出一手；
 * 具体实现见 users.js（docs/云存档协议.md §1）。
 */
export { Users } from './users.js';

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    /** 单调递增的消息序号；不受 LOG_CAP 裁剪影响，客户端靠它判断「我处理到哪了」 */
    this.now = 0;
    /** 留着的消息，按 seq 升序 */
    this.log = [];
    /** 每一端最后一次露面的时间戳（判闲置用） */
    this.seen = { host: 0, guest: 0 };
    /**
     * 观战者心跳：`{ 观战者随机 id: 最后一次轮询时间 }`（作者 2026-10-23）。
     *
     * 观战者可以有任意多个、随时来随时走，所以不能像两端那样用固定键存 `seen`。
     * 这里只留「最近 45 秒还在轮询的」，`/api/room` 数一下就是当前观战人数。
     */
    this.watchers = {};
    /** 每一端是否已经离开（离开后对方的 poll 立刻返回 peer-left） */
    this.left = { host: false, guest: false };
    this.started = false;
    this.roomName = '';
    /** 正在长轮询等消息的请求 */
    this.waiters = [];

    this.ctx.blockConcurrencyWhile(async () => {
      const saved = (await this.ctx.storage.get('room')) || null;
      if (saved) {
        this.now = saved.now || 0;
        this.log = saved.log || [];
        this.seen = saved.seen || this.seen;
        this.left = saved.left || this.left;
        this.watchers = saved.watchers || {};
        this.started = !!saved.started;
        this.roomName = saved.roomName || '';
      }
    });
  }

  async persist() {
    await this.ctx.storage.put('room', {
      now: this.now,
      log: this.log,
      seen: this.seen,
      left: this.left,
      watchers: this.watchers,
      started: this.started,
      roomName: this.roomName,
    });
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
  }

  /** 闲置回收：两小时没人说话就整个房间清掉 */
  async alarm() {
    const idle = Date.now() - Math.max(this.seen.host || 0, this.seen.guest || 0);
    if (idle < IDLE_MS && this.waiters.length === 0) {
      await this.ctx.storage.setAlarm(Date.now() + (IDLE_MS - idle) + 1000);
      return;
    }
    await this.ctx.storage.deleteAll();
    this.log = [];
    this.now = 0;
    this.left = { host: false, guest: false };
    this.started = false;
  }

  // ── 消息 ───────────────────────────────────────────────

  /** 追加一条消息，叫醒正在等的对端 */
  push(from, name, msg) {
    const entry = { seq: this.now, from, name, msg };
    this.now++;
    this.log.push(entry);
    if (this.log.length > LOG_CAP) this.log = this.log.slice(-LOG_CAP);
    this.wake(entry);
    return entry.seq;
  }

  /** 有新消息了：把等着的请求挑出该醒的那些 */
  wake(entry) {
    const alive = [];
    for (const w of this.waiters) {
      if (w.done) continue;
      if (entry.from === w.who) { alive.push(w); continue; }   // 自己发的不推回去
      w.done = true;
      try { w.resolve(); } catch { /* 忽略 */ }
    }
    this.waiters = alive;
    this.pushWs(entry);
  }

  /** 该端视角下还没收到的消息（自己发的不返回，协议 §2.7） */
  pendingFor(who, since) {
    return this.log.filter((e) => e.seq >= since && e.from !== who);
  }

  // ── WebSocket 推送 ─────────────────────────────────────

  pushWs(entry) {
    let socks;
    try { socks = this.ctx.getWebSockets(); } catch { socks = []; }
    for (const ws of socks) {
      let who = '';
      try { who = (ws.deserializeAttachment() || {}).who || ''; } catch { /* 忽略 */ }
      if (who === entry.from) continue;      // 不把自己发的推回给发送方
      try { ws.send(JSON.stringify(entry)); } catch { /* 对端已断，等 close 回收 */ }
    }
  }

  // ── HTTP 入口 ──────────────────────────────────────────

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    /**
     * 这一条请求来自谁：'host' | 'guest' | 'watch'。
     *
     * 'watch' 是观战者（作者 2026-10-23）：它**只读**——
     *   · /api/send 一律 403（观战者不能往对局里插操作）
     *   · /api/poll 能拿到两端的全部消息（自己的 from 永远不是 host/guest，所以不会被过滤掉）
     *   · 两端都离开才算 peer-left，否则观战者会被一个人的退出踢出去
     */
    const whoRaw = url.searchParams.get('who');
    const who = whoRaw === 'guest' ? 'guest' : (whoRaw === 'watch' ? 'watch' : 'host');
    const isWatcher = who === 'watch';
    const roomName = url.searchParams.get('room') || '';
    if (roomName && !this.roomName) this.roomName = roomName;

    if (path === '/ws') return this.handleWs(request, who, url);

    if (path === '/api/health') return json({ ok: true, version: 1, online: true });

    if (path === '/api/room') {
      const players = (this.seen.host ? 1 : 0) + (this.seen.guest ? 1 : 0);
      return json({
        ok: true,
        room: this.roomName || url.searchParams.get('room') || '未命名房间',
        host: '主机',
        port: 0,
        players,
        watchers: this.watchCount(),
        started: this.started,
        version: 1,
      });
    }

    if (path === '/api/send') {
      if (request.method !== 'POST') return json({ ok: false, error: 'need-post' }, 405);
      /**
       * 观战者是**只读**连接：它要是能发消息，就等于能往锁步流里插操作，
       * 两端会立刻分叉。所以这一层直接拒掉（客户端也不会发）。
       */
      if (isWatcher) return json({ ok: false, error: 'read-only', message: '观战者不能发送消息' }, 403);
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: 'bad-json' }, 400); }
      const name = url.searchParams.get('name') || '';
      this.left[who] = false;
      this.seen[who] = Date.now();
      const seq = this.push(who, name, body);
      await this.persist();
      return json({ ok: true, seq });
    }

    if (path === '/api/poll') {
      const since = Math.max(0, Number(url.searchParams.get('since') || 0) | 0);
      let timeout = Number(url.searchParams.get('timeout') || POLL_DEFAULT_MS) | 0;
      if (!(timeout > 0)) timeout = POLL_DEFAULT_MS;
      timeout = Math.min(timeout, POLL_MAX_MS);
      this.seen[who] = Date.now();
      if (isWatcher) {
        this.touchWatcher(url.searchParams.get('wid'));
        const msgs0 = this.pendingFor(who, since);
        if (!msgs0.length && timeout > 0) await this.wait(timeout, who);
        // 观战者只在**两端都走了**之后才结束（一个人退出不影响看棋）
        if (this.left.host && this.left.guest) return json({ ok: false, error: 'peer-left' });
        return json({
          ok: true, now: this.now, msgs: this.pendingFor(who, since), watching: true, watchers: this.watchCount(),
        });
      }
      const other = who === 'host' ? 'guest' : 'host';
      if (this.left[other] && this.seen[other]) {
        return json({ ok: false, error: 'peer-left' });
      }
      let msgs = this.pendingFor(who, since);
      if (!msgs.length && timeout > 0) {
        // 挂起等新消息。最多等到 timeout，或对端离开。
        await this.wait(timeout, who);
        if (this.left[other] && this.seen[other]) return json({ ok: false, error: 'peer-left' });
        msgs = this.pendingFor(who, since);
      }
      // 顺带把「现在有几个人在看」告诉玩家：大厅里要显示「有 N 人在观战」。
      // 这不参与锁步，纯展示，所以随便刷新都不影响对局。
      return json({ ok: true, now: this.now, msgs, watchers: this.watchCount() });
    }

    if (path === '/api/leave') {
      if (isWatcher) {
        // 观战者离开：清掉自己的心跳就行，千万别把 left 标上（那会让两端以为对手走了）
        this.dropWatcher(url.searchParams.get('wid'));
        await this.persist();
        return json({ ok: true });
      }
      this.left[who] = true;
      this.seen[who] = Date.now();
      // 对端正挂着长轮询的话立刻叫醒它，让它马上看到 peer-left
      this.wakeLeft(who);
      await this.persist();
      return json({ ok: true });
    }

    if (path === '/api/start') {
      if (isWatcher) return json({ ok: true, ignored: true });
      this.started = true;
      this.seen[who] = Date.now();
      await this.persist();
      return json({ ok: true });
    }

    return json({ ok: false, error: 'not-found' }, 404);
  }

  /** 观战者心跳（45 秒内有轮询就算还在看） */
  touchWatcher(wid) {
    const key = String(wid || '').slice(0, 24) || 'anon';
    this.watchers[key] = Date.now();
    const cutoff = Date.now() - 45000;
    for (const k of Object.keys(this.watchers)) {
      if (this.watchers[k] < cutoff) delete this.watchers[k];
    }
    // 心跳不用每条都落盘：它只是「界面上显示几个人在看」，丢了不影响对局
  }

  dropWatcher(wid) {
    const key = String(wid || '').slice(0, 24) || 'anon';
    delete this.watchers[key];
  }

  watchCount() {
    const cutoff = Date.now() - 45000;
    return Object.keys(this.watchers).filter((k) => this.watchers[k] >= cutoff).length;
  }

  /** 挂起最多 ms 毫秒，或被新消息 / 对端离开叫醒 */
  wait(ms, who) {
    return new Promise((resolve) => {
      const w = { who, done: false, resolve: null };
      const timer = setTimeout(() => {
        w.done = true;
        this.waiters = this.waiters.filter((x) => x !== w);
        resolve();
      }, ms);
      w.resolve = () => { clearTimeout(timer); resolve(); };
      this.waiters.push(w);
    });
  }

  /** 有人离开：叫醒对端的长轮询，让它立刻收到 peer-left */
  wakeLeft(who) {
    const alive = [];
    for (const w of this.waiters) {
      if (w.done) continue;
      if (w.who === who) { alive.push(w); continue; }
      w.done = true;
      try { w.resolve(); } catch { /* 忽略 */ }
    }
    this.waiters = alive;
  }

  handleWs(request, who, url) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return json({ ok: false, error: 'need-websocket' }, 400);
    }
    const since = Math.max(0, Number(url.searchParams.get('since') || 0) | 0);
    const pair = new WebSocketPair();
    const server = pair[1];

    // hibernation API：对象休眠后这些连接仍然活着，消息会重新唤醒 fetch/webSocketMessage
    this.ctx.acceptWebSocket(server);
    try { server.serializeAttachment({ who }); } catch { /* 老运行时忽略 */ }
    if (who === 'watch') {
      // 观战者：只记心跳，不动两端的 seen/left（否则会把房主挤成「没来」）
      this.touchWatcher(url.searchParams.get('wid'));
    } else {
      this.seen[who] = Date.now();
      this.left[who] = false;
    }

    // 握手时先把 since 之后漏掉的消息补上（和长轮询同一套语义）
    for (const e of this.pendingFor(who, since)) {
      try { server.send(JSON.stringify(e)); } catch { /* 忽略 */ }
    }
    this.ctx.storage.put('room', {
      now: this.now, log: this.log, seen: this.seen, left: this.left,
      started: this.started, roomName: this.roomName,
    }).catch(() => {});
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** 客户端发来的帧：只用来探活（发送走 POST /api/send，协议 §2.7） */
  async webSocketMessage(ws, raw) {
    let who = '';
    try { who = (ws.deserializeAttachment() || {}).who || ''; } catch { /* 忽略 */ }
    this.seen[who] = Date.now();
    if (raw === 'ping' || raw === '"ping"') {
      try { ws.send('pong'); } catch { /* 忽略 */ }
    }
  }

  async webSocketClose(ws) {
    let who = '';
    try { who = (ws.deserializeAttachment() || {}).who || ''; } catch { /* 忽略 */ }
    if (who) this.seen[who] = Date.now();
    try { ws.close(1000, 'closed'); } catch { /* 忽略 */ }
  }

  async webSocketError(ws) {
    try { ws.close(1011, 'error'); } catch { /* 忽略 */ }
  }
}

/** 云存档接口：这些路径不归房间管，统一交给全局 Users 对象（协议 §1.5） */
function isCloudPath(path) {
  return path === '/api/save'
    || path.startsWith('/api/auth/')
    || path.startsWith('/api/admin/');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── 云存档接口：必须在房间路由**之前**拦下
    //
    // 注意顺序：/api/auth/login 之类不带 room，如果落到下面的房间分支会被判成
    // room-required；而 /api/save 也不该被 SPA 兜底吃掉。
    if (isCloudPath(url.pathname)) {
      if (!env.USERS) {
        return json({ ok: false, error: 'users-unbound', message: '缺少 USERS 绑定' }, 500);
      }
      const id = env.USERS.idFromName('global');
      return env.USERS.get(id).fetch(request);
    }

    // ── 房间接口：按房间号路由到对应的 Durable Object
    if (url.pathname.startsWith('/api/') || url.pathname === '/ws') {
      if (url.pathname === '/api/health' && !url.searchParams.get('room')) {
        return json({ ok: true, version: 1, online: true });
      }
      const room = (url.searchParams.get('room') || '').trim().toUpperCase();
      if (!room) return json({ ok: false, error: 'room-required' }, 400);
      if (!/^[A-Z0-9]{4,12}$/.test(room)) return json({ ok: false, error: 'bad-room' }, 400);
      const id = env.ROOMS.idFromName(room);
      return env.ROOMS.get(id).fetch(request);
    }

    // ── 静态资源（index.html / style.css / screens.css / dist/ / img/）
    const res = await env.ASSETS.fetch(request);
    if (res.status !== 404) return res;

    // 单页兜底：任何没命中的路径都回首页（?net=host&room=XXXX 之类都靠它）
    const index = await env.ASSETS.fetch(new URL('/index.html', url));
    if (index.status === 200) {
      return new Response(index.body, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    return new Response('not found', { status: 404 });
  },
};
