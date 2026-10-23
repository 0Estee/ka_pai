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
/**
 * 长轮询请求的 fetch 超时 = 服务端挂起的时长 + 这点余量。
 *
 * 以前所有请求共用一个 12 秒上限，而长轮询要挂 20 秒 —— 于是一次空闲等待
 * 必然被本地 abort 掉，客户端把「本来就没消息」当成断线：状态在
 * connected / reconnecting 之间来回跳，连续 60 秒就会走到「连接已断开」，
 * 会话直接停掉（**两张地图分别在不同网络下互通时最容易踩到**：
 * 来回一趟几百毫秒，空转的次数比局域网多得多）。
 * 所以轮询必须按自己的时长算，别用那个给普通请求准备的上限。
 */
const POLL_SLACK_MS = 8000;
/** WebSocket 握手超时 —— 旧版服务端不会有 /ws，不能让界面干等 */
const WS_OPEN_TIMEOUT_MS = 4000;
/**
 * 发一条消息时**最多让回合循环等它多久**（毫秒）。
 *
 * 为什么要有这个上限：锁步的回合循环是 `await session.submit()` 串起来的
 * （game-flow.js 的 tick 推进自动阶段 → submit → 再 tick）。
 * 网络一慢，await 就把整局停在那里：界面显示「回合开始…」、busy 恒为 true，
 * 玩家点牌毫无反应 —— 但本地其实什么都不缺，只是被"等广播"拖住了。
 * 所以操作**照发**，只是等够这么久就先往下走（真正的失败由 onStatus 报）。
 */
const BROADCAST_WAIT_MS = 3000;

/** 掉线后等待重连的上限（毫秒）—— 协议 §7 */
const RECONNECT_LIMIT_MS = 60000;

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
 * 当前页面能不能用**公网联机**（Cloudflare 上的房间服务）。
 *
 * 判据是「页面不是 file://」：APK 里从 android_asset 加载时是 file://，
 * 那种情况下 fetch('/api/…') 没有服务器可打；而只要页面是从 http(s) 来的，
 * /api/* 与 /ws 就都在**同源**下 —— 无论是 Cloudflare 公网，还是桌面浏览器里
 * `node tools/serve.mjs` 起的开发服务器。
 *
 * 不做主动探测（发一个 /api/health 再等）：那会让「进联机菜单」卡一下，
 * 而且失败时还得区分超时/断网，体验比直接把入口摆出来更差。
 * 真连不上时，大厅里的状态栏会显示断线，那时才提示。
 */
export function onlineAvailable() {
  try {
    const p = globalThis.location.protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

/** 当前站点根地址（公网联机时用来拼「请对面访问」的链接） */
export function siteBase() {
  try {
    return `${globalThis.location.protocol}//${globalThis.location.host}`;
  } catch {
    return '';
  }
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
    // watch = 观战（作者 2026-10-23）：只读的第三条连接
    return m === 'host' || m === 'guest' || m === 'watch' ? m : null;
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

/**
 * 房间号。
 *
 * 局域网时代不需要它：整台机器的服务端只有一个房间，接口都在同源根路径下。
 * 搬到公网之后同一份服务要接无数个房间，于是**每条请求都得自己报房间号**，
 * 服务端才知道该把它转给哪个房间对象（见 cloudflare/src/room.js）。
 *
 * 统一在这里做一次：拉成大写、剥掉可能被玩家粘进来的空格与符号。
 * 非法（空或长度不对）返回空字符串，由调用方提示 —— 不静默兜底成别的房间，
 * 那会让两个陌生人莫名其妙坐进同一局。
 */
export function roomCode(raw) {
  let s = String(raw == null ? '' : raw).trim().toUpperCase();
  // 允许玩家直接粘整条链接：把 ?room=XXXX 抠出来
  const m = s.match(/[?&]ROOM=([A-Z0-9]+)/);
  if (m) s = m[1];
  s = s.replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{4,12}$/.test(s) ? s : '';
}

/** 当前页面对应的房间号（从 URL 的 ?room= 取） */
export function currentRoom() {
  return roomCode(queryParam('room'));
}

/** 生成一个随机房间号：去掉容易看错的 0/O、1/I，方便口头念给对面 */
export function newRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const n = 6;
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

/**
 * 请求超时（毫秒）。
 *
 * 为什么必须有：锁步的**回合循环**是 `await session.submit()` 串起来的
 * （见 game-flow.js 的 tick）。浏览器里一条 fetch 没有超时的话，
 * 移动网络一卡就可能是几十秒到两分钟：这期间本地操作其实早就应用了，
 * 但 `autoAdvancing` 一直被挂着，界面停在「回合开始…」，玩家点什么都没反应。
 * 超时之后请求会 reject，submit 那边的 catch 把状态标成 reconnecting，
 * 本地的循环照常往下走（操作会在重连后补发）。
 */
const REQUEST_TIMEOUT_MS = 12000;

function fetchWithTimeout(url, opts, ms) {
  const limit = Number(ms) > 0 ? Number(ms) : REQUEST_TIMEOUT_MS;
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return fetch(url, { ...(opts || {}), signal: AbortSignal.timeout(limit) });
    }
  } catch { /* 老环境没有 AbortSignal：退回不带超时 */ }
  return fetch(url, opts);
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
  constructor(who, room) {
    this.who = who;           // 'host' | 'guest' | 'watch'
    /** 观战者：只读连接（不发送任何消息，服务端也会拒） */
    this.isWatcher = who === 'watch';
    /**
     * 观战者的随机 id：服务端拿它统计「几个人在看」，离开时也靠它清自己的心跳。
     * 两端不需要（服务端按 host / guest 两个固定键记在线状态）。
     */
    this.wid = this.isWatcher ? 'w' + Math.random().toString(36).slice(2, 10) : '';
    // 房间号：公网服务端按它路由到对应的房间对象；局域网服务端只有一个房间，带了也不认
    this.room = roomCode(room) || roomCode(currentRoom());
    this.since = 0;
    this.stopped = false;
  }

  /** 拼接口地址：始终带上 who 与 room（房间为空时退回旧形态，兼容旧版局域网服务端） */
  url(path, extra) {
    const q = new URLSearchParams({ who: this.who });
    if (this.room) q.set('room', this.room);
    if (this.wid) q.set('wid', this.wid);
    for (const [k, v] of Object.entries(extra || {})) q.set(k, String(v));
    return `${path}?${q.toString()}`;
  }

  async send(msg) {
    // 观战者不发消息：能发就等于能往锁步流里插操作，两端立刻分叉。
    // 服务端那边也会 403，这里是本地先挡一道（也省一次往返）。
    if (this.isWatcher) return { ok: false, error: 'read-only' };
    const r = await fetchWithTimeout(this.url('/api/send'), {
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
    // 服务端最多挂 timeout 毫秒，这边必须比它长，否则每次空闲等待都会被本地掐断
    const r = await fetchWithTimeout(
      this.url('/api/poll', { since: this.since, timeout }),
      { cache: 'no-store' },
      Math.min(timeout, POLL_TIMEOUT) + POLL_SLACK_MS,
    );
    const data = await r.json();
    if (data && data.ok === false && data.error === 'peer-left') {
      return { msgs: [], peerLeft: true };
    }
    if (!data || !data.ok) return { msgs: [], peerLeft: false };

    // 只推进到真正收到的最后一条，中间的空洞留给下一次 poll 补齐
    for (const m of data.msgs || []) {
      if (m.seq >= this.since) this.since = m.seq + 1;
    }
    // 观战人数（纯展示，不进锁步）：服务端每轮回包顺手告诉我们
    return { msgs: data.msgs || [], peerLeft: false, watchers: data.watchers };
  }

  async start() {
    if (this.isWatcher) return;   // 观战者不能替别人标记开局
    try { await fetchWithTimeout(this.url('/api/start'), { method: 'POST' }); } catch { /* 忽略 */ }
  }

  async leave() {
    this.stopped = true;
    try { await fetchWithTimeout(this.url('/api/leave'), { method: 'POST', keepalive: true }); } catch { /* 忽略 */ }
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
  constructor({ who, cardLib, onUpdate, onStatus, onStart, onAction, room }) {
    this.who = who;
    this.isHost = who === 'host';
    /**
     * 观战者（作者 2026-10-23）：只读的第三条连接。
     *
     * 它和客人走**同一条**锁步流水（收 start、按 n 执行 act），区别只有三条：
     *   · 不发送任何操作（submit / send / start 全部本地挡掉）
     *   · 不去要补齐（need）：它只读，缺的那几条下一轮 poll 会自己带回来
     *   · 不比对指纹、不判胜负、不结算金币
     * 视角固定按 0 号（座位1）看：棋盘的上/下布局对观战者来说只是「一边在上面」。
     */
    this.isWatcher = who === 'watch';
    this.mySide = this.isHost || this.isWatcher ? 0 : 1;
    this.cardLib = cardLib;
    this.onUpdate = onUpdate || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onStart = onStart || (() => {});
    this.onAction = onAction || (() => {});
    // 开局参数回传给上层（客人录回放要用）；上层随后会覆盖它
    this.onSeedDeck = () => {};

    // 房间号：来源是 URL 上的 ?room=，公网服务端靠它把请求转给正确的房间对象
    this.room = roomCode(room) || currentRoom();
    this.transport = new Transport(who, this.room);
    this.state = null;
    this.started = false;
    this.peerName = '';
    /** 对手选的阵营（联机开局要用它建局，见 lan.js 的 hostStartMatch） */
    this.peerFaction = '';
    /** 对手所在的玩法模式（hello 里报的；只用于大厅提示，最终以主机为准） */
    this.peerForge = false;
    /**
     * 对手的强化/精通增量表（`{cardId:{atk,hp,cost,kw}}`，来自 hello 消息）。
     *
     * 联机要求「双方各自强化自己的牌」：主机开局时把**自己**的与**对手报上来的**
     * 拼成 `[{...}, {...}]` 交给 createGame，再随 start 广播给客人 ——
     * 两端因此拿到完全相同的 enhance，单位落地数值与锦囊费用才不会分叉。
     */
    this.peerEnhance = null;
    this.step = 0;
    /**
     * 已经执行过的操作，按顺序。
     *
     * 用来做「补齐」：网络抖一下丢了中间一条 act，两端步数就会永久错开。
     * 落后的一方发 {t:'need', from} 要，前面的一方照这份历史原样回放，
     * 不用重建棋盘，也不用重开一局。
     */
    this.history = [];
    /**
     * start 之前收到的操作。
     *
     * 高延迟下「主机本地已经走了一步、start 还在路上」是常态（见 beginGame 的
     * 注释）。这一类消息以前被直接丢掉（`if (!this.state) return false`），
     * 客人的步数从此永远比主机少 —— 表现就是「双方都出不了牌」。
     * 现在先攒着，start 一到就按原顺序补执行。
     */
    this.early = [];
    /** 发送队列：保证多条消息**按顺序**到达服务端（对象里的 seq 按到达顺序分配） */
    this.sendChain = null;
    /** 正在向对端要缺失的操作（防抖，别连着发一堆 need） */
    this.fixing = null;
    this.running = false;
    this.looping = false;

    this.conflict = null;
    /** 观战者：错过了 start（房间日志已经裁掉），进不来这一局 */
    this.missedStart = false;
    /** 当前有几个观战者（服务端每轮 poll 报一次；只用于大厅那行提示） */
    this.watchers = 0;
  }

  /**
   * 主机把开局参数广播出去。
   *
   * ⚠ **顺序**：先发 start，**再**本地开局。
   *
   * 反过来（以前的写法：先 applyStart 再发 start）在公网上是必炸的：
   * applyStart 会回调 onStart → 界面上屏 → tick() 排下第一拍自动阶段（260ms 后），
   * 而那时 `transport.start()` 的那次 POST 还没回来，start 也就还没发出去 ——
   * 于是第一条 `{k:'a'}` **抢在 start 前面**到达对端。对端还没有棋盘，
   * 那条 act 被静默丢掉，两端的步数从此永远差一截：
   * 表现就是「联机开局后双方都出不了牌」（客人等主机的推进，主机等客人的操作）。
   *
   * 局域网里 RTT 只有几毫秒，抢跑窗口小到几乎踩不中；跨网络（手机流量 / 异地）
   * 一趟几百毫秒，**每次都踩中** —— 这就是「不同网络下必坏」的原因。
   *
   * 发送失败会抛出去：宁可留在大厅让玩家重试，也不要开一局只有一边在跑的棋。
   */
  async beginGame({ seed, firstPlayer, deck, factions, enhance, mode, restart }) {
    await this.transport.start();
    /**
     * restart=true 是「重新开局」（作者 2026-10-22 第 2 条）：对端已经开过一局，
     * 所以 start 上多一个 r:1 标记 —— 收到方要靠它允许「第二次 start」，
     * 否则 applyStart 会被「已经开过局」那道闸挡掉，客人那边永远停在上一局。
     */
    await this.transport.send({ t: 'start', r: restart ? 1 : 0, seed, firstPlayer, deck, factions, enhance, mode });
    this.applyStart({ seed, firstPlayer, deck, factions, enhance, mode });
    this.onUpdate();
  }

  applyStart({ seed, firstPlayer, deck, factions, enhance, mode }) {
    // 重开时 early 里攒的是**上一局**抢跑的操作，直接丢掉（应用上去只会报非法）
    if (this.started) this.early = [];
    // 模式以主机为谁：'forge' = 强化模式（读双方增量），其余一律普通模式。
    // 客人通过 URL 进房时本地 playMode 是默认值，必须用广播过来的这一份。
    this.mode = mode === 'forge' ? 'forge' : 'normal';
    // 先把开局参数交回上层记下来（客人要靠它录回放）。
    // 以前只有主机在 hostStartMatch 里自己记，客人这边的 recordingSeed/recordingDeck
    // 一直是空的 —— 客人那侧存出来的回放会是一副残局。
    this.onSeedDeck(seed, firstPlayer, deck, factions, enhance);
    this.state = G.createGame({
      seed,
      firstPlayer,
      deck,
      cardLib: this.cardLib,
      factions: (factions || []).slice(),
      // 双方的强化增量（主机算好后随 start 广播过来；缺省就没有强化）
      enhance: enhance || null,
    });
    G.startGame(this.state);
    // 联机时**两边都是真人**，没有 AI 替谁做决定：
    // 效果中途要选目标（「抉择」「打出:指定目标」）时必须挂起等人点，
    // 设成 true 的话引擎会一律取第一个选项 —— 那就是「被判定成 AI」了。
    this.state.autoResolveChoices = false;
    this.started = true;
    this.step = 0;
    this.history = [];
    this.onStart(this.state);
    // start 之前抢跑到的操作：现在有棋盘了，按原顺序补执行（见构造函数的 early 说明）。
    // 放在 onStart 之后，录制（回放）已经建好，这些操作才会被记进去。
    if (this.early.length) {
      const queued = this.early;
      this.early = [];
      for (const a of queued) {
        try {
          this.applyAction(a);
        } catch {
          break;   // 真的对不上：交给指纹检查去报冲突，别在这里硬撑
        }
        this.history.push(a);
        this.step++;
        this.onAction(a, false);
      }
    }
  }

  /** 本地要执行一个操作：先应用，再广播 */
  async submit(action) {
    // 观战者永远不提交操作（界面上也不会走到这里，这里是第二道闸）
    if (this.isWatcher) return false;
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
    const n = this.step;          // 这条操作在整局里的序号（0 起），随消息发给对端
    this.history.push(action);
    this.step++;
    this.onAction(action, true);
    // 界面先更新：后面的广播再慢，也不该让对局停在「回合开始…」。
    this.onUpdate();
    // 先发操作，再发指纹：反过来的话对端先看到「第 n 步的指纹」会以为丢了消息，
    // 白白多要一轮补齐。
    await this.broadcast({ t: 'act', a: action, n });
    await this.maybeHash();
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
    else if (a.k === 'x') G.sacrificeUnit(st, a.s, a.u);
    else if (a.k === 's') G.surrender(st, a.s);
    // 炼药（炼金阵营）：两端都要能重放这条操作
    else if (a.k === 'b') G.brew(st, a.s, a.i);
    else throw new Error(`未知操作 ${a.k}`);
  }

  /**
   * 发一条消息，但**不让回合循环等它超过 BROADCAST_WAIT_MS**。
   *
   * 操作照发（`transport.send` 那边有 REQUEST_TIMEOUT_MS 兜底，失败会把状态
   * 标成 reconnecting），只是不把界面卡在等回包上 —— 这才是
   * 「联机开始后无法出牌」的另一半：广播慢，整个回合循环跟着停。
   */
  async broadcast(msg, quiet) {
    const sending = this.queueSend(msg).catch(() => {
      if (!quiet) this.setStatus('reconnecting');
    });
    try {
      await Promise.race([sending, sleep(BROADCAST_WAIT_MS)]);
    } catch { /* 忽略：状态由 onStatus 反映 */ }
  }

  /**
   * 把一条消息排进发送队列。
   *
   * 服务端的 seq 是按**到达顺序**分配的，两条 POST 同时在路上就可能调换顺序 ——
   * 对端按序执行，一调换就永久分叉。所以这里串成一条链：上一条落地了才发下一条。
   * 链上某一条失败不能把后面的堵死（失败那条会被指纹检查兜住）。
   */
  queueSend(msg) {
    const run = () => this.transport.send(msg);
    const started = this.sendChain ? this.sendChain.then(run) : run();
    this.sendChain = started.then(() => undefined, () => undefined);
    return started.then(
      (r) => r,
      (err) => {
        this.setStatus('reconnecting');
        throw err;
      },
    );
  }

  /** 落后了：向对端要「我缺的那一段操作」 */
  requestCatchUp() {
    if (this.fixing) return;
    this.fixing = setTimeout(() => { this.fixing = null; }, 3000);
    this.queueSend({ t: 'need', from: this.step }).catch(() => {});
  }

  async maybeHash() {
    if (this.step % HASH_EVERY !== 0) return;
    // 指纹包失败不算问题（重连后另一端会按 seq 补齐对话）—— 所以 quiet
    await this.broadcast({ t: 'hash', step: this.step, h: stateHash(this.state) }, true);
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
        // 观战者不参与大厅协商（它没有座位、也不报阵营）
        if (this.isWatcher) return false;
        this.peerName = msg.name || '';
        // 进房间时互相报一次阵营，主机开局才能按各自的阵营建局
        if (msg.faction) this.peerFaction = msg.faction;
        // 同一份 hello 里还报「我这边强化了哪些牌」——主机开局要把它算进 enhance
        if (msg.enhance && typeof msg.enhance === 'object') this.peerEnhance = msg.enhance;
        // 以及「我在普通模式还是强化模式」——大厅要提示两边是否一致
        this.peerForge = msg.forge === true;
        return true;

      case 'faction':
        // 对手在大厅里换了阵营
        this.peerFaction = msg.key || '';
        return true;

      case 'start':
        // 主机不会收到自己的 start。已经开过局时只接受「重开」的那一份（r:1）
        if (this.started && msg.r !== 1) return false;
        this.applyStart(msg);
        return true;

      case 'restart-req':
        /**
         * 客人按了「重新开局」：重开要重新算一份开局参数（种子 / 牌库 / 阵营），
         * 只能由房主算并广播，所以客人这边只发请求，真正重开在房主那侧执行。
         */
        if (!this.isHost) return false;
        if (typeof this.onRestartRequest === 'function') this.onRestartRequest();
        return false;

      case 'act': {
        // 棋盘还没建好：先攒着，start 一到按原顺序补执行（见 early 的说明）
        if (!this.state) {
          /**
           * 观战者没拿到 start 就收到了操作 = 这局开始得太久，服务端的消息日志
           * 已经把 start 裁掉了（房间只留最近 600 条）。记一笔给界面，说清楚
           * 「进不来」比让玩家对着「等待这局开始…」干等要好。
           */
          if (this.isWatcher) this.missedStart = true;
          if (this.early.length < 400) this.early.push(msg.a);
          return false;
        }
        const n = typeof msg.n === 'number' ? msg.n : this.step;
        if (n < this.step) return false;          // 重复（重连补发），忽略
        if (n > this.step) {                      // 中间缺了几条：不硬执行，去要
          /**
           * 观战者**不能**发 need（它是只读连接，发了服务端也会拒）。
           * 它靠的是 transport.since：只有真的收到才推进，所以缺的那几条
           * 下一轮 poll 会原样带回来，等到了自然接上。
           */
          if (this.isWatcher) return false;
          this.requestCatchUp();
          return false;
        }
        try {
          this.applyAction(msg.a);
        } catch (err) {
          // 远端来的操作本地执行失败 = 两端状态已经不一致了，必须停下
          this.conflict = `第 ${this.step + 1} 步无法执行对手的操作：${err.message}`;
          this.setStatus('closed');
          return false;
        }
        this.history.push(msg.a);
        this.step++;
        this.onAction(msg.a, false);
        return true;
      }

      case 'need': {
        // 观战者没有 history 可给（它本来就不该被要）
        if (this.isWatcher) return false;
        // 对端缺了一段：把我这边第 from 步之后的原样发过去
        if (!this.state) return false;
        const from = Math.max(0, Number(msg.from) || 0);
        this.queueSend({ t: 'give', from, list: this.history.slice(from, from + 400) }).catch(() => {});
        return false;
      }

      case 'give': {
        // 观战者不会发 need，也就不会收到 give
        if (this.isWatcher) return false;
        if (!this.state) return false;
        const from = Math.max(0, Number(msg.from) || 0);
        if (from !== this.step) return false;    // 不是我缺的那一段
        let changed = false;
        for (const a of (Array.isArray(msg.list) ? msg.list : [])) {
          try {
            this.applyAction(a);
          } catch (err) {
            this.conflict = `补齐第 ${this.step + 1} 步失败：${err.message}`;
            this.setStatus('closed');
            return changed;
          }
          this.history.push(a);
          this.step++;
          this.onAction(a, false);
          changed = true;
        }
        return changed;
      }

      case 'hash': {
        /**
         * 观战者不比对指纹：它不发送、也没有对方的步数语境，比了只会误报；
         * 而且指纹对不上时它会把自己判成「跑飞」，把整个观战会话关掉。
         */
        if (this.isWatcher) return false;
        if (!this.state) return false;
        // 步数不同就不比指纹：那条指纹属于另一格状态，比了只会误报「跑飞」
        if (typeof msg.step === 'number' && msg.step > this.step) {
          this.requestCatchUp();
          return false;
        }
        if (msg.step === this.step) {
          const mine = stateHash(this.state);
          if (mine !== msg.h) {
            this.conflict = `与对手的进度不一致（第 ${msg.step} 步：${mine} vs ${msg.h}）`;
            this.setStatus('closed');
          }
        }
        return false;
      }

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
      this.loop();
      return;
    }
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
        ws = new WebSocket(`${proto}//${globalThis.location.host}${this.transport.url('/ws', { since: this.transport.since })}`);
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

  async loop() {
    let lastOk = Date.now();
    while (this.running) {
      try {
        const { msgs, peerLeft, watchers } = await this.transport.poll();
        if (!this.running) break;
        lastOk = Date.now();
        this.setStatus('connected');

        let changed = false;
        for (const m of msgs) {
          if (m.from === this.who) continue;   // 自己发的不用再处理一遍
          if (this.handleMessage(m.msg, m.from)) changed = true;
        }
        // 观战人数变了也要重绘一次（大厅上那行「有 N 人在观战」）
        if (typeof watchers === 'number' && watchers !== this.watchers) {
          this.watchers = watchers;
          changed = true;
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
    // 观战者不发 bye：那会让两端以为「对手离开了」
    if (!this.isWatcher) {
      try { await this.transport.send({ t: 'bye', reason: 'left' }); } catch { /* 忽略 */ }
    }
    await this.transport.leave();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
