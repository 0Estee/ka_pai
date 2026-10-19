/**
 * 云存档服务（Durable Object）：账号、令牌、存档、管理员。
 *
 * 对应 `docs/云存档协议.md` §1。为什么是 Durable Object 而不是普通 Worker：
 *  1. 用户名唯一性要「查重 + 写入」串行执行 —— 普通 Worker 的多个 isolate 各查各的，
 *     两个人抢同一个名字时会**都**以为注册成功了；
 *  2. token 的 HMAC 密钥要持久化（没配 AUTH_SECRET 时自动生成一次并存起来），
 *     普通 Worker 每次请求都是新实例，没有地方放密钥；
 *  3. 登录失败计数、存档版本号都是跨请求的状态。
 *
 * 全局单实例（Worker 里用 env.USERS.idFromName('global')）：用户量在这个量级完全够用，
 * 换来的是「用户名查重」「管理员列表」天然串行，不会读到写了一半的数据。
 *
 * 存储布局（协议 §1.4）：
 *   user:<小写用户名>  → 账号记录（盐/哈希只存在这里，**任何响应都不带出去**）
 *   save:<小写用户名>  → 存档 {data,version,updatedAt,bytes,summary}
 *   meta:secret       → 自动生成的 HMAC 密钥（base64）
 *
 * 只使用 Web Crypto / atob / btoa 这些 Workers 和 Node 22 都有的全局能力：
 * 零第三方依赖，也不引 Node 内置模块（Workers 里没有）。
 */

/** 一天 */
const DAY_MS = 24 * 60 * 60 * 1000;
/** token 有效期：30 天（协议 §1.3） */
const TOKEN_TTL_MS = 30 * DAY_MS;
/** 单条存档上限 64 KB（协议 §1.1） */
const SAVE_MAX_BYTES = 64 * 1024;
/** 同一用户名连续失败多少次后锁定 */
const FAIL_LIMIT = 5;
/** 锁定时长：10 分钟 */
const LOCK_MS = 10 * 60 * 1000;
/** 默认 PBKDF2-SHA256 迭代次数（可用 env.PBKDF2_ITERATIONS 降低，测试里会调小） */
const DEFAULT_ITERATIONS = 100000;
/** 密码长度约束（协议没写，这里给一个不苛刻的下限） */
const MIN_PASSWORD = 6;
const MAX_PASSWORD = 128;
/** 默认管理员（协议 §1.2） */
const DEFAULT_ADMIN_USERNAME = '123';
const DEFAULT_ADMIN_PASSWORD = '1145145';
/** 管理员保留名：即使 ADMIN_USERNAME 被改成别的，123 也不允许注册（协议 §1.4） */
const RESERVED_ADMIN_USERNAME = '123';
/** 用户名规则：2~20 个字符，只允许中文 / 字母 / 数字 / 下划线（大小写不敏感） */
const USERNAME_RE = /^[\u4e00-\u9fff\u3400-\u4dbfA-Za-z0-9_]{2,20}$/u;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** APK 从 file:// 发请求时会走 CORS，OPTIONS 预检也是靠这套头（协议 §1.5） */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '86400',
};

/** 统一的 JSON 响应 */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

/** 统一错误形态：{ ok:false, error, message } */
function fail(error, message, status) {
  return json({ ok: false, error, message }, status);
}

// ── 编码小工具 ─────────────────────────────────────────────
// Workers 没有 Buffer，用 btoa/atob 手工转 Uint8Array。

function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToBytes(str) {
  const bin = atob(String(str || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** base64url（无 padding），token 用 */
function toBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const padded = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const rest = padded.length % 4;
  return base64ToBytes(rest ? padded + '='.repeat(4 - rest) : padded);
}

function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** 常量时间比较：长度不同直接 false（哈希长度固定，不会泄露有用信息） */
function constantTimeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ── 密码：PBKDF2-SHA256（协议 §1.3） ──────────────────────

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(String(password)), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256,
  );
  return new Uint8Array(bits);
}

/** 用记录里的盐与迭代次数重算，再常量时间比较 */
async function verifyPassword(record, password) {
  if (!record || !record.salt || !record.hash) return false;
  const salt = base64ToBytes(record.salt);
  const expect = base64ToBytes(record.hash);
  const iterations = Math.max(1, Number(record.iterations) || DEFAULT_ITERATIONS);
  const got = await derive(password, salt, iterations);
  return constantTimeEqual(got, expect);
}

// ── token：无状态 HMAC-SHA256（协议 §1.3） ─────────────────

async function hmacKey(secretBytes) {
  return crypto.subtle.importKey(
    'raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
}

/** payload 是 base64url(JSON)，签名是 base64url(HMAC-SHA256(secret, payload)) */
async function signToken(secretBytes, claims) {
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secretBytes), encoder.encode(payload)));
  return payload + '.' + toBase64Url(sig);
}

/** 校验签名 + 过期时间；任何一步不对都返回 null */
async function verifyToken(secretBytes, token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  let given;
  try { given = fromBase64Url(sigPart); } catch { return null; }
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(secretBytes), encoder.encode(payload)),
  );
  if (!constantTimeEqual(given, expected)) return null;
  let claims;
  try { claims = JSON.parse(decoder.decode(fromBase64Url(payload))); } catch { return null; }
  if (!claims || typeof claims !== 'object') return null;
  if (typeof claims.u !== 'string' || !claims.u) return null;
  if (!Number.isFinite(claims.exp) || claims.exp < Date.now()) return null;
  return claims;
}

// ── 存储与业务小工具 ──────────────────────────────────────

const userKey = (lower) => 'user:' + lower;
const saveKey = (lower) => 'save:' + lower;

/** 管理员列表只暴露这四个数字（协议 §1.2） */
function summarize(data) {
  const d = data && typeof data === 'object' ? data : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { games: num(d.games), wins: num(d.wins), perf: num(d.perf), gold: num(d.gold) };
}

/** 读 JSON 体；读不出来 / 不是对象都当坏请求 */
async function readJson(request) {
  let body;
  try { body = await request.json(); } catch { return null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  return body;
}

export class Users {
  /**
   * @param {DurableObjectState} ctx
   * @param {{AUTH_SECRET?:string, ADMIN_USERNAME?:string, ADMIN_PASSWORD?:string, PBKDF2_ITERATIONS?:string|number}} env
   */
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env || {};
    this.storage = ctx.storage;
    /** 初始化（生成/读取密钥、确保管理员存在）必须在第一个请求之前完成 */
    const init = () => this.init();
    this.ready = ctx.blockConcurrencyWhile ? ctx.blockConcurrencyWhile(init) : init();
  }

  async init() {
    this.secret = await this.loadSecret();
    await this.ensureAdmin();
  }

  /** 密钥优先取 env.AUTH_SECRET；没有就生成一次并持久化（协议 §1.3） */
  async loadSecret() {
    const fromEnv = this.env.AUTH_SECRET;
    if (fromEnv) return encoder.encode(String(fromEnv));
    let stored = await this.storage.get('meta:secret');
    if (!stored) {
      stored = bytesToBase64(randomBytes(32));
      await this.storage.put('meta:secret', stored);
    }
    return base64ToBytes(stored);
  }

  /** 首次初始化时建管理员；显式配置 ADMIN_PASSWORD 时以配置为准（方便部署后换掉默认密码） */
  async ensureAdmin() {
    const username = String(this.env.ADMIN_USERNAME || DEFAULT_ADMIN_USERNAME).trim() || DEFAULT_ADMIN_USERNAME;
    const password = String(this.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD);
    const key = userKey(username.toLowerCase());
    const existing = await this.storage.get(key);
    if (!existing) {
      const record = await this.makeRecord(username, password, 'admin');
      await this.storage.put(key, record);
      return;
    }
    if (this.env.ADMIN_PASSWORD && !(await verifyPassword(existing, password))) {
      const record = await this.rotatePassword(existing, password);
      record.tokenVersion = (record.tokenVersion || 0) + 1;
      await this.storage.put(key, record);
    }
  }

  /** 用户名是否被管理员占用（协议 §1.4：123 是保留名） */
  isReserved(lower) {
    const configured = String(this.env.ADMIN_USERNAME || DEFAULT_ADMIN_USERNAME).trim().toLowerCase();
    return lower === RESERVED_ADMIN_USERNAME || lower === configured;
  }

  iterations() {
    const raw = Number(this.env.PBKDF2_ITERATIONS);
    if (Number.isFinite(raw) && raw >= 1) return Math.min(1000000, Math.floor(raw));
    return DEFAULT_ITERATIONS;
  }

  isPasswordOk(password) {
    return typeof password === 'string' && password.length >= MIN_PASSWORD && password.length <= MAX_PASSWORD;
  }

  async makeRecord(username, password, role) {
    const now = new Date().toISOString();
    const salt = randomBytes(16);
    const iterations = this.iterations();
    const hash = await derive(password, salt, iterations);
    return {
      username,
      role,
      salt: bytesToBase64(salt),
      hash: bytesToBase64(hash),
      iterations,
      tokenVersion: 1,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: '',
      failCount: 0,
      failUntil: 0,
    };
  }

  /** 换密码：保留账号资料，只换盐/哈希（不改 tokenVersion，调用方决定是否作废旧 token） */
  async rotatePassword(record, password) {
    const salt = randomBytes(16);
    const iterations = this.iterations();
    const hash = await derive(password, salt, iterations);
    record.salt = bytesToBase64(salt);
    record.hash = bytesToBase64(hash);
    record.iterations = iterations;
    record.failCount = 0;
    record.failUntil = 0;
    record.updatedAt = new Date().toISOString();
    return record;
  }

  async signFor(record, lower) {
    return signToken(this.secret, {
      u: lower,
      r: record.role,
      tv: record.tokenVersion || 0,
      exp: Date.now() + TOKEN_TTL_MS,
    });
  }

  /** 校验 Authorization；失败返回 { error: Response } */
  async requireUser(request) {
    const header = (request.headers.get('Authorization') || '').trim();
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return { error: fail('unauthorized', '请先登录', 401) };
    const claims = await verifyToken(this.secret, match[1].trim());
    if (!claims) return { error: fail('unauthorized', '登录已失效，请重新登录', 401) };
    const lower = String(claims.u).toLowerCase();
    const record = await this.storage.get(userKey(lower));
    if (!record) return { error: fail('unauthorized', '登录已失效，请重新登录', 401) };
    // 改密 / 重置密码会 +1，旧 token 立刻失效
    if ((record.tokenVersion || 0) !== (claims.tv || 0)) {
      return { error: fail('unauthorized', '登录已失效，请重新登录', 401) };
    }
    return { user: record, lower };
  }

  async requireAdmin(request) {
    const auth = await this.requireUser(request);
    if (auth.error) return auth;
    if (auth.user.role !== 'admin') return { error: fail('forbidden', '需要管理员权限', 403) };
    return auth;
  }

  // ── 账号 ────────────────────────────────────────────────

  async handleRegister(request) {
    const body = await readJson(request);
    if (!body) return fail('bad-json', '请求体不是合法的 JSON 对象', 400);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!USERNAME_RE.test(username)) {
      return fail('bad-username', '用户名需 2~20 个字符，只允许中文、字母、数字、下划线', 400);
    }
    if (!this.isPasswordOk(password)) {
      return fail('bad-password', '密码长度需 ' + MIN_PASSWORD + '~' + MAX_PASSWORD + ' 位', 400);
    }
    const lower = username.toLowerCase();
    if (this.isReserved(lower)) return fail('reserved-username', '该用户名为管理员保留', 400);
    const key = userKey(lower);
    if (await this.storage.get(key)) return fail('username-exists', '用户名已存在', 409);
    const record = await this.makeRecord(username, password, 'user');
    record.lastLoginAt = new Date().toISOString();
    await this.storage.put(key, record);
    const token = await this.signFor(record, lower);
    return json({ ok: true, token, user: { username: record.username, role: record.role } });
  }

  async handleLogin(request) {
    const body = await readJson(request);
    if (!body) return fail('bad-json', '请求体不是合法的 JSON 对象', 400);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) return fail('bad-request', '请填写用户名和密码', 400);

    const lower = username.toLowerCase();
    const key = userKey(lower);
    const record = await this.storage.get(key);
    const now = Date.now();

    if (!record) {
      // 用户不存在也跑一次 PBKDF2，避免用响应时间探测用户名是否存在
      await derive(password, new Uint8Array(16), this.iterations());
      return fail('bad-credentials', '用户名或密码错误', 401);
    }

    if (record.failUntil && record.failUntil > now) {
      return fail('too-many-attempts', '登录失败次数过多，请 10 分钟后再试', 429);
    }
    if (record.failUntil && record.failUntil <= now) {
      record.failCount = 0;
      record.failUntil = 0;
    }

    if (!(await verifyPassword(record, password))) {
      record.failCount = (record.failCount || 0) + 1;
      if (record.failCount >= FAIL_LIMIT) record.failUntil = now + LOCK_MS;
      record.updatedAt = new Date().toISOString();
      await this.storage.put(key, record);
      return fail('bad-credentials', '用户名或密码错误', 401);
    }

    record.failCount = 0;
    record.failUntil = 0;
    record.lastLoginAt = new Date().toISOString();
    record.updatedAt = record.lastLoginAt;
    await this.storage.put(key, record);
    const token = await this.signFor(record, lower);
    return json({ ok: true, token, user: { username: record.username, role: record.role } });
  }

  async handleMe(request) {
    const auth = await this.requireUser(request);
    if (auth.error) return auth.error;
    const u = auth.user;
    return json({
      ok: true,
      user: { username: u.username, role: u.role, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || '' },
    });
  }

  /** 客户端删掉本地 token 即可；服务端只确认身份，不做黑名单 */
  async handleLogout(request) {
    const auth = await this.requireUser(request);
    if (auth.error) return auth.error;
    return json({ ok: true });
  }

  async handleChangePassword(request) {
    const auth = await this.requireUser(request);
    if (auth.error) return auth.error;
    const body = await readJson(request);
    if (!body) return fail('bad-json', '请求体不是合法的 JSON 对象', 400);
    const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const next = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (!current) return fail('bad-request', '请输入当前密码', 400);
    if (!this.isPasswordOk(next)) {
      return fail('bad-password', '新密码长度需 ' + MIN_PASSWORD + '~' + MAX_PASSWORD + ' 位', 400);
    }
    if (!(await verifyPassword(auth.user, current))) {
      return fail('bad-credentials', '当前密码不正确', 401);
    }
    const record = await this.rotatePassword(auth.user, next);
    record.tokenVersion = (record.tokenVersion || 0) + 1;   // 旧 token 全部失效
    await this.storage.put(userKey(auth.lower), record);
    const token = await this.signFor(record, auth.lower);
    return json({ ok: true, token });
  }

  // ── 存档 ────────────────────────────────────────────────

  async handleGetSave(request) {
    const auth = await this.requireUser(request);
    if (auth.error) return auth.error;
    const save = await this.storage.get(saveKey(auth.lower));
    return json({
      ok: true,
      save: save ? { data: save.data, version: save.version, updatedAt: save.updatedAt } : null,
    });
  }

  async handlePutSave(request) {
    const auth = await this.requireUser(request);
    if (auth.error) return auth.error;
    const body = await readJson(request);
    if (!body) return fail('bad-json', '请求体不是合法的 JSON 对象', 400);
    if (body.data === undefined || body.data === null) return fail('bad-data', '缺少存档数据 data', 400);

    let baseVersion = 0;
    if (body.baseVersion !== undefined && body.baseVersion !== null) {
      const n = Number(body.baseVersion);
      if (!Number.isInteger(n) || n < 0) return fail('bad-version', 'baseVersion 必须是非负整数', 400);
      baseVersion = n;
    }

    let bytes;
    try {
      bytes = encoder.encode(JSON.stringify(body.data)).length;
    } catch {
      return fail('bad-data', '存档数据不是合法的 JSON', 400);
    }
    if (bytes > SAVE_MAX_BYTES) {
      return fail('save-too-large', '存档不能超过 ' + SAVE_MAX_BYTES / 1024 + ' KB', 413);
    }

    const key = saveKey(auth.lower);
    const current = await this.storage.get(key);
    const currentVersion = current ? Number(current.version) || 0 : 0;
    if (baseVersion !== currentVersion) {
      return json({
        ok: false,
        error: 'conflict',
        message: '云端存档已被更新，请选择保留哪一份',
        save: current
          ? { data: current.data, version: currentVersion, updatedAt: current.updatedAt }
          : null,
      }, 409);
    }

    const now = new Date().toISOString();
    const next = {
      data: body.data,
      version: currentVersion + 1,
      updatedAt: now,
      bytes,
      summary: summarize(body.data),
    };
    await this.storage.put(key, next);
    return json({ ok: true, save: { version: next.version, updatedAt: now } });
  }

  // ── 管理员 ──────────────────────────────────────────────

  async handleAdminUsers(request) {
    const auth = await this.requireAdmin(request);
    if (auth.error) return auth.error;
    const list = await this.storage.list({ prefix: 'user:' });
    const users = [];
    for (const [key, record] of list) {
      const lower = key.slice('user:'.length);
      const save = await this.storage.get(saveKey(lower));
      users.push({
        username: record.username,
        role: record.role,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        lastLoginAt: record.lastLoginAt || '',
        save: save
          ? { version: save.version, updatedAt: save.updatedAt, bytes: save.bytes, summary: summarize(save.data) }
          : null,
      });
    }
    // 按创建时间排序（管理员最先建，所以稳定排在最前）
    users.sort((a, b) => (
      String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.username).localeCompare(String(b.username))
    ));
    return json({ ok: true, users });
  }

  async handleAdminResetPassword(request) {
    const auth = await this.requireAdmin(request);
    if (auth.error) return auth.error;
    const body = await readJson(request);
    if (!body) return fail('bad-json', '请求体不是合法的 JSON 对象', 400);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const next = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (!username) return fail('bad-request', '请填写用户名', 400);
    if (!this.isPasswordOk(next)) {
      return fail('bad-password', '新密码长度需 ' + MIN_PASSWORD + '~' + MAX_PASSWORD + ' 位', 400);
    }
    const lower = username.toLowerCase();
    const key = userKey(lower);
    const record = await this.storage.get(key);
    if (!record) return fail('not-found', '用户不存在', 404);
    const updated = await this.rotatePassword(record, next);
    updated.tokenVersion = (updated.tokenVersion || 0) + 1;   // 重置后旧 token 失效
    await this.storage.put(key, updated);
    return json({ ok: true });
  }

  async handleAdminDelete(request) {
    const auth = await this.requireAdmin(request);
    if (auth.error) return auth.error;
    const body = await readJson(request);
    if (!body) return fail('bad-json', '请求体不是合法的 JSON 对象', 400);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    if (!username) return fail('bad-request', '请填写用户名', 400);
    const lower = username.toLowerCase();
    if (lower === auth.lower) return fail('cannot-delete-self', '不能删除自己的账号', 400);
    if (!(await this.storage.get(userKey(lower)))) return fail('not-found', '用户不存在', 404);
    await this.storage.delete(userKey(lower));
    await this.storage.delete(saveKey(lower));
    return json({ ok: true });
  }

  // ── HTTP 入口 ───────────────────────────────────────────

  async fetch(request) {
    try {
      await this.ready;
    } catch {
      return fail('init-failed', '服务初始化失败，请稍后重试', 500);
    }

    const url = new URL(request.url);
    const method = String(request.method || 'GET').toUpperCase();
    let path = url.pathname || '/';
    if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '') || '/';

    // 预检：直接 204 + CORS 头，不碰存储（APK 走 file:// 时会先发它）
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    try {
      switch (path) {
        case '/api/auth/register':
          return method === 'POST' ? await this.handleRegister(request) : fail('need-post', '该接口只支持 POST', 405);
        case '/api/auth/login':
          return method === 'POST' ? await this.handleLogin(request) : fail('need-post', '该接口只支持 POST', 405);
        case '/api/auth/me':
          return method === 'GET' ? await this.handleMe(request) : fail('need-get', '该接口只支持 GET', 405);
        case '/api/auth/logout':
          return method === 'POST' ? await this.handleLogout(request) : fail('need-post', '该接口只支持 POST', 405);
        case '/api/auth/password':
          return method === 'POST' ? await this.handleChangePassword(request) : fail('need-post', '该接口只支持 POST', 405);
        case '/api/save':
          if (method === 'GET') return await this.handleGetSave(request);
          if (method === 'PUT') return await this.handlePutSave(request);
          return fail('need-get-or-put', '该接口只支持 GET 或 PUT', 405);
        case '/api/admin/users':
          return method === 'GET' ? await this.handleAdminUsers(request) : fail('need-get', '该接口只支持 GET', 405);
        case '/api/admin/reset-password':
          return method === 'POST' ? await this.handleAdminResetPassword(request) : fail('need-post', '该接口只支持 POST', 405);
        case '/api/admin/delete':
          return method === 'POST' ? await this.handleAdminDelete(request) : fail('need-post', '该接口只支持 POST', 405);
        default:
          return fail('not-found', '接口不存在', 404);
      }
    } catch {
      return fail('server-error', '服务器内部错误', 500);
    }
  }
}

