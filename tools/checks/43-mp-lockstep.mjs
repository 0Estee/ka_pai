/**
 * § 联机锁步：开局顺序、抢跑的操作、丢包补齐
 *
 * 这三条都是「不同网络下双方都出不了牌」这一份反馈拆出来的：
 *
 *  1. **开局顺序**：主机必须先把 start 发出去，再本地开局。反过来的话，
 *     applyStart 会回调 onStart → 界面上屏 → tick() 排下第一拍自动阶段，
 *     而那时 start 还在路上 —— 第一条 {k:'a'} 抢在 start 前面到达对端被丢掉，
 *     两端步数从此永久差一截。局域网 RTT 几毫秒，抢跑窗口小到踩不中；
 *     跨网络一趟几百毫秒，每次都踩中。
 *  2. **抢跑的操作不能丢**：真出现了（WS 重连补发、服务端重排），先攒着，
 *     start 一到按原顺序补执行。
 *  3. **丢包要能自己补回来**：每条操作带序号 n，发现缺口就向对端要
 *     （need / give），而不是硬执行一条接不上的操作。
 *
 * 这里直接用 app/js/multiplayer.js 的 Session（纯 JS，不碰 DOM），
 * 只把 transport 换成进程内的假链路 —— 要测的是客户端逻辑，不是网络。
 */

import { acheck } from './harness.mjs';
import * as G from '../../engine/src/engine.js';
import { TEST_CARD_LIB, buildTestDeck } from '../../engine/cards/test-cards.js';
import { Session, stateHash } from '../../app/js/multiplayer.js';

console.log('\n§ 联机锁步');

/** 进程内假链路：消息先落在 outbox，由测试决定什么时候投递给对端 */
function makeNet() {
  const outbox = { host: [], guest: [] };
  const inbox = { host: [], guest: [] };
  const link = (who) => ({
    since: 0,
    async send(msg) {
      outbox[who].push(msg);
      return { ok: true };
    },
    async start() { return { ok: true }; },
    async leave() {},
    async poll() {
      const q = inbox[who];
      const msgs = q.splice(0, q.length);
      return { msgs, peerLeft: false };
    },
  });
  /** 把 outbox 里的消息全投递给对端；skip(who, msg, index) 返回 true 就丢掉这条 */
  const flush = (skip) => {
    let moved = 0;
    for (const who of ['host', 'guest']) {
      const peer = who === 'host' ? 'guest' : 'host';
      const q = outbox[who];
      outbox[who] = [];
      q.forEach((msg, i) => {
        if (skip && skip(who, msg, i)) return;
        inbox[peer].push({ seq: moved, from: who, msg });
        moved++;
      });
    }
    return moved;
  };
  return { link, flush, outbox, inbox };
}

const SEED = 20261021;
const DECK = buildTestDeck(80, SEED);
const PARAMS = {
  seed: SEED, firstPlayer: 0, deck: DECK, factions: ['demon', 'god'], enhance: null, mode: 'normal',
};

function makeSession(who, net, hooks = {}) {
  const s = new Session({
    who, room: 'TESTRM', cardLib: TEST_CARD_LIB,
    onUpdate: () => {},
    onStatus: (st) => { if (hooks.onStatus) hooks.onStatus(st); },
    onStart: (st) => { if (hooks.onStart) hooks.onStart(st); },
    onAction: () => {},
  });
  s.transport = net.link(who);
  return s;
}

/** 把会话收件箱里的消息全部处理掉（模拟一轮轮询） */
function drain(sess) {
  const q = net.inbox ? net.inbox[sess.who] : [];
  const msgs = q.splice(0, q.length);
  let changed = false;
  for (const m of msgs) {
    if (sess.handleMessage(m.msg, m.from)) changed = true;
  }
  return changed;
}

let net = makeNet();

// ── 1. 开局顺序：start 一定要排在所有操作前面 ──────────────
await acheck('开局：主机先发 start，再本地开局（否则第一条操作会抢在 start 前面）', async () => {
  net = makeNet();
  const host = makeSession('host', net);
  let sentAtStart = null;
  host.onStart = () => { sentAtStart = net.outbox.host.map((m) => m.t); };
  await host.beginGame(PARAMS);
  if (!sentAtStart || !sentAtStart.length) throw new Error('onStart 时一条消息都没发出去');
  if (sentAtStart[0] !== 'start') throw new Error('本地开局时 start 还没发出去（顺序反了）：' + JSON.stringify(sentAtStart));
  if (host.step !== 0) throw new Error('本地开局时不该已经有操作落地，step=' + host.step);
});

// ── 2. 抢跑的操作不能丢 ────────────────────────────────────
await acheck('开局前抢跑到达的操作会被暂存，start 之后按序补执行', () => {
  net = makeNet();
  const guest = makeSession('guest', net);
  // 对端已经走了一步，但 start 还在路上
  guest.handleMessage({ t: 'act', a: { k: 'a' }, n: 0 }, 'host');
  if (guest.step !== 0) throw new Error('还没 start 就把操作执行了');
  guest.handleMessage({ t: 'start', ...PARAMS }, 'host');
  if (!guest.started) throw new Error('start 没有开局');
  if (guest.step !== 1) throw new Error('抢跑的那条操作被丢掉了，step=' + guest.step);
  if (guest.state.turn !== 1) throw new Error('补执行后回合数不对：' + guest.state.turn);
});

// ── 3. 丢了一条操作：靠 need / give 补回来 ────────────────
await acheck('丢了一条操作：发现缺口后自动向对端补齐，两端指纹重新一致', async () => {
  net = makeNet();
  const host = makeSession('host', net);
  const guest = makeSession('guest', net);
  const hostMsgs = [];
  const guestMsgs = [];
  host.handleMessage = ((orig) => (msg, from) => { hostMsgs.push(msg.t); return orig(msg, from); })(host.handleMessage.bind(host));
  guest.handleMessage = ((orig) => (msg, from) => { guestMsgs.push(msg.t); return orig(msg, from); })(guest.handleMessage.bind(guest));

  await host.beginGame(PARAMS);
  net.flush();
  drain(guest);                       // 客人拿到 start
  if (!guest.started) throw new Error('客人没收到 start');

  // 走够几步，让两端都有棋盘上的操作
  const pick = (st, side) => {
    const plays = G.getLegalPlays(st, side);
    if (!plays.length) return { k: 'a' };
    const p = plays[0];
    return { k: 'p', s: side, i: p.iid, o: p.places[0] ? { lane: p.places[0].lane, row: p.places[0].row } : {} };
  };
  let dropped = 0;
  for (let i = 0; i < 12; i++) {
    const st = host.state;
    if (!st || st.winner !== null) break;
    const actor = G.getActor(st);
    if (actor === null) { await host.submit({ k: 'a' }); }
    else {
      const sess = actor === 0 ? host : guest;
      await sess.submit(pick(st, actor));
    }
    // 第三条发给客人的消息故意丢掉
    net.flush((who, msg) => (who === 'host' && msg.t === 'act' && dropped === 0 && (dropped = 1)));
    drain(guest);
    drain(host);
    if (guest.step !== host.step) {
      // 缺口出现了：让它把需要补齐的请求跑完
      for (let k = 0; k < 4; k++) { net.flush(); drain(guest); drain(host); }
    }
  }
  if (!dropped) throw new Error('测试没造出丢包');
  if (guest.step !== host.step) throw new Error('补齐后步数仍不一致：' + guest.step + ' vs ' + host.step);
  if (stateHash(guest.state) !== stateHash(host.state)) throw new Error('补齐后两端指纹不一致');
  if (!guestMsgs.includes('give')) throw new Error('客人没有收到补齐包（give）');
  if (!hostMsgs.includes('need')) throw new Error('主机没有收到补齐请求（need）');
});
