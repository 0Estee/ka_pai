#!/usr/bin/env node
/**
 * 联机双客户端探针：两个**真实的** Session 走真实房间服务打一整局，比对两端步数与指纹。
 *
 * 和 tools/check-online-match.mjs 的分工：
 *   那份是"复刻一份锁步逻辑"去测服务端契约；
 *   这份直接 import app/js/multiplayer.js 的 Session —— 测的就是线上跑的那份代码。
 *
 * 用法：
 *   node tools/probe-mp.mjs                          # 打线上 www.wangzuo.icu
 *   node tools/probe-mp.mjs http://127.0.0.1:8787    # 打本地 wrangler dev
 *
 * 依赖：Node 22（全局 fetch + WebSocket）。会真的建一个房间号，两小时没人动自动回收。
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(url.fileURLToPath(new URL('..', import.meta.url)));
const BASE = (process.argv[2] || 'https://www.wangzuo.icu').replace(/\/$/, '');
const u = new URL(BASE);

// Session 读 globalThis.location 拼同源地址；Node 里给一个等价的
globalThis.location = {
  protocol: u.protocol,
  host: u.host,
  search: '',
  href: BASE + '/',
};
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const s = typeof input === 'string' ? input : (input && input.url);
  return realFetch(typeof s === 'string' && s.startsWith('/') ? BASE + s : input, init);
};

const { Session } = await import(url.pathToFileURL(path.join(ROOT, 'app/js/multiplayer.js')).href);
const G = await import(url.pathToFileURL(path.join(ROOT, 'engine/src/engine.js')).href);
const { TEST_CARD_LIB, buildTestDeck } = await import(url.pathToFileURL(path.join(ROOT, 'engine/cards/test-cards.js')).href);
const t0 = Date.now();
const T = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
const log = (...a) => console.log('[' + T() + 's]', ...a);

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
let room = ''; for (let i = 0; i < 6; i++) room += alphabet[Math.floor(Math.random() * alphabet.length)];
log('房间号', room);

const mk = (who) => {
  const s = new Session({
    who, room, cardLib: TEST_CARD_LIB,
    onUpdate: () => {},
    onStatus: (st) => log(who, 'STATUS', st),
    onStart: () => log(who, 'START'),
    onAction: () => {},
  });
  const orig = s.handleMessage.bind(s);
  s.handleMessage = (msg, from) => {
    const r = orig(msg, from);
    if (msg && (msg.t === 'act' || msg.t === 'start' || msg.t === 'hello')) {
      log(who, '收', msg.t, 'from=' + from, msg.t === 'act' ? JSON.stringify(msg.a) : '', '-> since=' + s.transport.since, 'step=' + s.step);
    }
    return r;
  };
  const origSubmit = s.submit.bind(s);
  s.submit = async (a) => {
    const r = await origSubmit(a);
    log(who, '发', JSON.stringify(a), 'ok=' + r, 'step=' + s.step, s.lastError ? 'err=' + s.lastError : '');
    return r;
  };
  return s;
};
const host = mk('host'); const guest = mk('guest');
host.start(); guest.start();
host.transport.send({ t: 'hello', name: '玩家1', faction: 'demon' });
guest.transport.send({ t: 'hello', name: '玩家2', faction: 'god' });
await new Promise(r => setTimeout(r, 1500));
log('peerName', JSON.stringify([host.peerName, guest.peerName]));
const peerHelloSeen = host.peerName !== '' && guest.peerName !== '';

const seed = 424242; const deck = buildTestDeck(80, seed);
await host.beginGame({ seed, firstPlayer: 0, deck, factions: ['demon', 'god'], enhance: null, mode: 'normal' });
for (let i = 0; i < 60 && !guest.started; i++) await new Promise(r => setTimeout(r, 200));
log('客人 start?', guest.started);
host.state.autoResolveChoices = true; if (guest.state) guest.state.autoResolveChoices = true;

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let steps = 0, plays = 0, advances = 0;
for (let guard = 0; guard < 300; guard++) {
  const st = host.state;
  if (!st) break;
  if (st.winner !== null) { log('结束 winner=', st.winner); break; }
  const actor = G.getActor(st);
  if (actor === null) {
    await host.submit({ k: 'a' }); advances++;
  } else {
    const pl = G.getLegalPlays(st, actor);
    const sess = actor === 0 ? host : guest;
    let action;
    if (pl.length) {
      const p = pl[0];
      action = { k: 'p', s: actor, i: p.iid, o: p.places[0] ? { lane: p.places[0].lane, row: p.places[0].row } : {} };
      plays++;
    } else { action = { k: 'a' }; advances++; }
    const ok = await sess.submit(action);
    if (!ok) { log('!! side' + actor + ' 提交失败', sess.lastError); break; }
  }
  await wait(30);
  steps++;
  if (host.step !== guest.step) {
    // 落后是常态（一条消息在路上也就几十~几百毫秒），等它追上来再说"分叉"
    for (let k = 0; k < 40 && host.step !== guest.step; k++) await wait(50);
    if (host.step !== guest.step) {
      log('!! 分叉 host.step', host.step, 'guest.step', guest.step, 'turn', host.state.turn);
      break;
    }
  }
  if (host.conflict || guest.conflict) { log('!! conflict', host.conflict, guest.conflict); break; }
  if (!host.running || !guest.running) { log('!! 会话停止'); break; }
}
log('steps loop=%d plays=%d advances=%d host.step=%d guest.step=%d turn=%d', steps, plays, advances, host.step, guest.step, host.state.turn);
log('hello 互通:', peerHelloSeen, 'status:', host.status, guest.status);
await new Promise(r => setTimeout(r, 3000));
log('末态 host.step=%d guest.step=%d 一致=%s', host.step, guest.step, String(host.step === guest.step));
process.exit(0);
