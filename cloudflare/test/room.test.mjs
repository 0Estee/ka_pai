/**
 * 房间服务测试：观战（作者 2026-10-23）+ 原有的两端语义。
 *
 * 观战者是一条**只读**连接：它要能收到两端的全部消息，但绝不能往锁步流里插东西，
 * 也不能因为来了 / 走了就影响「对手是否还在」。这些约束在代码里都是几行判断，
 * 但错一行就会变成「有人观战，对局两边都出不了牌」——所以要在这里钉住。
 *
 * 用内存 storage 桩直接调 Room.fetch，不需要 wrangler、不需要联网。
 * 用法：node cloudflare/test/room.test.mjs
 */

import { Room } from '../src/room.js';

const BASE = 'https://room.test';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  —— ' + extra : '')); }
}
function section(title) { console.log('\n── ' + title); }

function makeStorage() {
  const map = new Map();
  return {
    map,
    async get(k) { return map.has(k) ? structuredClone(map.get(k)) : undefined; },
    async put(k, v) { map.set(k, structuredClone(v)); },
    async delete(k) { return map.delete(k); },
    async list() { return new Map(map); },
    async deleteAll() { map.clear(); },
    async setAlarm() { /* 测试里不需要真的排闹钟 */ },
  };
}

function makeCtx(storage) {
  return {
    storage,
    blockConcurrencyWhile(fn) { return Promise.resolve().then(fn); },
    getWebSockets() { return []; },
    acceptWebSocket() { throw new Error('测试不走 WebSocket'); },
  };
}

async function newRoom() {
  const room = new Room(makeCtx(makeStorage()), {});
  // 构造函数的 blockConcurrencyWhile 是异步跑的，等它一拍
  await new Promise((r) => setTimeout(r, 0));
  return room;
}

async function call(room, path, { method = 'GET', body, query = {} } = {}) {
  const q = new URLSearchParams(query).toString();
  const url = BASE + path + (q ? '?' + q : '');
  const init = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const res = await room.fetch(new Request(url, init));
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}

const poll = (room, who, since, extra = {}) => call(room, '/api/poll', { query: { who, since, timeout: '30', ...extra } });
const send = (room, who, msg, extra = {}) => call(room, '/api/send', { method: 'POST', body: msg, query: { who, ...extra } });

console.log('房间服务测试（观战 / 只读连接）');

// ── 1. 两端语义没被改坏 ────────────────────────────────────
{
  section('1. 两端：消息只推给对方');
  const room = await newRoom();
  await send(room, 'host', { t: 'hello', name: '房主' });
  await send(room, 'guest', { t: 'hello', name: '客人' });

  const hostView = await poll(room, 'host', 0);
  const guestView = await poll(room, 'guest', 0);
  ok('房主能收到客人的 hello', JSON.stringify(hostView.body.msgs || []).includes('客人'), JSON.stringify(hostView.body));
  ok('客人能收到房主的 hello', JSON.stringify(guestView.body.msgs || []).includes('房主'), JSON.stringify(guestView.body));
  ok('房主不会收到自己发的 hello',
    (hostView.body.msgs || []).every((m) => m.from !== 'host'), JSON.stringify(hostView.body.msgs));
}

// ── 2. 观战：收得到，发不了 ────────────────────────────────
{
  section('2. 观战者：能看两端的消息，但发不出去');
  const room = await newRoom();
  const before = await call(room, '/api/room', { query: { room: 'ABCD' } });
  await send(room, 'host', { t: 'start', seed: 1 });
  await send(room, 'guest', { t: 'act', a: { k: 'a' }, n: 0 });

  const watchView = await poll(room, 'watch', 0, { wid: 'w1' });
  const msgs = watchView.body.msgs || [];
  ok('观战者拿到房主与客人的消息（两条都在）',
    msgs.length === 2 && msgs.some((m) => m.from === 'host') && msgs.some((m) => m.from === 'guest'),
    JSON.stringify(msgs));
  ok('观战响应带 watching 标记', watchView.body.watching === true, JSON.stringify(watchView.body));

  const trySend = await send(room, 'watch', { t: 'act', a: { k: 'p' }, n: 0 });
  ok('观战者发消息被 403 拒绝', trySend.status === 403 && trySend.body.error === 'read-only', JSON.stringify(trySend.body));

  const after = await poll(room, 'watch', 0, { wid: 'w1' });
  ok('被拒的消息没有进日志（还是那两条）', (after.body.msgs || []).length === 2, JSON.stringify(after.body.msgs));

  ok('房间信息里能读出观战人数', (await call(room, '/api/room', { query: { room: 'ABCD' } })).body.watchers === 1);
  ok('房间信息初值 starts 空（没有观战时是 0）', before.body.watchers === 0, JSON.stringify(before.body));
}

// ── 3. 观战者不影响「对手还在不在」 ────────────────────────
{
  section('3. 观战者来了 / 走了，两端的 peer-left 判断不受影响');
  const room = await newRoom();
  await send(room, 'host', { t: 'hello' });
  await send(room, 'guest', { t: 'hello' });
  await poll(room, 'watch', 0, { wid: 'w1' });

  const hostPoll = await poll(room, 'host', 0);
  ok('有人观战时房主照常收到消息（没有 peer-left）', hostPoll.body.ok === true, JSON.stringify(hostPoll.body));

  await call(room, '/api/leave', { method: 'POST', query: { who: 'watch', wid: 'w1' } });
  ok('观战者离开只清自己的心跳', (await call(room, '/api/room', { query: { room: 'ABCD' } })).body.watchers === 0);
  const guestPoll = await poll(room, 'guest', 0);
  ok('观战者离开后客人也没被判成 peer-left', guestPoll.body.ok === true, JSON.stringify(guestPoll.body));
}

// ── 4. 两端都走了，观战者才结束 ────────────────────────────
{
  section('4. 观战者的结束条件：两端都离开');
  const room = await newRoom();
  await send(room, 'host', { t: 'start' });
  await send(room, 'guest', { t: 'hello' });
  await call(room, '/api/leave', { method: 'POST', query: { who: 'guest' } });

  const w1 = await poll(room, 'watch', 0, { wid: 'w1' });
  ok('只有客人离开时，观战者继续看', w1.body.ok === true, JSON.stringify(w1.body));

  await call(room, '/api/leave', { method: 'POST', query: { who: 'host' } });
  const w2 = await poll(room, 'watch', 0, { wid: 'w1' });
  ok('两端都走了，观战者收到 peer-left', w2.body.ok === false && w2.body.error === 'peer-left', JSON.stringify(w2.body));
}

// ── 5. 观战者不能替别人开局 ────────────────────────────────
{
  section('5. 观战者不能标记「已开局」');
  const room = await newRoom();
  const r = await call(room, '/api/start', { method: 'POST', query: { who: 'watch' } });
  ok('观战者的 /api/start 被忽略', r.body.ignored === true, JSON.stringify(r.body));
  ok('房间仍然没被标记成已开局',
    (await call(room, '/api/room', { query: { room: 'ABCD' } })).body.started === false);
}

console.log('\n' + '─'.repeat(52));
if (fail) {
  console.log('❌ 失败 ' + fail + ' 项 / 通过 ' + pass + ' 项');
  process.exit(1);
}
console.log('✅ 房间服务测试全部通过：' + pass + ' 项');
