/**
 * 局域网联机：传输层 + 锁步会话。
 *
 * 协议见 `docs/联机协议.md`。核心思想：
 * 引擎完全确定性 → **只同步操作，不同步棋盘**。
 * 双方各自跑同一个引擎，收到同一条操作就各执行一次，状态自然一致。
 * 这和「回放」是同一件事，只是传输层从本地数组换成了 HTTP。
 *
 * 本文件不碰 DOM，方便单独测试。
 */

import * as G from '../../engine/src/engine.js';
import { LANES, ROWS } from '../../engine/src/constants.js';

/** 每执行多少步互发一次状态指纹 */
const HASH_EVERY = 8;
/** 长轮询超时（毫秒） */
const POLL_TIMEOUT = 20000;
/** WebSocket 握手超时 —— 旧版服务端不会有 /ws，不能让界面干等 */
const WS_OPEN_TIMEOUT_MS = 4000;
/** 掉线后等待重连的上限（毫秒）—— 协议 §7 */
export const RECONNECT_LIMIT_MS = 60000;

// ══════════════════════════════════════════════════════════
// 原生桥（Android）与运行模式
// ══════════════════════════════════════════════════════════

function bridge() {
  try {
    return globalThis.KapaiNative || null;
  } catch {
    return null;
  }
}

/** 当前环境有没有原生能力（桌面浏览器里没有，只能用开发服务器） */
export function nativeAvailable() {
  const b = bridge();
  if (!b) return false;
  try { return String(b.isSupported()) === 'true'; } catch { return false; }
}

/**
 * 当前是不是联机模式。
 * 主机和客人都是**从主机的 HTTP 服务加载页面**的（协议 §1），
 * 所以 URL 里带 `?net=host` 或 `?net=guest`。
 */
export function netMode() {
  try {
    const p = new URLSearchParams(globalThis.location.search);
    const m = p.get('net');
    return m === 'host' || m === 'guest' ? m : null;
  } catch {
    return null;
  }
}

export function queryParam(name) {
  try {
    return new URLSearchParams(globalThis.location.search).get(name) || '';
  } catch {
    return '';
  }
}

/** 我这一方的玩家编号：主机固定 0，客人固定 1（先手由 seed 决定，与此无关） */
export function mySide() {
  return netMode() === 'guest' ? 1 : 0;
}

function parseJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

/** 让原生层把 WebView 导航到联机地址（会触发页面重载） */
export function navigateTo(url) {
  const b = bridge();
  if (!b) return false;
  b.navigate(url);
  return true;
}

/** 开房间：原生起 HTTP + UDP 服务，返回 { port, url } */
export function startHost(roomName, hostName) {
  const b = bridge();
  if (!b) return { ok: false, error: '当前环境不支持开启房间' };
  return parseJson(b.startHost(roomName, hostName), { ok: false, error: '原生层返回异常' });
}

export function stopHost() {
  const b = bridge();
  if (!b) return;
  try { b.stopHost(); } catch { /* 忽略 */ }
}

/** 扫描局域网房间，返回房间数组 */
export function scanRooms(timeoutMs = 1500) {
  const b = bridge();
  if (!b) return [];
  const arr = parseJson(b.scanRooms(timeoutMs), []);
  return Array.isArray(arr) ? arr : [];
}

export function localIp() {
  const b = bridge();
  if (!b) return '';
  try { return b.getLocalIp() || ''; } catch { return ''; }
}

// ══════════════════════════════════════════════════════════
// 传输：HTTP 长轮询
// ══════════════════════════════════════════════════════════

/**
 * 页面是从主机的服务加载的，所以接口都在**同源**路径下，
 * 直接用相对 URL 即可 —— 不需要知道主机 IP，也没有跨域问题。
 */
export class Transport {
  constructor(who) {
    this.who = who;           // 'host' | 'guest'
    this.since = 0;
    this.stopped = false;
  }

  async roomInfo() {
    const r = await fetch('/api/room', { cache: 'no-store' });
    return r.json();
  }

  async send(msg) {
    const r = await fetch(`/api/send?who=${this.who}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
      cache: 'no-store',
    });
    return r.json();
  }

  /**
   * 长轮询一次。返回 `{ msgs, peerLeft }`。
   * `since` 由内部维护：只有成功拿到消息才推进，
   * 这样断线重连后能把漏掉的消息补回来（协议 §7）。
   */
  async poll(timeout = POLL_TIMEOUT) {
    if (this.stopped) return { msgs: [], peerLeft: false };
    const url = `/api/poll?who=${this.who}&since=${this.since}&timeout=${timeout}`;
    const r = await fetch(url, { cache: 'no-store' });
    const data = await r.json();
    if (data && data.ok === false && data.error === 'peer-left') {
      return { msgs: [], peerLeft: true };
    }
    if (!data || !data.ok) return { msgs: [], peerLeft: false };

    // 只推进到真正收到的最后一条，中间的空洞留给下一次 poll 补齐
    for (const m of data.msgs || []) {
      if (m.seq >= this.since) this.since = m.seq + 1;
    }
    return { msgs: data.msgs || [], peerLeft: false };
  }

  async start() {
    try { await fetch(`/api/start?who=${this.who}`, { method: 'POST' }); } catch { /* 忽略 */ }
  }

  async leave() {
    this.stopped = true;
    try { await fetch(`/api/leave?who=${this.who}`, { method: 'POST', keepalive: true }); } catch { /* 忽略 */ }
  }
}

// ══════════════════════════════════════════════════════════
// 状态指纹
// ══════════════════════════════════════════════════════════

/**
 * 把状态压成一个短字符串再哈希，用来判断两端有没有跑飞。
 *
 * **两端算法必须逐字节一致**（协议 §5），所以 Java 层不参与，
 * 只在 JS 里实现一份。
 */
export function stateSignature(state) {
  const parts = [
    state.turn,
    state.phase,
    state.winner === null ? '-' : state.winner,
    state.players[0].kingHp,
    state.players[1].kingHp,
    state.players[0].hand.length,
    state.players[1].hand.length,
  ];
  for (const lane of LANES) {
    for (const side of [0, 1]) {
      for (const row of ROWS) {
        const u = state.board[lane].units[side][row];
        parts.push(u ? `${u.cardId}:${u.atk}:${u.hp}:${u.maxHp}` : '-');
      }
    }
  }
  return parts.join('|');
}

/** FNV-1a 32 位 */
export function stateHash(state) {
  const s = stateSignature(state);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

// ══════════════════════════════════════════════════════════
// 锁步会话
// ══════════════════════════════════════════════════════════

/**
 * 联机会话。持有本地引擎状态，按收到的消息推进。
 *
 * 调用方（main.js）负责：把 `onUpdate` 接到界面渲染上、
 * 在轮到自己时调用 `submit()` 把操作发出去。
 */
export class Session {
  /**
   * @param {object} o
   * @param {string} o.who            'host' | 'guest'
   * @param {object} o.cardLib
   * @param {function} o.onUpdate     状态变化时回调（重绘）
   * @param {function} o.onStatus     连接状态变化："connected" | "reconnecting" | "closed"
   * @param {function} [o.onStart]    收到 start 消息、正式开局时回调
   */
  constructor({ who, cardLib, onUpdate, onStatus, onStart, onAction }) {
    this.who = who;
    this.isHost = who === 'host';
    this.mySide = this.isHost ? 0 : 1;
    this.cardLib = cardLib;
    this.onUpdate = onUpdate || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onStart = onStart || (() => {});
    this.onAction = onAction || (() => {});
    // 开局参数回传给上层（客人录回放要用）；上层随后会覆盖它
    this.onSeedDeck = () => {};

    this.transport = new Transport(who);
    this.state = null;
    this.started = false;
    this.peerName = '';
    this.roomName = '';
    this.step = 0;
    this.running = false;
    this.looping = false;

    /** 对方最近一次报告的指纹，用于校验 */
    this.peerHash = null;
    this.conflict = null;
  }

  getName() {
    return this.isHost ? '主机' : '客人';
  }

  /** 主机把开局参数广播出去 */
  async beginGame({ seed, firstPlayer, deck }) {
    this.applyStart({ seed, firstPlayer, deck });
    await this.transport.start();
    await this.transport.send({ t: 'start', seed, firstPlayer, deck });
    this.onUpdate();
  }

  applyStart({ seed, firstPlayer, deck }) {
    // 先把开局参数交回上层记下来（客人要靠它录回放）。
    // 以前只有主机在 hostStartMatch 里自己记，客人这边的 recordingSeed/recordingDeck
    // 一直是空的 —— 客人那侧存出来的回放会是一副残局。
    this.onSeedDeck(seed, firstPlayer, deck);
    this.state = G.createGame({ seed, firstPlayer, deck, cardLib: this.cardLib });
    G.startGame(this.state);
    // 联机时**两边都是真人**，没有 AI 替谁做决定：
    // 效果中途要选目标（「抉择」「打出:指定目标」）时必须挂起等人点，
    // 设成 true 的话引擎会一律取第一个选项 —— 那就是「被判定成 AI」了。
    this.state.autoResolveChoices = false;
    this.started = true;
    this.step = 0;
    this.onStart(this.state);
  }

  /** 本地要执行一个操作：先应用，再广播 */
  async submit(action) {
    if (this.conflict || !this.state) return false;
    try {
      this.applyAction(action);
    } catch (err) {
      // 本地操作被引擎拒绝 —— 通常是界面允许了一个非法操作。
      // 这**不是**同步问题，只提示、不中止对局。
      this.lastError = err.message;
      return false;
    }
    this.lastError = '';
    this.step++;
    this.onAction(action, true);
    await this.maybeHash();
    this.onUpdate();
    try {
      await this.transport.send({ t: 'act', a: action });
    } catch {
      this.setStatus('reconnecting');
    }
    return true;
  }

  /**
   * 应用一条操作。两端走的是同一个函数，保证一致。
   * 失败时**抛出**，由调用方决定怎么处理 —— 本地执行失败是「界面给了非法操作」，
   * 远端执行失败才是真正的「两端跑飞了」，两者含义完全不同。
   */
  applyAction(a) {
    const st = this.state;
    if (!st) throw new Error('对局还没开始');
    if (a.k === 'a') G.advance(st);
    else if (a.k === 'p') G.playCard(st, a.s, a.i, a.o || {});
    else if (a.k === 'c') G.resolveChoice(st, a.v);
    else throw new Error(`未知操作 ${a.k}`);
  }

  async maybeHash() {
    if (this.step % HASH_EVERY !== 0) return;
    try {
      await this.transport.send({ t: 'hash', step: this.step, h: stateHash(this.state) });
    } catch { /* 断线时忽略，重连后会补 */ }
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus(s);
  }

  /** 处理一条收到的消息。返回 true 表示状态变了。 */
  handleMessage(msg, from) {
    if (!msg || typeof msg !== 'object') return false;
    switch (msg.t) {
      case 'hello':
        this.peerName = msg.name || '';
        return true;

      case 'start':
        if (this.started) return false;   // 主机不会收到自己的 start
        this.applyStart(msg);
        return true;

      case 'act':
        if (!this.state) return false;
        try {
          this.applyAction(msg.a);
        } catch (err) {
          // 远端来的操作本地执行失败 = 两端状态已经不一致了，必须停下
          this.conflict = `第 ${this.step + 1} 步无法执行对手的操作：${err.message}`;
          this.setStatus('closed');
          return false;
        }
        this.step++;
        this.onAction(msg.a, false);
        return true;

      case 'hash':
        if (msg.step === this.step && this.state) {
          const mine = stateHash(this.state);
          if (mine !== msg.h) {
            this.conflict = `与对手的进度不一致（第 ${msg.step} 步：${mine} vs ${msg.h}）`;
            this.setStatus('closed');
          }
        }
        return false;

      case 'bye':
        this.peerLeft = true;
        return false;

      default:
        return false;
    }
  }

  /** 启动接收循环：优先 WebSocket 推送，连不上就回落到长轮询 */
  start() {
    if (this.looping) return;
    this.running = true;
    this.looping = true;
    this.setStatus('connected');
    this.startReceiving();
  }

  /**
   * 先试 WebSocket（服务端 → 客户端的推送通道）。
   *
   * 为什么两条路都留着：WebSocket 是新加的服务端能力，而**两端版本可能不一致**
   * （客人是从主机的服务加载页面的，但主机可能还是旧 APK 的旧服务端），
   * 也可能被某些中间设备挡掉。连不上就退回长轮询 —— 旧路径一直在、也有测试覆盖，
   * 所以最差情况就是回到改造前的行为，不会因为换传输层而彻底连不上。
   */
  async startReceiving() {
    const ok = await this.tryWebSocket();
    if (!this.running) return;
    if (!ok) {
      this.usingWs = false;
      this.loop();
      return;
    }
    this.usingWs = true;
  }

  /** 连上返回 true；连不上（或被挡）返回 false，由调用方回落到长轮询 */
  tryWebSocket() {
    return new Promise((resolve) => {
      let settled = false;
      let ws = null;
      const done = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => {
        try { if (ws) ws.close(); } catch { /* 忽略 */ }
        done(false);
      }, WS_OPEN_TIMEOUT_MS);

      try {
        if (typeof WebSocket !== 'function') { done(false); return; }
        const proto = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:';
        // since 从当前进度开始要，漏掉的由服务端按 seq 补齐（和长轮询同一套语义）
        ws = new WebSocket(`${proto}//${globalThis.location.host}/ws?who=${this.who}&since=${this.transport.since}`);
      } catch {
        done(false);
        return;
      }

      ws.onopen = () => {
        this.ws = ws;
        this.setStatus('connected');
        done(true);
      };
      ws.onmessage = (ev) => this.onWsMessage(ev && ev.data);
      ws.onerror = () => done(false);
      ws.onclose = () => {
        // 握手阶段就关掉 = 服务端没有这个能力（对方是旧版本），交给长轮询
        if (!settled) { done(false); return; }
        // 已经连上之后断的 = 网络问题：退回长轮询继续打，别让对局卡死。
        // （长轮询自带重连与 60 秒上限，那条路一直是好的）
        if (!this.running || this.fellBack) return;
        this.ws = null;
        this.setStatus('reconnecting');
        this.fellBack = true;
        this.loop();
      };
    });
  }

  /** 收到一条推送。载荷结构与长轮询里的单条消息**完全一致**，所以处理逻辑复用。 */
  onWsMessage(raw) {
    if (!this.running) return;
    let entry;
    try { entry = JSON.parse(raw); } catch { return; }
    if (!entry || typeof entry !== 'object') return;
    if (typeof entry.seq === 'number' && entry.seq >= this.transport.since) {
      this.transport.since = entry.seq + 1;   // 推进进度，和长轮询一个口径
    }
    if (entry.from === this.who) return;      // 自己发的不用再处理一遍
    this.setStatus('connected');
    if (this.handleMessage(entry.msg, entry.from)) this.onUpdate();
    if (this.peerLeft) {
      this.setStatus('closed');
      this.running = false;
    }
  }

  stop() {
    this.running = false;
    try { if (this.ws) this.ws.close(); } catch { /* 忽略 */ }
    this.ws = null;
  }

  async loop() {
    let lastOk = Date.now();
    while (this.running) {
      try {
        const { msgs, peerLeft } = await this.transport.poll();
        if (!this.running) break;
        lastOk = Date.now();
        this.setStatus('connected');

        let changed = false;
        for (const m of msgs) {
          if (m.from === this.who) continue;   // 自己发的不用再处理一遍
          if (this.handleMessage(m.msg, m.from)) changed = true;
        }
        if (changed) this.onUpdate();

        if (peerLeft || this.peerLeft) {
          this.setStatus('closed');
          this.running = false;
          break;
        }
        if (this.conflict) {
          this.running = false;
          break;
        }
      } catch {
        // 长轮询失败 = 连接断了。协议 §7：等待重连，上限 60 秒。
        this.setStatus('reconnecting');
        if (Date.now() - lastOk > RECONNECT_LIMIT_MS) {
          this.setStatus('closed');
          this.running = false;
          break;
        }
        await sleep(2000);
      }
    }
    this.looping = false;
  }

  /** 主动退出：告诉对方，然后停掉 */
  async leave() {
    this.running = false;
    try { await this.transport.send({ t: 'bye', reason: 'left' }); } catch { /* 忽略 */ }
    await this.transport.leave();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
