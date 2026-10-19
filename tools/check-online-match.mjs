/**
 * 联机「真打一局」检查：两个真实的 Session 通过 HTTP 服务端互相同步，
 * 一直打到分出胜负，最后比对两端的状态指纹。
 *
 * 这一步**必须存在**，因为前面那些接口检查证明不了最关键的那件事：
 * 「两边跑同一个引擎、收到同一条操作各执行一次」在真实的网络往返下还成立。
 * 如果 seq / since / 自己发的过滤 有任何一处写错，这里会出现
 * 「操作丢失」「重复执行」「两端状态分叉」—— 而接口层全是绿的。
 *
 * 用法：
 *   node tools/check-online-match.mjs                    # 本地
 *   node tools/check-online-match.mjs https://www.wangzuo.icu   # 线上（正式站）
 */

import * as G from '../engine/src/engine.js';
import { LANES, ROWS } from '../engine/src/constants.js';
import { TEST_CARD_LIB, buildTestDeck } from '../engine/cards/test-cards.js';

const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');

// ── 造一个「最小可用的 Session」：复刻 app/js/multiplayer.js 的锁步逻辑，
//    但不碰 DOM。这里刻意**不 import** 那个文件 —— 它读 globalThis.location、
//    还要 cardLib 等浏览器侧依赖，塞一堆桩反而更容易把要测的东西测丢。
//    真正要验证的是「服务端契约 + 锁步算法」能不能一起跑完一局。

const HASH_EVERY = 8;
const POLL_TIMEOUT = 20000;

function stateSignature(state) {
  const parts = [
    state.turn, state.phase,
    state.winner === null ? '-' : state.winner,
    state.players[0].kingHp, state.players[1].kingHp,
    state.players[0].hand.length, state.players[1].hand.length,
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

function stateHash(state) {
  const s = stateSignature(state);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

class Net {
  constructor(who, room) {
    this.who = who;
    this.room = room;
    this.since = 0;
    this.stopped = false;
  }

  url(path, extra) {
    const q = new URLSearchParams({ who: this.who, room: this.room });
    for (const [k, v] of Object.entries(extra || {})) q.set(k, String(v));
    return `${BASE}${path}?${q}`;
  }

  async send(msg) {
    const r = await fetch(this.url('/api/send'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    });
    return r.json();
  }

  async poll(timeout = POLL_TIMEOUT) {
    if (this.stopped) return { msgs: [], peerLeft: false };
    const r = await fetch(this.url('/api/poll', { since: this.since, timeout }));
    const data = await r.json();
    if (data && data.ok === false && data.error === 'peer-left') return { msgs: [], peerLeft: true };
    if (!data || !data.ok) return { msgs: [], peerLeft: false };
    for (const m of data.msgs || []) if (m.seq >= this.since) this.since = m.seq + 1;
    return { msgs: data.msgs || [], peerLeft: false };
  }

  async start() { await fetch(this.url('/api/start'), { method: 'POST' }); }
  async leave() {
    this.stopped = true;
    await fetch(this.url('/api/leave'), { method: 'POST' });
  }
}

class Session {
  constructor(who, room) {
    this.who = who;
    this.isHost = who === 'host';
    this.mySide = this.isHost ? 0 : 1;
    this.net = new Net(who, room);
    this.state = null;
    this.step = 0;
    this.started = false;
    this.conflict = null;
    this.running = false;
    this.lastError = '';
  }

  async beginGame({ seed, firstPlayer, deck, factions }) {
    this.applyStart({ seed, firstPlayer, deck, factions });
    await this.net.start();
    await this.net.send({ t: 'start', seed, firstPlayer, deck, factions });
  }

  applyStart({ seed, firstPlayer, deck, factions }) {
    this.state = G.createGame({
      seed, firstPlayer, deck, cardLib: TEST_CARD_LIB, factions: (factions || []).slice(),
    });
    G.startGame(this.state);
    this.state.autoResolveChoices = false;
    this.started = true;
    this.step = 0;
  }

  applyAction(a) {
    const st = this.state;
    if (!st) throw new Error('对局还没开始');
    if (a.k === 'a') G.advance(st);
    else if (a.k === 'p') G.playCard(st, a.s, a.i, a.o || {});
    else if (a.k === 'c') G.resolveChoice(st, a.v);
    else if (a.k === 'x') G.sacrificeUnit(st, a.s, a.u);
    else if (a.k === 's') G.surrender(st, a.s);
    else if (a.k === 'b') G.brew(st, a.s, a.i);
    else throw new Error(`未知操作 ${a.k}`);
  }

  async submit(a) {
    if (this.conflict || !this.state) return false;
    try { this.applyAction(a); } catch (err) { this.lastError = err.message; return false; }
    this.lastError = '';
    this.step++;
    if (this.step % HASH_EVERY === 0) {
      try { await this.net.send({ t: 'hash', step: this.step, h: stateHash(this.state) }); } catch { /* 忽略 */ }
    }
    await this.net.send({ t: 'act', a });
    return true;
  }

  handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return false;
    switch (msg.t) {
      case 'start':
        if (this.started) return false;
        this.applyStart(msg);
        return true;
      case 'act':
        if (!this.state) return false;
        try { this.applyAction(msg.a); } catch (err) {
          this.conflict = `第 ${this.step + 1} 步无法执行对手的操作：${err.message}`;
          return false;
        }
        this.step++;
        return true;
      case 'hash':
        if (msg.step === this.step && this.state) {
          const mine = stateHash(this.state);
          if (mine !== msg.h) this.conflict = `第 ${msg.step} 步指纹不一致：${mine} vs ${msg.h}`;
        }
        return false;
      default:
        return false;
    }
  }

  /** 后台收消息 */
  startLoop() {
    this.running = true;
    const run = async () => {
      while (this.running) {
        try {
          const { msgs, peerLeft } = await this.net.poll();
          if (!this.running) break;
          for (const m of msgs) {
            if (m.from === this.who) continue;
            this.handleMessage(m.msg);
          }
          if (peerLeft || this.conflict) { this.running = false; break; }
        } catch {
          if (!this.running) break;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    };
    this.loopPromise = run();
  }

  stop() { this.running = false; }
}

// ── 「代打」：按引擎给的合法操作表挑一个，两个 Session 用的是同一套逻辑，
//    谁该走由 turn / phase 决定，所以两边能各自独立推进。

function whoseTurn(st) {
  if (st.winner !== null) return -1;
  if (st.phase === 'choice') return st.choice ? st.choice.side : -1;
  return st.turn % 2 === 0 ? 0 : 1;
}

/** 给这一侧挑一个合法的动作；没有可做的就返回 advance */
function pickAction(st, side, rng) {
  if (st.winner !== null) return null;

  if (st.phase === 'choice') {
    if (!st.choice || st.choice.side !== side) return null;
    const opts = st.choice.options || [];
    if (!opts.length) return { k: 'c', v: null };
    return { k: 'c', v: opts[Math.floor(rng() * opts.length)] };
  }

  if (st.phase === 'main') {
    const hand = st.players[side].hand;
    // 先试试能不能出牌（每局上限 40 次尝试，避免死循环）
    for (let tryN = 0; tryN < 40; tryN++) {
      const c = hand[Math.floor(rng() * hand.length)];
      if (!c) break;
      const o = { lane: LANES[Math.floor(rng() * LANES.length)] };
      if (c.type === 'unit') o.row = ROWS[Math.floor(rng() * ROWS.length)];
      try {
        // 试探：拷一份状态来试，不污染真的
        const copy = structuredClone(st);
        G.playCard(copy, side, c.iid, o);
        return { k: 'p', s: side, i: c.iid, o };
      } catch { /* 这张不行，换一张 */ }
    }
  }
  return { k: 'a' };
}

// ── 主流程

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
let room = '';
for (let i = 0; i < 6; i++) room += alphabet[Math.floor(Math.random() * alphabet.length)];

console.log(`联机对局检查 → ${BASE}   房间 ${room}\n`);

const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
const deck = buildTestDeck(80, seed);
const factions = ['flame', 'tide'];

const host = new Session('host', room);
const guest = new Session('guest', room);
host.startLoop();
guest.startLoop();

await host.beginGame({ seed, firstPlayer: seed % 2, deck, factions });

// 等客人收到 start
for (let i = 0; i < 100 && !guest.started; i++) await new Promise((r) => setTimeout(r, 50));
if (!guest.started) {
  console.log('❌ 客人没有收到开局消息');
  process.exit(1);
}
console.log('  ✓ 双方都拿到同一份开局参数');

// 轮转推演：每次挑当前该走的一方，让它出一个操作，等对面收到再继续。
// 上限设得很大：真正的终止条件是对局结束或操作数超限（用来抓卡死）。
let rngState = seed || 1;
const rng = () => {
  rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0;
  return rngState / 4294967296;
};

const MAX_STEPS = 4000;
let ops = 0;
let stuck = 0;

while (ops < MAX_STEPS) {
  const st = host.state;
  if (!st || st.winner !== null) break;
  if (host.conflict || guest.conflict) break;

  const side = whoseTurn(st);
  if (side < 0) break;
  const me = side === 0 ? host : guest;

  // 只让「该走的那一方」动手，且必须两边步数一样才动手（保证顺序）
  if (host.step !== guest.step) { await new Promise((r) => setTimeout(r, 20)); continue; }

  const action = pickAction(me.state, side, rng);
  if (!action) break;

  const before = me.step;
  const sent = await me.submit(action);
  if (!sent) { stuck++; if (stuck > 40) break; continue; }
  stuck = 0;
  ops++;

  // 等对面追上来
  for (let i = 0; i < 200 && guest.step === before; i++) await new Promise((r) => setTimeout(r, 10));
  if (guest.step === before && host.step === before) break;
}

const st = host.state;
const sigH = stateSignature(host.state);
const sigG = stateSignature(guest.state);

console.log(`  操作数 ${ops}   步数 host=${host.step} guest=${guest.step}   回合 ${st ? st.turn : '-'}   胜者 ${st ? st.winner : '-'}`);

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${extra ? `  —— ${extra}` : ''}`); }
};

ok('对局真的打完了（分出胜负）', st && st.winner !== null, `winner=${st && st.winner}`);
ok('两端步数一致', host.step === guest.step, `host=${host.step} guest=${guest.step}`);
ok('两端状态完全一致', sigH === sigG, sigH === sigG ? '' : `\n    host : ${sigH.slice(0, 160)}\n    guest: ${sigG.slice(0, 160)}`);
ok('没有同步冲突', !host.conflict && !guest.conflict, `${host.conflict || ''} ${guest.conflict || ''}`.trim());
ok('操作数合理（不是空跑）', ops > 30, `ops=${ops}`);

host.stop();
guest.stop();
await host.net.leave();

console.log(`\n${'─'.repeat(52)}`);
if (fail === 0) {
  console.log(`✅ 联机对局检查通过：${pass} 项`);
  process.exit(0);
}
console.log(`❌ 有 ${fail} 项失败（通过 ${pass} 项）`);
process.exit(1);
