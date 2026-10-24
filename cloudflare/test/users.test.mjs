/**
 * 云存档服务端测试：Node 22 + 内存 storage 桩，走真实 Request/Response。
 *
 * 为什么不连真的 wrangler dev：这里要验证的是**业务契约**（协议 §1），
 * 包括一些线上不好复现的路径 —— 篡改 token、伪造过期 token、存档版本冲突、
 * 5 次失败锁定、管理员重置密码后旧 token 立刻失效。用内存桩 + 直接调
 * Users.fetch 可以把这些状态精确摆出来，而且不需要装 wrangler、不需要联网。
 *
 * 桩只实现 Users 真正用到的 storage 接口：get / put / delete / list，
 * 外加 blockConcurrencyWhile（真实运行时用它保证初始化先于第一个请求）。
 *
 * 用法：node cloudflare/test/users.test.mjs（或 cd cloudflare && npm test）
 */

import { createHmac } from 'node:crypto';
import { Users } from '../src/users.js';
import worker, { Room, Users as UsersFromEntry } from '../src/room.js';

const BASE = 'https://cloud.test';
const ADMIN_USER = '123';
const ADMIN_PASS = '1145145';
/** 测试里把 PBKDF2 迭代次数压到 1000，否则几十次注册/登录会跑好几分钟 */
const FAST_ENV = { PBKDF2_ITERATIONS: '1000' };

let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra ? '  —— ' + extra : ''));
  }
}

function section(title) {
  console.log('\n── ' + title);
}

/** 响应里绝不能出现 hash / salt 这两个键（协议 §1.2） */
function noSecrets(body) {
  const text = JSON.stringify(body);
  return !/"hash"\s*:/.test(text) && !/"salt"\s*:/.test(text);
}

// ── 内存 storage 桩 ────────────────────────────────────────

function makeStorage() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : undefined;
    },
    async put(key, value) {
      map.set(key, structuredClone(value));
    },
    async delete(key) {
      return map.delete(key);
    },
    async list(options = {}) {
      const prefix = options.prefix || '';
      const out = new Map();
      for (const [k, v] of map) {
        if (k.startsWith(prefix)) out.set(k, structuredClone(v));
      }
      return out;
    },
    async deleteAll() {
      map.clear();
    },
  };
}

function makeCtx(storage) {
  return {
    storage,
    blockConcurrencyWhile(fn) {
      return Promise.resolve().then(fn);
    },
  };
}

function newUsers(storage = makeStorage(), env = FAST_ENV) {
  return new Users(makeCtx(storage), env);
}

// ── 请求小工具 ─────────────────────────────────────────────

function makeRequest(path, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  if (options.token) headers.Authorization = 'Bearer ' + options.token;
  const init = { method: options.method || 'GET', headers };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  } else if (options.raw !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = options.raw;
  }
  return new Request(BASE + path, init);
}

async function call(users, path, options = {}) {
  const res = await users.fetch(makeRequest(path, options));
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { status: res.status, body, headers: res.headers };
}

/** 用存储里的 meta:secret 伪造 token（验证过期 / 篡改这类路径必须能自己签） */
function forgeToken(secretBase64, claims) {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const sig = createHmac('sha256', Buffer.from(secretBase64, 'base64')).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function decodePayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
}

// ═══════════════════════════════════════════════════════════

console.log('云存档服务端测试（内存 storage 桩）');

// ── 0. 默认配置：管理员、迭代次数、密钥持久化 ──────────────
{
  section('0. 初始化：默认管理员 / PBKDF2 参数 / 自动密钥');
  const storage = makeStorage();
  const users = newUsers(storage, {});   // 不给 PBKDF2_ITERATIONS，走协议默认值
  const login = await call(users, '/api/auth/login', {
    method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  ok('默认管理员 123 / 1145145 能登录', login.status === 200 && login.body.ok === true, JSON.stringify(login.body));
  ok('管理员角色是 admin', login.body.user && login.body.user.role === 'admin', JSON.stringify(login.body.user));
  ok('登录响应不含 hash/salt', noSecrets(login.body));

  const record = storage.map.get('user:123');
  ok('管理员记录存在', !!record);
  ok('默认迭代次数是 100000', record.iterations === 100000, String(record.iterations));
  ok('盐是 16 字节', Buffer.from(record.salt, 'base64').length === 16);
  ok('哈希是 32 字节（SHA-256）', Buffer.from(record.hash, 'base64').length === 32);
  ok('存储里只有哈希，没有明文密码', !JSON.stringify(record).includes(ADMIN_PASS));
  ok('自动生成了 HMAC 密钥并持久化', typeof storage.map.get('meta:secret') === 'string' && storage.map.get('meta:secret').length >= 40);

  const me = await call(users, '/api/auth/me', { token: login.body.token });
  ok('默认管理员能查 me', me.status === 200 && me.body.user.username === '123' && me.body.user.role === 'admin');
  ok('me 返回 createdAt / lastLoginAt', typeof me.body.user.createdAt === 'string' && typeof me.body.user.lastLoginAt === 'string');
  ok('me 不含 hash/salt', noSecrets(me.body));
}

// ── 主测试实例（快速迭代次数） ─────────────────────────────
const storage = makeStorage();
const users = newUsers(storage);

// ── 1. 注册 ────────────────────────────────────────────────
section('1. 注册');
const ALICE_PASS = 'alice-pass-1';
const aliceReg = await call(users, '/api/auth/register', {
  method: 'POST', body: { username: 'Alice', password: ALICE_PASS },
});
ok('注册成功返回 200', aliceReg.status === 200 && aliceReg.body.ok === true, JSON.stringify(aliceReg.body));
ok('注册直接给 token', typeof aliceReg.body.token === 'string' && aliceReg.body.token.includes('.'));
ok('注册用户角色是 user', aliceReg.body.user.role === 'user');
ok('注册响应只含 username/role', JSON.stringify(Object.keys(aliceReg.body.user).sort()) === '["role","username"]');
ok('注册响应不含 hash/salt', noSecrets(aliceReg.body));

const aliceToken = aliceReg.body.token;

const dup = await call(users, '/api/auth/register', {
  method: 'POST', body: { username: 'ALICE', password: 'another-pass' },
});
ok('大小写不同的同名再注册返回 409', dup.status === 409 && dup.body.error === 'username-exists', JSON.stringify(dup.body));

const shortName = await call(users, '/api/auth/register', { method: 'POST', body: { username: 'a', password: ALICE_PASS } });
ok('太短的用户名返回 400', shortName.status === 400, JSON.stringify(shortName.body));

const badName = await call(users, '/api/auth/register', { method: 'POST', body: { username: 'bad-name', password: ALICE_PASS } });
ok('含非法字符的用户名返回 400', badName.status === 400 && badName.body.error === 'bad-username', JSON.stringify(badName.body));

const reserved = await call(users, '/api/auth/register', { method: 'POST', body: { username: ADMIN_USER, password: 'whatever-1' } });
ok('管理员保留名 123 不能注册', reserved.status === 400 && reserved.body.error === 'reserved-username', JSON.stringify(reserved.body));

const weak = await call(users, '/api/auth/register', { method: 'POST', body: { username: 'weakling', password: '123' } });
ok('太短的密码返回 400', weak.status === 400 && weak.body.error === 'bad-password', JSON.stringify(weak.body));

const arrayBody = await call(users, '/api/auth/register', { method: 'POST', raw: '[1,2,3]' });
ok('数组请求体返回 400', arrayBody.status === 400, JSON.stringify(arrayBody.body));

const brokenJson = await call(users, '/api/auth/register', { method: 'POST', raw: '{"username":' });
ok('坏 JSON 返回 400', brokenJson.status === 400 && brokenJson.body.error === 'bad-json', JSON.stringify(brokenJson.body));

const aliceRecord = storage.map.get('user:alice');
ok('用户名按小写存储（大小写不敏感）', !!aliceRecord && aliceRecord.username === 'Alice');
ok('账号记录里有盐和哈希', !!aliceRecord.salt && !!aliceRecord.hash);
ok('存储里没有明文密码', !JSON.stringify(aliceRecord).includes(ALICE_PASS));

// ── 2. 登录与 token ────────────────────────────────────────
section('2. 登录与 token');
const noAuth = await call(users, '/api/save');
ok('不带 token 访问受保护接口返回 401', noAuth.status === 401 && noAuth.body.error === 'unauthorized', JSON.stringify(noAuth.body));

const wrongPass = await call(users, '/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'nope-nope' } });
ok('密码错返回 401', wrongPass.status === 401 && wrongPass.body.error === 'bad-credentials', JSON.stringify(wrongPass.body));

const ghost = await call(users, '/api/auth/login', { method: 'POST', body: { username: 'ghost', password: 'nope-nope' } });
ok('用户不存在也返回 401', ghost.status === 401, JSON.stringify(ghost.body));
ok('两种情况错误文案完全一致（不泄露用户是否存在）',
  ghost.body.error === wrongPass.body.error && ghost.body.message === wrongPass.body.message,
  JSON.stringify([ghost.body, wrongPass.body]));

const login = await call(users, '/api/auth/login', { method: 'POST', body: { username: 'ALICE', password: ALICE_PASS } });
ok('用户名大小写不敏感，能登录', login.status === 200 && login.body.ok === true, JSON.stringify(login.body));
ok('登录响应不含 hash/salt', noSecrets(login.body));
const token = login.body.token;

const payload = decodePayload(token);
ok('token 载荷含 u/r/tv/exp', ['u', 'r', 'tv', 'exp'].every((k) => k in payload), JSON.stringify(payload));
ok('token 里 r=user、u 是小写用户名', payload.r === 'user' && payload.u === 'alice');
ok('token 有效期约 30 天', Math.abs(payload.exp - (Date.now() + 30 * 24 * 60 * 60 * 1000)) < 60 * 1000);

const me = await call(users, '/api/auth/me', { token });
ok('me 用 token 能拿到账号信息', me.status === 200 && me.body.user.username === 'Alice', JSON.stringify(me.body));
ok('me 不含 hash/salt', noSecrets(me.body));

const logout = await call(users, '/api/auth/logout', { method: 'POST', token });
ok('logout 返回 ok', logout.status === 200 && logout.body.ok === true, JSON.stringify(logout.body));

const flipped = token.slice(0, -1) + (token.slice(-1) === 'A' ? 'B' : 'A');
const tamperedSig = await call(users, '/api/auth/me', { token: flipped });
ok('篡改签名后 token 失效', tamperedSig.status === 401, JSON.stringify(tamperedSig.body));

const parts = token.split('.');
const forgedPayload = Buffer.from(JSON.stringify(Object.assign(decodePayload(token), { u: 'bob' })), 'utf8').toString('base64url');
const swappedPayload = await call(users, '/api/auth/me', { token: forgedPayload + '.' + parts[1] });
ok('篡改载荷（改成 bob）后 token 失效', swappedPayload.status === 401, JSON.stringify(swappedPayload.body));

const secret = storage.map.get('meta:secret');
const expired = forgeToken(secret, { u: 'alice', r: 'user', tv: payload.tv, exp: Date.now() - 1000 });
const expiredRes = await call(users, '/api/auth/me', { token: expired });
ok('过期 token 被拒绝', expiredRes.status === 401, JSON.stringify(expiredRes.body));

const noFuture = forgeToken(secret, { u: 'alice', r: 'user', tv: payload.tv, exp: Date.now() + 60000 });
const forgedOk = await call(users, '/api/auth/me', { token: noFuture });
ok('用同一密钥自签的合法 token 能通过（说明校验的是签名本身而不是 token 来源）', forgedOk.status === 200);

const noExp = forgeToken(secret, { u: 'alice', r: 'user', tv: payload.tv });
ok('没有 exp 的 token 被拒绝', (await call(users, '/api/auth/me', { token: noExp })).status === 401);

const otherSecret = forgeToken(Buffer.from('x'.repeat(32)).toString('base64'), { u: 'alice', r: 'user', tv: payload.tv, exp: Date.now() + 60000 });
ok('别的密钥签的 token 被拒绝', (await call(users, '/api/auth/me', { token: otherSecret })).status === 401);

const garbage = await call(users, '/api/auth/me', { token: 'not-a-token' });
ok('乱写的 token 被拒绝', garbage.status === 401);

// ── 3. 存档与版本冲突 ──────────────────────────────────────
section('3. 存档与版本冲突');
const BOB_PASS = 'bob-pass-1';
const bobReg = await call(users, '/api/auth/register', { method: 'POST', body: { username: 'bob', password: BOB_PASS } });
ok('注册 bob 成功', bobReg.status === 200);
const bobToken = bobReg.body.token;

const emptySave = await call(users, '/api/save', { token: bobToken });
ok('新用户没有存档（save 为 null）', emptySave.status === 200 && emptySave.body.save === null, JSON.stringify(emptySave.body));

const PROFILE = { games: 3, wins: 1, perf: 1200, gold: 88, ladder: [1, 2, 3] };
const push1 = await call(users, '/api/save', { method: 'PUT', token: bobToken, body: { data: PROFILE, baseVersion: 0 } });
ok('首次上传（baseVersion=0）成功', push1.status === 200 && push1.body.save.version === 1, JSON.stringify(push1.body));
ok('上传响应只含 version/updatedAt', JSON.stringify(Object.keys(push1.body.save).sort()) === '["updatedAt","version"]');

const got1 = await call(users, '/api/save', { token: bobToken });
ok('拉回存档内容一致', JSON.stringify(got1.body.save.data) === JSON.stringify(PROFILE), JSON.stringify(got1.body));
ok('拉回存档不含 bytes/summary', JSON.stringify(Object.keys(got1.body.save).sort()) === '["data","updatedAt","version"]');

const stale = await call(users, '/api/save', { method: 'PUT', token: bobToken, body: { data: { games: 99 }, baseVersion: 0 } });
ok('baseVersion 过旧返回 409 conflict', stale.status === 409 && stale.body.error === 'conflict', JSON.stringify(stale.body));
ok('冲突响应带回云端存档，客户端才能让玩家二选一',
  stale.body.save && stale.body.save.version === 1 && stale.body.save.data.games === 3, JSON.stringify(stale.body.save));

const push2 = await call(users, '/api/save', { method: 'PUT', token: bobToken, body: { data: { games: 4, wins: 2, perf: 2000, gold: 150 }, baseVersion: 1 } });
ok('版本对得上时能覆盖，版本号 +1', push2.status === 200 && push2.body.save.version === 2, JSON.stringify(push2.body));

const huge = await call(users, '/api/save', { method: 'PUT', token: bobToken, body: { data: { blob: 'x'.repeat(70000) }, baseVersion: 2 } });
ok('超过 64 KB 返回 413', huge.status === 413 && huge.body.error === 'save-too-large', JSON.stringify(huge.body).slice(0, 200));

const badVersion = await call(users, '/api/save', { method: 'PUT', token: bobToken, body: { data: { games: 1 }, baseVersion: -1 } });
ok('baseVersion 非法返回 400', badVersion.status === 400 && badVersion.body.error === 'bad-version', JSON.stringify(badVersion.body));

const noData = await call(users, '/api/save', { method: 'PUT', token: bobToken, body: { baseVersion: 2 } });
ok('缺 data 返回 400', noData.status === 400 && noData.body.error === 'bad-data', JSON.stringify(noData.body));

const aliceEmpty = await call(users, '/api/save', { token: aliceToken });
ok('存档按用户隔离（alice 看不到 bob 的）', aliceEmpty.body.save === null, JSON.stringify(aliceEmpty.body));

// ── 4. 管理员 ──────────────────────────────────────────────
section('4. 管理员');
const adminLogin = await call(users, '/api/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
ok('默认管理员在快速实例上也能登录', adminLogin.status === 200 && adminLogin.body.user.role === 'admin', JSON.stringify(adminLogin.body));
const adminToken = adminLogin.body.token;

const forbidden = await call(users, '/api/admin/users', { token: aliceToken });
ok('普通用户访问管理员接口返回 403', forbidden.status === 403 && forbidden.body.error === 'forbidden', JSON.stringify(forbidden.body));

const list = await call(users, '/api/admin/users', { token: adminToken });
ok('管理员能拿到用户列表', list.status === 200 && Array.isArray(list.body.users), JSON.stringify(list.body).slice(0, 200));
ok('用户列表不含 hash/salt', noSecrets(list.body));
const names = list.body.users.map((u) => u.username);
ok('列表里有管理员与 alice、bob', names.includes('123') && names.includes('Alice') && names.includes('bob'), JSON.stringify(names));

const bobRow = list.body.users.find((u) => u.username === 'bob');
ok('列表带存档元信息', bobRow.save && bobRow.save.version === 2 && bobRow.save.bytes > 0, JSON.stringify(bobRow.save));
ok('summary 只含 games/wins/perf/gold',
  JSON.stringify(Object.keys(bobRow.save.summary).sort()) === '["games","gold","perf","wins"]', JSON.stringify(bobRow.save.summary));
ok('summary 数字正确', bobRow.save.summary.games === 4 && bobRow.save.summary.wins === 2 && bobRow.save.summary.perf === 2000 && bobRow.save.summary.gold === 150);
ok('用户行只含协议允许的字段',
  JSON.stringify(Object.keys(bobRow).sort()) === '["createdAt","lastLoginAt","role","save","updatedAt","username"]', JSON.stringify(Object.keys(bobRow)));

const selfDelete = await call(users, '/api/admin/delete', { method: 'POST', token: adminToken, body: { username: ADMIN_USER } });
ok('管理员不能删除自己', selfDelete.status === 400 && selfDelete.body.error === 'cannot-delete-self', JSON.stringify(selfDelete.body));

const aliceBeforeReset = await call(users, '/api/auth/me', { token: aliceToken });
ok('重置密码前 alice 的 token 有效', aliceBeforeReset.status === 200);

const reset = await call(users, '/api/admin/reset-password', {
  method: 'POST', token: adminToken, body: { username: 'alice', newPassword: 'alice-pass-2' },
});
ok('管理员重置密码成功', reset.status === 200 && reset.body.ok === true, JSON.stringify(reset.body));

const aliceAfterReset = await call(users, '/api/auth/me', { token: aliceToken });
ok('重置密码后旧 token 立刻失效', aliceAfterReset.status === 401, JSON.stringify(aliceAfterReset.body));

const aliceOldLogin = await call(users, '/api/auth/login', { method: 'POST', body: { username: 'alice', password: ALICE_PASS } });
ok('重置密码后旧密码不能登录', aliceOldLogin.status === 401, JSON.stringify(aliceOldLogin.body));

const aliceNewLogin = await call(users, '/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'alice-pass-2' } });
ok('重置后新密码能登录', aliceNewLogin.status === 200, JSON.stringify(aliceNewLogin.body));

const resetGhost = await call(users, '/api/admin/reset-password', {
  method: 'POST', token: adminToken, body: { username: 'nobody', newPassword: 'whatever-1' },
});
ok('重置不存在的用户返回 404', resetGhost.status === 404 && resetGhost.body.error === 'not-found', JSON.stringify(resetGhost.body));

// ── 4b. 管理员改玩家数据（0.69.0，协议 §1.6） ─────────────
section('4b. 管理员改玩家数据');
const DORA_PASS = 'dora-pass-1';
const doraReg = await call(users, '/api/auth/register', { method: 'POST', body: { username: 'dora', password: DORA_PASS } });
ok('注册 dora 成功', doraReg.status === 200);
const doraToken = doraReg.body.token;

const DORA_PROFILE = {
  v: 2, gold: 50, dust: 10, perf: 300, games: 2, wins: 1, losses: 1, draws: 0,
  forge: { v: 1, cards: { U01: { lvl: 9, masteries: ['w_atk'] } } },
};
const doraPush = await call(users, '/api/save', { method: 'PUT', token: doraToken, body: { data: DORA_PROFILE, baseVersion: 0 } });
ok('dora 上传了一份存档', doraPush.status === 200 && doraPush.body.save.version === 1, JSON.stringify(doraPush.body));

const anonRead = await call(users, '/api/admin/save?username=dora');
ok('没登录不能读别人的存档', anonRead.status === 401, JSON.stringify(anonRead.body));

const userRead = await call(users, '/api/admin/save?username=dora', { token: doraToken });
ok('普通玩家不能读「指定用户」的存档', userRead.status === 403 && userRead.body.error === 'forbidden', JSON.stringify(userRead.body));

const adminRead = await call(users, '/api/admin/save?username=dora', { token: adminToken });
ok('管理员能读到 dora 的完整存档', adminRead.status === 200 && adminRead.body.save.data.gold === 50, JSON.stringify(adminRead.body).slice(0, 200));
ok('读存档响应不含 hash/salt', noSecrets(adminRead.body));
ok('读存档带版本与 summary', adminRead.body.save.version === 1 && adminRead.body.save.summary.perf === 300, JSON.stringify(adminRead.body.save.summary));

const ghostRead = await call(users, '/api/admin/save?username=nobody', { token: adminToken });
ok('读不存在的用户返回 404', ghostRead.status === 404 && ghostRead.body.error === 'not-found', JSON.stringify(ghostRead.body));

const patchRes = await call(users, '/api/admin/save', {
  method: 'POST', token: adminToken,
  body: { username: 'dora', patch: { gold: 700, perf: 1200 } },
});
ok('管理员改金币与表现分成功', patchRes.status === 200 && patchRes.body.ok === true, JSON.stringify(patchRes.body).slice(0, 200));
ok('改完版本号 +1', patchRes.body.save.version === 2, JSON.stringify(patchRes.body.save && patchRes.body.save.version));
ok('改完 summary 跟着变', patchRes.body.save.summary.gold === 700 && patchRes.body.save.summary.perf === 1200, JSON.stringify(patchRes.body.save.summary));

const doraAfter = await call(users, '/api/save', { token: doraToken });
ok('玩家自己拉到的就是管理员改后的数', doraAfter.body.save.data.gold === 700 && doraAfter.body.save.data.perf === 1200, JSON.stringify(doraAfter.body.save.data));
ok('没点名改的字段原样保留', doraAfter.body.save.data.forge.cards.U01.lvl === 9 && doraAfter.body.save.data.wins === 1, JSON.stringify(doraAfter.body.save.data).slice(0, 200));

const clampRes = await call(users, '/api/admin/save', {
  method: 'POST', token: adminToken,
  body: { username: 'dora', patch: { gold: 999999, dust: 99999 } },
});
ok('越界的数被夹住（金币 1000 / 星尘 500）',
  clampRes.status === 200 && clampRes.body.save.data.gold === 1000 && clampRes.body.save.data.dust === 500,
  JSON.stringify(clampRes.body.save && clampRes.body.save.summary));

const emptyPatch = await call(users, '/api/admin/save', { method: 'POST', token: adminToken, body: { username: 'dora', patch: {} } });
ok('patch 里没有可改字段返回 400', emptyPatch.status === 400 && emptyPatch.body.error === 'bad-patch', JSON.stringify(emptyPatch.body));

const bothModes = await call(users, '/api/admin/save', {
  method: 'POST', token: adminToken,
  body: { username: 'dora', patch: { gold: 1 }, data: { gold: 2 } },
});
ok('patch 与 data 同时给返回 400', bothModes.status === 400, JSON.stringify(bothModes.body));

const replaceRes = await call(users, '/api/admin/save', {
  method: 'POST', token: adminToken,
  body: {
    username: 'dora',
    data: { gold: 12, perf: 60, forge: { v: 1, cards: { U02: { lvl: 15, masteries: ['a', 'b', 'c', 'd'] }, U03: { lvl: 0, masteries: [] } } } },
  },
});
const cleaned = replaceRes.body.save && replaceRes.body.save.data;
ok('整份替换成功', replaceRes.status === 200 && cleaned.gold === 12, JSON.stringify(replaceRes.body).slice(0, 200));
ok('强化表被洗干净（lvl 15→9、精通最多 2 个）',
  cleaned.forge.cards.U02.lvl === 9 && cleaned.forge.cards.U02.masteries.length === 2,
  JSON.stringify(cleaned.forge));
ok('空记录不进存档', !cleaned.forge.cards.U03, JSON.stringify(cleaned.forge));

const badData = await call(users, '/api/admin/save', { method: 'POST', token: adminToken, body: { username: 'dora', data: [1, 2, 3] } });
ok('data 不是对象返回 400', badData.status === 400 && badData.body.error === 'bad-data', JSON.stringify(badData.body));

const hugeAdmin = await call(users, '/api/admin/save', {
  method: 'POST', token: adminToken,
  body: { username: 'dora', data: { blob: 'x'.repeat(70000) } },
});
ok('管理员也受 64 KB 限制', hugeAdmin.status === 413 && hugeAdmin.body.error === 'save-too-large', JSON.stringify(hugeAdmin.body).slice(0, 160));

const stalePush = await call(users, '/api/save', {
  method: 'PUT', token: doraToken, body: { data: { gold: 0 }, baseVersion: 1 },
});
ok('玩家拿着旧版本上传会撞 409（管理员改动不会被静默覆盖）',
  stalePush.status === 409 && stalePush.body.error === 'conflict', JSON.stringify(stalePush.body).slice(0, 200));

const eveReg = await call(users, '/api/auth/register', { method: 'POST', body: { username: 'eve', password: 'eve-pass-1' } });
ok('注册 eve（还没有存档）成功', eveReg.status === 200);
const evePatch = await call(users, '/api/admin/save', {
  method: 'POST', token: adminToken, body: { username: 'eve', patch: { gold: 321, games: 7 } },
});
ok('没存档的用户也能直接给数据（以空档案为底）',
  evePatch.status === 200 && evePatch.body.save.version === 1
  && evePatch.body.save.data.gold === 321 && evePatch.body.save.data.forge.cards,
  JSON.stringify(evePatch.body).slice(0, 200));

const logRes = await call(users, '/api/admin/log', { token: adminToken });
ok('管理员能读操作日志', logRes.status === 200 && Array.isArray(logRes.body.log) && logRes.body.log.length >= 3, JSON.stringify(logRes.body).slice(0, 160));
ok('日志记了操作人、对象与字段',
  logRes.body.log.some((e) => e.by && e.username === 'dora' && Array.isArray(e.fields) && e.fields.includes('gold')),
  JSON.stringify(logRes.body.log[0]));
ok('日志不含 hash/salt', noSecrets(logRes.body));

const logForbidden = await call(users, '/api/admin/log', { token: doraToken });
ok('普通玩家读不了操作日志', logForbidden.status === 403, JSON.stringify(logForbidden.body));

// ── 5. 用户自己改密码 ──────────────────────────────────────
section('5. 改密码');
const carol = await call(users, '/api/auth/register', { method: 'POST', body: { username: 'carol', password: 'carol-pass-1' } });
ok('注册 carol 成功', carol.status === 200);
const carolToken = carol.body.token;

const wrongCurrent = await call(users, '/api/auth/password', {
  method: 'POST', token: carolToken, body: { currentPassword: 'wrong-old-1', newPassword: 'carol-pass-2' },
});
ok('当前密码错返回 401', wrongCurrent.status === 401 && wrongCurrent.body.error === 'bad-credentials', JSON.stringify(wrongCurrent.body));

const changed = await call(users, '/api/auth/password', {
  method: 'POST', token: carolToken, body: { currentPassword: 'carol-pass-1', newPassword: 'carol-pass-2' },
});
ok('改密码成功并返回新 token', changed.status === 200 && typeof changed.body.token === 'string', JSON.stringify(changed.body));

const carolOldToken = await call(users, '/api/auth/me', { token: carolToken });
ok('改密码后旧 token 失效', carolOldToken.status === 401);

const carolNewToken = await call(users, '/api/auth/me', { token: changed.body.token });
ok('新 token 可用', carolNewToken.status === 200 && carolNewToken.body.user.username === 'carol');

const carolOldPass = await call(users, '/api/auth/login', { method: 'POST', body: { username: 'carol', password: 'carol-pass-1' } });
ok('改密码后旧密码不能登录', carolOldPass.status === 401);

const carolNewPass = await call(users, '/api/auth/login', { method: 'POST', body: { username: 'carol', password: 'carol-pass-2' } });
ok('新密码能登录', carolNewPass.status === 200);

// ── 6. 删号 ────────────────────────────────────────────────
section('6. 删号');
const deleted = await call(users, '/api/admin/delete', { method: 'POST', token: adminToken, body: { username: 'bob' } });
ok('管理员删除 bob 成功', deleted.status === 200 && deleted.body.ok === true, JSON.stringify(deleted.body));

const bobAfterDelete = await call(users, '/api/auth/me', { token: bobToken });
ok('删号后 bob 的 token 失效', bobAfterDelete.status === 401, JSON.stringify(bobAfterDelete.body));

const bobLoginAfter = await call(users, '/api/auth/login', { method: 'POST', body: { username: 'bob', password: BOB_PASS } });
ok('删号后 bob 不能登录', bobLoginAfter.status === 401);

const bobDeleteAgain = await call(users, '/api/admin/delete', { method: 'POST', token: adminToken, body: { username: 'bob' } });
ok('删除不存在的用户返回 404', bobDeleteAgain.status === 404, JSON.stringify(bobDeleteAgain.body));

const bobReborn = await call(users, '/api/auth/register', { method: 'POST', body: { username: 'bob', password: BOB_PASS } });
ok('同名可以重新注册', bobReborn.status === 200);
const rebornSave = await call(users, '/api/save', { token: bobReborn.body.token });
ok('删号时存档一起删掉（重新注册后没有旧存档）', rebornSave.body.save === null, JSON.stringify(rebornSave.body));

// ── 7. 登录失败锁定 ────────────────────────────────────────
section('7. 登录失败锁定');
const dave = await call(users, '/api/auth/register', { method: 'POST', body: { username: 'dave', password: 'dave-pass-1' } });
ok('注册 dave 成功', dave.status === 200);
let attempts = [];
for (let i = 0; i < 5; i++) {
  attempts.push(await call(users, '/api/auth/login', { method: 'POST', body: { username: 'dave', password: 'wrong-' + i + '-x' } }));
}
ok('前 5 次失败都是 401', attempts.every((r) => r.status === 401), JSON.stringify(attempts.map((r) => r.status)));

const locked = await call(users, '/api/auth/login', { method: 'POST', body: { username: 'dave', password: 'dave-pass-1' } });
ok('第 6 次（即使密码正确）返回 429', locked.status === 429 && locked.body.error === 'too-many-attempts', JSON.stringify(locked.body));

const daveRecord = storage.map.get('user:dave');
ok('锁定状态存在用户记录里，10 分钟后解锁',
  daveRecord.failUntil > Date.now() && daveRecord.failUntil <= Date.now() + 10 * 60 * 1000);
ok('锁定记录里没有明文密码', !JSON.stringify(daveRecord).includes('dave-pass-1'));

// 直接改存储模拟「10 分钟过去了」
const daveRec = storage.map.get('user:dave');
daveRec.failUntil = 0;
daveRec.failCount = 0;
const afterUnlock = await call(users, '/api/auth/login', { method: 'POST', body: { username: 'dave', password: 'dave-pass-1' } });
ok('解锁后能正常登录', afterUnlock.status === 200, JSON.stringify(afterUnlock.body));
ok('成功登录把失败计数清零', storage.map.get('user:dave').failCount === 0 && storage.map.get('user:dave').failUntil === 0);

// ── 8. CORS ────────────────────────────────────────────────
section('8. CORS');
const preflight = await users.fetch(makeRequest('/api/auth/login', { method: 'OPTIONS' }));
ok('OPTIONS 预检返回 204', preflight.status === 204, String(preflight.status));
ok('预检带 Allow-Origin: *', preflight.headers.get('Access-Control-Allow-Origin') === '*');
ok('预检允许 Authorization 头',
  (preflight.headers.get('Access-Control-Allow-Headers') || '').toLowerCase().includes('authorization'),
  preflight.headers.get('Access-Control-Allow-Headers'));
ok('预检允许 PUT', (preflight.headers.get('Access-Control-Allow-Methods') || '').includes('PUT'),
  preflight.headers.get('Access-Control-Allow-Methods'));

const corsSave = await call(users, '/api/auth/login', { method: 'POST', body: { username: 'dave', password: 'dave-pass-1' } });
ok('普通响应也带 CORS 头', corsSave.headers.get('Access-Control-Allow-Origin') === '*');

const optionsSave = await call(users, '/api/save', { method: 'OPTIONS' });
ok('OPTIONS /api/save 也是 204（不需要 token）', optionsSave.status === 204, String(optionsSave.status));

// ── 9. 持久化 / 重启 ───────────────────────────────────────
section('9. 持久化：换一个实例仍然有效');
{
  const shared = makeStorage();
  const first = newUsers(shared);
  const reg = await call(first, '/api/auth/register', { method: 'POST', body: { username: 'persist', password: 'persist-1' } });
  ok('实例 A 注册成功', reg.status === 200);
  const saved = await call(first, '/api/save', { method: 'PUT', token: reg.body.token, body: { data: { games: 7 }, baseVersion: 0 } });
  ok('实例 A 写存档成功', saved.status === 200);

  const second = newUsers(shared);   // 模拟 Durable Object 休眠后重新唤醒
  const meAgain = await call(second, '/api/auth/me', { token: reg.body.token });
  ok('实例 B 仍然认这个 token（密钥持久化）', meAgain.status === 200 && meAgain.body.user.username === 'persist', JSON.stringify(meAgain.body));
  const saveAgain = await call(second, '/api/save', { token: reg.body.token });
  ok('实例 B 能读到实例 A 写的存档', saveAgain.body.save && saveAgain.body.save.data.games === 7, JSON.stringify(saveAgain.body));
  ok('实例 B 里管理员仍能登录', (await call(second, '/api/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } })).status === 200);
}

// ── 10. 环境变量覆盖 ──────────────────────────────────────
section('10. 环境变量：管理员账号与迭代次数可覆盖');
{
  const envStorage = makeStorage();
  const envUsers = newUsers(envStorage, {
    PBKDF2_ITERATIONS: '500',
    ADMIN_USERNAME: 'boss',
    ADMIN_PASSWORD: 's3cret-pass',
    AUTH_SECRET: 'fixed-secret-for-test',
  });
  const boss = await call(envUsers, '/api/auth/login', { method: 'POST', body: { username: 'boss', password: 's3cret-pass' } });
  ok('ADMIN_USERNAME/ADMIN_PASSWORD 覆盖默认管理员', boss.status === 200 && boss.body.user.role === 'admin', JSON.stringify(boss.body));
  const oldDefault = await call(envUsers, '/api/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  ok('覆盖后默认 123/1145145 登录不了', oldDefault.status === 401, JSON.stringify(oldDefault.body));
  ok('覆盖后按 500 次迭代存储', envStorage.map.get('user:boss').iterations === 500);
  const bossReg = await call(envUsers, '/api/auth/register', { method: 'POST', body: { username: 'boss', password: 'whatever-1' } });
  ok('配置的管理员名不能被注册', bossReg.status === 400 && bossReg.body.error === 'reserved-username', JSON.stringify(bossReg.body));
  const stillReserved = await call(envUsers, '/api/auth/register', { method: 'POST', body: { username: '123', password: 'whatever-1' } });
  ok('即使管理员改名，123 仍是保留名', stillReserved.status === 400 && stillReserved.body.error === 'reserved-username', JSON.stringify(stillReserved.body));
  ok('环境变量里配了 AUTH_SECRET 就不写 meta:secret', !envStorage.map.has('meta:secret'));

  // 证明用的是 env 里的密钥，而不是自动生成的那把
  const bossRecord = envStorage.map.get('user:boss');
  const envToken = forgeToken(Buffer.from('fixed-secret-for-test', 'utf8').toString('base64'), {
    u: 'boss', r: 'admin', tv: bossRecord.tokenVersion, exp: Date.now() + 60000,
  });
  const envMe = await call(envUsers, '/api/auth/me', { token: envToken });
  ok('AUTH_SECRET 配了就按它签 token', envMe.status === 200 && envMe.body.user.username === 'boss', JSON.stringify(envMe.body));
}

// ── 11. Worker 入口路由（room.js 默认导出） ───────────────
section('11. Worker 入口：云存档路由先于房间路由');
{
  const routerStorage = makeStorage();
  const routerUsers = newUsers(routerStorage);
  const bound = [];
  const fakeEnv = {
    USERS: {
      idFromName(name) { bound.push(name); return name; },
      get(id) { return { fetch: (request) => routerUsers.fetch(request) }; },
    },
    ASSETS: { fetch: async () => new Response('asset-not-found', { status: 404 }) },
  };

  ok('入口模块导出了 Users（Wrangler 要求）', typeof UsersFromEntry === 'function');
  ok('入口模块仍导出 Room', typeof Room === 'function');

  const reg = await worker.fetch(makeRequest('/api/auth/register', {
    method: 'POST', body: { username: 'router', password: 'router-pass' },
  }), fakeEnv);
  const regBody = await reg.json();
  ok('POST /api/auth/register 被转发到 Users 而不是房间路由', reg.status === 200 && regBody.ok === true, JSON.stringify(regBody));
  ok('USERS 用的是全局单实例', bound.length === 1 && bound[0] === 'global', JSON.stringify(bound));

  const meRes = await worker.fetch(makeRequest('/api/auth/me', { token: regBody.token }), fakeEnv);
  ok('GET /api/auth/me 走 Users', meRes.status === 200 && (await meRes.json()).user.username === 'router');

  const saveRes = await worker.fetch(new Request(BASE + '/api/save', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + regBody.token },
    body: JSON.stringify({ data: { games: 1 }, baseVersion: 0 }),
  }), fakeEnv);
  ok('PUT /api/save 走 Users', saveRes.status === 200, String(saveRes.status));

  const pre = await worker.fetch(makeRequest('/api/auth/login', { method: 'OPTIONS' }), fakeEnv);
  ok('OPTIONS /api/auth/* 在 Worker 层就能拿到 204', pre.status === 204, String(pre.status));

  const health = await worker.fetch(makeRequest('/api/health'), fakeEnv);
  const healthBody = await health.json();
  ok('房间接口 /api/health 没被云存档路由抢走', health.status === 200 && healthBody.ok === true, JSON.stringify(healthBody));

  const noRoom = await worker.fetch(makeRequest('/api/room'), fakeEnv);
  const noRoomBody = await noRoom.json();
  ok('房间路由仍然要求 room 参数', noRoom.status === 400 && noRoomBody.error === 'room-required', JSON.stringify(noRoomBody));

  const noBinding = await worker.fetch(makeRequest('/api/auth/me'), { ASSETS: fakeEnv.ASSETS });
  ok('没有 USERS 绑定时返回明确错误而不是崩溃', noBinding.status === 500, String(noBinding.status));
}

// ── 12. 杂项 ───────────────────────────────────────────────
section('12. 杂项');
const unknown = await call(users, '/api/auth/nope');
ok('未知云存档路径返回 404', unknown.status === 404 && unknown.body.error === 'not-found', JSON.stringify(unknown.body));

const wrongMethod = await call(users, '/api/auth/register');
ok('GET 注册接口返回 405', wrongMethod.status === 405, JSON.stringify(wrongMethod.body));

const trailing = await call(users, '/api/auth/me/', { token: adminToken });
ok('路径尾部斜杠被容忍', trailing.status === 200, String(trailing.status));

// ═══════════════════════════════════════════════════════════
console.log('\n' + '─'.repeat(52));
if (fail === 0) {
  console.log('✅ 云存档服务端测试全部通过：' + pass + ' 项');
  process.exit(0);
}
console.log('❌ 有 ' + fail + ' 项失败（通过 ' + pass + ' 项）');
process.exit(1);

