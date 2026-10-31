/**
 * 联机服务端的端到端检查：真的发 HTTP 请求走一遍两个玩家的握手与出牌。
 *
 * 为什么单独写一个：`tools/check-bundle.mjs` 那些是静态检查（读源码断言），
 * 而合同另一头是**另一个进程里的 Durable Object** —— 只有真打请求才能确认
 * 房间隔离、seq 单调、长轮询唤醒、离开通知这些「时序」性质没写反。
 *
 * 用法：
 *   node tools/check-online.mjs                       # 跑本地 wrangler dev（默认 8787）
 *   node tools/check-online.mjs https://wangzuo.icu   # 跑线上（正式站）
 */

const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? `  —— ${extra}` : ''}`);
  }
}

async function jget(path) {
  const r = await fetch(`${BASE}${path}`, { cache: 'no-store' });
  return r.json();
}

async function jsend(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

const roomCode = () => {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`联机服务端端到端检查 → ${BASE}\n`);

// ── 1. 健康检查
{
  const h = await jget('/api/health');
  ok('健康检查返回 ok', h && h.ok === true, JSON.stringify(h));
}

// ── 2. 房间号校验
{
  const bad = await jget('/api/room?room=ab');
  ok('太短的房间号被拒绝', bad && bad.ok === false, JSON.stringify(bad));
  const none = await jget('/api/room');
  ok('不带房间号被拒绝', none && none.ok === false, JSON.stringify(none));
}

// ── 3. 两个房间互相隔离（最容易写错的一条：路由没按房间号走）
{
  const r1 = roomCode();
  const r2 = roomCode();
  await jsend(`/api/send?who=host&room=${r1}`, { t: 'hello', name: '主机甲' });
  const p2 = await jget(`/api/poll?who=guest&room=${r2}&since=0&timeout=0`);
  ok('房间隔离：另一个房间收不到这条消息', p2.ok && p2.msgs.length === 0, JSON.stringify(p2));
  const p1 = await jget(`/api/poll?who=guest&room=${r1}&since=0&timeout=0`);
  ok('同房间能收到', p1.ok && p1.msgs.length === 1, JSON.stringify(p1));
}

// ── 4. seq 单调递增、且不把自己的消息推回来
{
  const r = roomCode();
  const a = await jsend(`/api/send?who=host&room=${r}`, { t: 'n', i: 1 });
  const b = await jsend(`/api/send?who=host&room=${r}`, { t: 'n', i: 2 });
  ok('seq 从 0 起、逐条 +1', a.seq === 0 && b.seq === 1, `${a.seq},${b.seq}`);
  const self = await jget(`/api/poll?who=host&room=${r}&since=0&timeout=0`);
  ok('自己发的不回给自己', self.ok && self.msgs.length === 0, JSON.stringify(self));
  const peer = await jget(`/api/poll?who=guest&room=${r}&since=0&timeout=0`);
  ok('对端收到两条且顺序正确',
    peer.msgs.length === 2 && peer.msgs[0].msg.i === 1 && peer.msgs[1].msg.i === 2,
    JSON.stringify(peer.msgs.map((m) => m.msg.i)));
  const after = await jget(`/api/poll?who=guest&room=${r}&since=2&timeout=0`);
  ok('since 之后没有新消息时返回空', after.ok && after.msgs.length === 0, JSON.stringify(after));
}

// ── 5. 长轮询：挂着的请求会被新消息叫醒
{
  const r = roomCode();
  const t0 = Date.now();
  const waiting = jget(`/api/poll?who=guest&room=${r}&since=0&timeout=8000`);
  await sleep(350);
  await jsend(`/api/send?who=host&room=${r}`, { t: 'wake' });
  const res = await waiting;
  const dt = Date.now() - t0;
  ok('长轮询被新消息叫醒', res.ok && res.msgs.length === 1 && res.msgs[0].msg.t === 'wake',
    JSON.stringify(res));
  ok('唤醒是立刻的（没有等满 8 秒）', dt < 4000, `用了 ${dt}ms`);
}

// ── 6. 长轮询超时：没消息也要按时返回，不能把请求挂死
{
  const r = roomCode();
  const t0 = Date.now();
  const res = await jget(`/api/poll?who=host&room=${r}&since=0&timeout=600`);
  const dt = Date.now() - t0;
  ok('超时后返回空结果', res.ok && res.msgs.length === 0, JSON.stringify(res));
  ok('超时时长大致准确（0.6s ±1s）', dt >= 500 && dt < 3000, `用了 ${dt}ms`);
}

// ── 7. 离开通知：对端立刻看到 peer-left，而不是等超时
{
  const r = roomCode();
  await jsend(`/api/send?who=host&room=${r}`, { t: 'hi' });
  await jget(`/api/poll?who=guest&room=${r}&since=0&timeout=0`);   // 客人先来过，才会被记成「在线」
  const t0 = Date.now();
  const waiting = jget(`/api/poll?who=guest&room=${r}&since=99&timeout=8000`);
  await sleep(300);
  await jsend(`/api/leave?who=host&room=${r}`, {});
  const res = await waiting;
  const dt = Date.now() - t0;
  ok('对手离开时长轮询立刻返回 peer-left', res.ok === false && res.error === 'peer-left',
    JSON.stringify(res));
  ok('不是等满 8 秒才返回', dt < 4000, `用了 ${dt}ms`);
}

// ── 8. 静态资源：首页、样式、打包产物都要能取到
{
  const r = await fetch(`${BASE}/`, { cache: 'no-store' });
  const html = await r.text();
  ok('首页 200', r.status === 200, `status=${r.status}`);
  ok('首页引用了 bundle.js', html.includes('dist/bundle.js'));
  ok('首页标题是王座交锋', html.includes('王座交锋'));

  const css = await fetch(`${BASE}/style.css`, { cache: 'no-store' });
  ok('style.css 200', css.status === 200, `status=${css.status}`);

  const bundle = await fetch(`${BASE}/dist/bundle.js`, { cache: 'no-store' });
  ok('bundle.js 200', bundle.status === 200, `status=${bundle.status}`);

  const mod = await fetch(`${BASE}/dist/modules/39-app-main.js`, { cache: 'no-store' });
  ok('模块脚本 200', mod.status === 200, `status=${mod.status}`);

  const img = await fetch(`${BASE}/img/claw-1-1.png`, { cache: 'no-store' });
  ok('卡图 200', img.status === 200, `status=${img.status}`);

  // 单页兜底：带查询参数的入口地址要回首页，不能是 404
  const entry = await fetch(`${BASE}/?net=guest&room=ABCDEF`, { cache: 'no-store' });
  const entryHTML = await entry.text();
  ok('入口链接（?net=guest&room=…）能打开首页', entry.status === 200 && entryHTML.includes('dist/bundle.js'),
    `status=${entry.status}`);
}

// ── 9. 同一房间连开两局：/api/start 之后 room 报 started
{
  const r = roomCode();
  await jsend(`/api/start?who=host&room=${r}`, {});
  const info = await jget(`/api/room?room=${r}`);
  ok('开始对战后房间标记 started', info.ok && info.started === true, JSON.stringify(info));
}

// ── 10. WebSocket 推送
//
// 客户端是「WebSocket 优先、连不上才回落长轮询」，所以这条推送通道必须有测试：
// 它一旦悄悄坏掉，线上表现只是「延迟变高、电量变费」，不会报错 —— 最难发现的那种退化。
if (typeof WebSocket === 'function') {
  const r = roomCode();
  const wsUrl = `${BASE.replace(/^http/, 'ws')}/ws?who=guest&room=${r}&since=0`;

  const got = await new Promise((resolve) => {
    const frames = [];
    let ws;
    const finish = () => {
      try { ws && ws.close(); } catch { /* 忽略 */ }
      resolve(frames);
    };
    const timer = setTimeout(finish, 6000);
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      clearTimeout(timer);
      resolve([`CONNECT-THROW ${err.message}`]);
      return;
    }
    ws.onopen = async () => {
      // 连上之后让主机发一条，看客人这边能不能收到推送
      await jsend(`/api/send?who=host&room=${r}`, { t: 'push-test' });
      // 再发一条「自己的」，用来验证不会回推给自己
      await jsend(`/api/send?who=guest&room=${r}`, { t: 'self-test' });
      await sleep(1200);
      clearTimeout(timer);
      finish();
    };
    ws.onmessage = (ev) => { try { frames.push(JSON.parse(ev.data)); } catch { /* 忽略非 JSON */ } };
    ws.onerror = () => { clearTimeout(timer); finish(); };
  });

  ok('WebSocket 能连上并收到推送', got.length >= 1 && got[0].msg && got[0].msg.t === 'push-test',
    JSON.stringify(got));
  ok('WebSocket 不把发送方自己的消息推回来',
    !got.some((f) => f.msg && f.msg.t === 'self-test'), JSON.stringify(got.map((f) => f.msg && f.msg.t)));

  // 连上时带着 since，服务端要先把漏掉的补上（断线重连靠这条）
  const r2 = roomCode();
  await jsend(`/api/send?who=host&room=${r2}`, { t: 'before-connect' });
  const replayed = await new Promise((resolve) => {
    let ws;
    const frames = [];
    const timer = setTimeout(() => { try { ws && ws.close(); } catch { /* 忽略 */ } resolve(frames); }, 4000);
    ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?who=guest&room=${r2}&since=0`);
    ws.onmessage = (ev) => {
      try { frames.push(JSON.parse(ev.data)); } catch { /* 忽略 */ }
      clearTimeout(timer);
      try { ws.close(); } catch { /* 忽略 */ }
      resolve(frames);
    };
    ws.onerror = () => { clearTimeout(timer); resolve(frames); };
  });
  ok('WebSocket 握手时补齐 since 之后的历史消息',
    replayed.length >= 1 && replayed[0].msg && replayed[0].msg.t === 'before-connect',
    JSON.stringify(replayed));
} else {
  console.log('  · 跳过 WebSocket 检查（当前 node 没有 WebSocket 全局）');
}

console.log(`\n${'─'.repeat(52)}`);
if (fail === 0) {
  console.log(`✅ 联机服务端检查全部通过：${pass} 项`);
  process.exit(0);
}
console.log(`❌ 有 ${fail} 项失败（通过 ${pass} 项）`);
process.exit(1);
