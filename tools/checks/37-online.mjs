/**
 * 0.60.0 公网联机（Cloudflare 部署）
 *
 * 这一轮把「局域网一台机器一个房间」变成了「公网同一份服务接很多房间」，
 * 客户端因此多了三件必须一直在的事情：
 *
 *  1. **每条请求都要带房间号** —— 服务端靠它路由到对应的房间对象。
 *     少带一处，那一条请求就会落到「没有房间号」的 400 上，而且只在
 *     公网环境才犯病（局域网服务端只有一个房间、根本不看这个参数）。
 *  2. **开房不能依赖安卓原生桥** —— 浏览器里没有 startHost，得靠 URL 导航。
 *  3. **退出房间不能跳 file://** —— 那是 APK 的首页，公网上跳过去就是白屏。
 *
 * 这些都是「改一行代码就悄悄退回局域网语义」的地方，静态断言比截图可靠。
 * 真正的时序性质（seq 单调、长轮询唤醒、两端状态一致）由
 * `tools/check-online.mjs` 与 `tools/check-online-match.mjs` 打真请求验证。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, check } from './harness.mjs';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const mpSrc = read('app/js/multiplayer.js');
const lanSrc = read('app/js/lan.js');
const screensSrc = read('app/js/screens.js');
const screensCss = read('app/screens.css');
const renderSrc = read('app/js/render.js');
const roomSrc = read('cloudflare/src/room.js');
const wrangler = read('cloudflare/wrangler.toml');

console.log('\n 0.60.0 公网联机（Cloudflare）');

/* ── 客户端：房间号贯通 ───────────────────────────────────────────── */

check('房间号工具：生成 / 规范化 / 取当前房间', () => {
  for (const fn of ['export function roomCode(', 'export function currentRoom(', 'export function newRoomCode(']) {
    if (!mpSrc.includes(fn)) throw new Error('multiplayer.js 缺少 ' + fn);
  }
  // 生成器不能用容易看错的 0/O/1/I —— 房间号是要口头念给对面的
  const body = mpSrc.slice(mpSrc.indexOf('export function newRoomCode('));
  const alphabet = (body.match(/const alphabet = '([^']+)'/) || [])[1] || '';
  if (!alphabet) throw new Error('newRoomCode 里找不到字母表');
  for (const bad of ['0', 'O', '1', 'I']) {
    if (alphabet.includes(bad)) throw new Error(`房间号字母表里不该有易混字符 ${bad}`);
  }
  if (alphabet.length < 30) throw new Error('房间号字母表太短：' + alphabet.length);
});

check('传输层：所有接口都带上 who 与 room', () => {
  if (!mpSrc.includes('this.room = roomCode(room)')) throw new Error('Transport 没有记下房间号');
  // 统一走 url() 拼地址；再出现手写的 `/api/xxx?who=` 就等于绕过了房间号
  const handWritten = mpSrc.match(/`\/api\/(send|poll|start|leave)\?who=/g) || [];
  if (handWritten.length) throw new Error('还有手写的接口地址：' + handWritten.join(', '));
  if (!mpSrc.includes("if (this.room) q.set('room', this.room);")) {
    throw new Error('拼地址时没有把 room 带上');
  }
});

check('WebSocket 也走同一个拼地址函数（否则重连会落到别的房间）', () => {
  if (!mpSrc.includes("this.transport.url('/ws', { since: this.transport.since })")) {
    throw new Error('WebSocket 地址没有经过 transport.url()');
  }
  const hard = mpSrc.match(/\/ws\?who=\$\{/);
  if (hard) throw new Error('还留着硬拼的 /ws?who= 地址');
});

check('会话把房间号交给传输层', () => {
  if (!mpSrc.includes('this.transport = new Transport(who, this.room)')) {
    throw new Error('Session 没把 room 传给 Transport');
  }
  if (!mpSrc.includes('this.room = roomCode(room) || currentRoom();')) {
    throw new Error('Session 没有从参数或 URL 取房间号');
  }
});

check('公网可用性判断：只看协议，不做主动探测', () => {
  if (!mpSrc.includes('export function onlineAvailable()')) throw new Error('缺少 onlineAvailable()');
  const body = mpSrc.slice(mpSrc.indexOf('export function onlineAvailable()'));
  if (!/p === 'http:' \|\| p === 'https:'/.test(body)) {
    throw new Error('onlineAvailable 没有按 http/https 判断');
  }
  if (!mpSrc.includes('export function siteBase()')) throw new Error('缺少 siteBase()');
});

/* ── 客户端：开房 / 进房 / 退房 ────────────────────────────────────── */

check('开房：浏览器里靠 URL 导航，不依赖原生桥', () => {
  const body = lanSrc.slice(lanSrc.indexOf('function createRoom()'), lanSrc.indexOf('/** 扫描同一 Wi-Fi 下的房间 */'));
  if (!body.includes('Net.onlineAvailable()')) throw new Error('createRoom 没有走公网分支');
  if (!body.includes('?net=host&room=')) throw new Error('createRoom 没有把房间号写进 URL');
  // 公网分支必须排在 startHost 之前：否则浏览器里永远先撞上「没有原生桥」
  if (body.indexOf('Net.onlineAvailable()') > body.indexOf('Net.startHost(')) {
    throw new Error('公网分支排在 startHost 之后，浏览器里会被原生分支先拦住');
  }
});

check('进房：房间号 / 内网地址两种输入都认', () => {
  if (!lanSrc.includes('Net.roomCode(raw)')) throw new Error('joinByManualAddress 没有尝试解析房间号');
  if (!lanSrc.includes('?net=guest&room=')) throw new Error('进房没有带 room 参数');
  if (!lanSrc.includes('normalizeHostInput')) throw new Error('内网地址那条路被删掉了');
});

check('退房：公网回站点根路径，不回 file://', () => {
  const body = lanSrc.slice(lanSrc.indexOf('async function quitRoom()'));
  if (!body.includes('Net.onlineAvailable()')) throw new Error('quitRoom 没有区分公网');
  if (!body.includes('Net.siteBase()}')) throw new Error('quitRoom 没有回到站点根路径');
  // 公网分支必须排在 HOME_ASSET_URL 之前，否则会先跳 file://
  if (body.indexOf('Net.onlineAvailable()') > body.indexOf('HOME_ASSET_URL')) {
    throw new Error('公网分支排在 file:// 之后，公网上会跳去白屏');
  }
});

/* ── 界面 ─────────────────────────────────────────────────────────── */

check('大厅把房间号与邀请链接都显示出来', () => {
  if (!screensSrc.includes('lobby-code')) throw new Error('大厅没有显示房间号');
  if (!screensSrc.includes('lobby-link')) throw new Error('大厅没有显示邀请链接');
});

check('凡是判断「能不能联机」的地方，都要算上公网', () => {
  // 只写 nativeAvailable() 的话，浏览器里会误报「当前环境不支持联机」
  const lines = renderSrc.split('\n').filter((l) => l.includes('lanSupported:'));
  if (!lines.length) throw new Error('render.js 里找不到 lanSupported 传参');
  for (const l of lines) {
    if (!l.includes('Net.nativeAvailable() || Net.onlineAvailable()') && !l.includes('onlineAvailable() ||')) {
      throw new Error('这处联机可用性没算公网：' + l.trim());
    }
  }
});

check('邀请链接会折行（不能顶出卡片右侧）', () => {
  if (!screensCss.includes('.lobby-link')) throw new Error('缺少 .lobby-link 样式');
  const body = screensCss.slice(screensCss.indexOf('.lobby-link {'));
  if (!body.includes('overflow-wrap: anywhere')) throw new Error('.lobby-link 没有 overflow-wrap');
  if (!body.includes('word-break: break-all')) throw new Error('.lobby-link 没有 word-break');
});

check('禁用的主按钮要看得出来是禁用的', () => {
  if (!screensCss.includes('.hm-btn:disabled')) throw new Error('缺少 .hm-btn:disabled 样式');
  const body = screensCss.slice(screensCss.indexOf('.hm-btn:disabled {'));
  if (!/opacity:\s*\.?\d/.test(body)) throw new Error('禁用态没有压暗');
});

/* ── 服务端：房间对象 ─────────────────────────────────────────────── */

check('Worker：按房间号路由到 Durable Object，非法房间号拒绝', () => {
  if (!roomSrc.includes('idFromName(room)')) throw new Error('没有按房间号取房间对象');
  if (!roomSrc.includes("'/^[A-Z0-9]{4,12}$/'")) {
    // 写成正则字面量也行，两种都接受
    if (!/\/\^\[A-Z0-9\]\{4,12\}\$\//.test(roomSrc)) throw new Error('没有校验房间号形状');
  }
  if (!roomSrc.includes("error: 'room-required'")) throw new Error('没有房间号时没有明确报错');
});

check('房间对象：seq 单调、自己不收自己的、离开会叫醒对端', () => {
  if (!roomSrc.includes('this.now++')) throw new Error('seq 没有单调递增');
  if (!roomSrc.includes('e.from !== who')) throw new Error('pendingFor 没有过滤掉自己发的');
  if (!roomSrc.includes('wakeLeft(')) throw new Error('没有在对端离开时叫醒长轮询');
  // 长轮询必须有个上限，不能把请求挂到天荒地老
  if (!roomSrc.includes('POLL_MAX_MS')) throw new Error('长轮询没有上限');
});

check('wrangler 配置：房间对象用 SQLite 迁移，静态资源先过 Worker', () => {
  if (!wrangler.includes('new_sqlite_classes')) throw new Error('缺少 DO 的 SQLite 迁移');
  if (!wrangler.includes('class_name = "Room"')) throw new Error('没有绑定 Room 类');
  if (!wrangler.includes('run_worker_first')) throw new Error('缺 run_worker_first，/api 会被 SPA 兜底吃掉');
  if (!wrangler.includes('binding = "ASSETS"')) throw new Error('没有静态资源绑定');
});
