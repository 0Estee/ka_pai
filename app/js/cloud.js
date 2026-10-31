/**
 * 云存档客户端：账号登录 / 存档双向同步 / 管理员数据。
 *
 * 服务端契约见 docs/云存档协议.md：
 *   · 除注册 / 登录外每个请求都带 Authorization: Bearer <token>；
 *   · 错误统一是 { ok:false, error:'code', message:'中文' }；
 *   · 存档 PUT 带 baseVersion，服务端版本对不上时回 409 + 当前存档，
 *     这时**绝不能自动覆盖**，要等玩家在账户页里二选一。
 *
 * 设计约束（都是踩过的坑）：
 *   · token 只存在本机（Store.loadCloudAuth/saveCloudAuth/clearCloudAuth）；
 *   · 所有网络失败都收敛成 cloudStatus().error 的中文提示，**不向界面抛异常** ——
 *     云存档坏掉最多是「这次没同步上」，不能让首页 / 对局崩掉；
 *   · 没有 fetch、没登录时静默跳过（构建门禁的 DOM 桩里就没有 fetch）；
 *   · 管理员口令一律不写进客户端：客户端只把用户名 / 密码交给服务端验证。
 *
 * ⚠ 打包器把 app/js 所有模块拍进同一作用域（见 tools/build-web.mjs），
 *   顶层重名会直接构建失败。所以：
 *     · 公开 API 名字按协议固定：init / login / register / ... / status；
 *     · **内部**变量与辅助函数一律 cloud 前缀（cloudAuth / cloudRequest / ...）。
 */

import * as Store from './store.js';
import { profile, setProfile } from './app-state.js';

/** APK 从 file:// 加载时用的公网 API 根地址（http(s) 页面一律同源 /api） */
const CLOUD_BASE = 'https://wangzuo.icu';
/** 本地存档改动后等这么久再上传：一局里金币 / 强化会连着改十几次，逐次上传既慢又吵 */
const CLOUD_SAVE_DEBOUNCE_MS = 2000;
/** 单次请求超时：手机上弱网很常见，不能让「正在同步」永远转圈 */
const CLOUD_REQUEST_TIMEOUT_MS = 15000;
/** 服务端上限 64 KB（回放不同步，profile 正常只有几 KB） */
const CLOUD_SAVE_MAX_BYTES = 64 * 1024;

let cloudAuth = null;          // { token, user:{username,role}, savedAt }
let cloudOnChange = null;      // init({onChange}) 拿到的刷新回调
let cloudBusy = false;         // 玩家主动发起的请求进行中
let cloudError = '';           // 中文错误提示（给界面直接显示）
let cloudNotice = '';          // 中文操作结果（成功 / 进行中）
let cloudLastVersion = 0;      // 已知的云端版本号（PUT 的 baseVersion）
let cloudLastSavedAt = 0;      // 最近一次成功同步的时间（毫秒）
let cloudConflict = null;      // { remoteVersion, remoteUpdatedAt }
let cloudRemoteSave = null;    // 最近一次拿到的云端存档 { data, version, updatedAt }
let cloudPendingSave = null;   // 防抖期间待上传的 profile
let cloudPushTimer = null;     // 防抖定时器
let cloudPushing = false;      // 自动上传是否在进行（避免并发覆盖）
let cloudSuppressHook = false; // useCloud 写回本地时别把「下载」当成「玩家改动」再传回去
let cloudAdminUsers = [];
let cloudAdminLoading = false;
let cloudAdminError = '';
let cloudConfirmDelete = '';
/**
 * 管理员正在编辑的那个玩家的数据（null = 没在编辑）。
 * 形状：{ username, loading, saving, error, hint, rawOpen, version, exists,
 *         form:{gold,dust,perf,games,wins,losses,draws}, raw }
 * 表单值放在这里而不是直接从 DOM 读：保存过程中会重绘一次，直接从 DOM 读会把
 * 玩家刚敲进去的数冲掉（先 setField 落进 form，再重绘）。
 */
let cloudAdminEdit = null;
/** 最近的管理操作（服务端审计，倒序） */
let cloudAdminLog = [];
/**
 * 最后一次真的发出去的请求（{method,path,body,at}）。
 * 只给自检用：打包门禁的 DOM 桩没有真网络，靠它才能断言「点保存时到底发了什么」。
 * 正常运行时它只是多留一个对象，不参与任何判断。
 */
let cloudLastRequest = null;
/** 最近 20 条请求（自检要「找到那条 POST」，光看最后一条会被后台的列表刷新顶掉） */
let cloudRequestLog = [];

// ══════════════════════════════════════════════════════════
// 地址与底层请求
// ══════════════════════════════════════════════════════════

/** 页面是 http(s) 时同源；file://（APK）时走公网 CLOUD_BASE */
function cloudApiBase() {
  try {
    const loc = globalThis.location;
    const protocol = loc && typeof loc.protocol === 'string' ? loc.protocol : '';
    if (protocol === 'http:' || protocol === 'https:') return '';
  } catch {
    // 某些环境访问 location 会抛异常，按 file:// 处理
  }
  return CLOUD_BASE;
}

function cloudUrl(path) {
  // path 一律写成 '/api/...'（协议里所有接口都在 /api 下），这里只补 origin
  return cloudApiBase() + path;
}

/** 时间戳既可能是毫秒数，也可能是服务端的 ISO 字符串 */
function cloudTimeValue(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** 存档大小的保守估计（服务端按 UTF-8 字节算，超了会 413） */
function cloudByteSize(value) {
  try {
    const raw = JSON.stringify(value) || '';
    const Encoder = globalThis.TextEncoder;
    if (typeof Encoder === 'function') return new Encoder().encode(raw).length;
    return raw.length * 2;
  } catch {
    return 0;
  }
}

/** 服务端没给 message 时的兜底中文（协议 §1 的错误码） */
function cloudErrorMessage(code, status, serverMessage) {
  if (typeof serverMessage === 'string' && serverMessage.trim()) return serverMessage.trim();
  const byCode = {
    conflict: '云端存档已被更新，请选择保留哪一份',
    'save-too-large': '存档超过 64 KB，无法上传',
    unauthorized: '登录已过期，请重新登录',
    forbidden: '需要管理员权限',
    'username-exists': '用户名已存在',
    'bad-credentials': '用户名或密码错误',
    'bad-username': '用户名需 2~20 个字符，只允许中文、字母、数字、下划线',
    'bad-password': '密码长度需 6~128 位',
    'cannot-delete-self': '不能删除自己的账号',
    'not-found': '用户不存在',
    'too-many-attempts': '登录尝试过多，请过一会儿再试',
  };
  if (byCode[code]) return byCode[code];
  switch (status) {
    case 400: return '提交的内容不合法，请检查后重试';
    case 401: return '登录已过期，请重新登录';
    case 403: return '没有权限（需要管理员账号）';
    case 404: return '没有找到这个用户';
    case 409: return '云端存档已被更新，请选择保留哪一份';
    case 413: return '存档超过 64 KB，无法上传';
    case 429: return '登录尝试过多，请 10 分钟后再试';
    default: break;
  }
  if (status >= 500) return '云存档服务器暂时不可用，请稍后再试';
  return '云存档请求失败，请稍后再试';
}

/** 401 会清掉本机登录态：token 已经不可用了，继续留着只会反复失败 */
function cloudDropSession(message) {
  cloudAuth = null;
  try { Store.clearCloudAuth(); } catch { /* 存不下也没关系，内存里已经清空 */ }
  cloudLastVersion = 0;
  cloudLastSavedAt = 0;
  cloudConflict = null;
  cloudRemoteSave = null;
  cloudPendingSave = null;
  if (cloudPushTimer) { clearTimeout(cloudPushTimer); cloudPushTimer = null; }
  cloudAdminUsers = [];
  cloudAdminLoading = false;
  cloudAdminError = '';
  cloudConfirmDelete = '';
  cloudAdminEdit = null;
  cloudAdminLog = [];
  cloudError = message || '登录已过期，请重新登录';
  cloudNotice = '';
}

/**
 * 唯一发请求的地方。永远 resolve，不 reject：
 *   { ok:true, status, data }
 *   { ok:false, code, status, message, save?, sessionExpired? }
 *
 * token 语义：opts.token === null 表示这个请求**不带** Authorization
 * （登录 / 注册），undefined 表示用当前登录态。
 */
async function cloudRequest(method, path, payload, options) {
  const opts = options || {};
  const fetchFn = globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return { ok: false, code: 'offline', status: 0, message: '当前环境不能联网，云存档暂不可用' };
  }

  const token = opts.token === undefined ? (cloudAuth && cloudAuth.token) : opts.token;
  const headers = { Accept: 'application/json' };
  const init = { method, headers, cache: 'no-store' };
  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
    try {
      init.body = JSON.stringify(payload);
    } catch {
      return { ok: false, code: 'bad-json', status: 0, message: '本地数据无法序列化，云存档没有上传' };
    }
  }
  if (token) headers.Authorization = 'Bearer ' + token;
  // 记一笔（见 cloudLastRequest 的注释）；解析失败就不记，别把坏 payload 也存下来
  try {
    cloudLastRequest = { method, path: String(path), body: payload === undefined ? null : JSON.parse(init.body), at: Date.now() };
    cloudRequestLog.push(cloudLastRequest);
    if (cloudRequestLog.length > 20) cloudRequestLog.splice(0, cloudRequestLog.length - 20);
  } catch { /* 忽略 */ }

  let abortCtl = null;
  let timeoutId = 0;
  try {
    if (typeof globalThis.AbortController === 'function') {
      abortCtl = new AbortController();
      init.signal = abortCtl.signal;
      timeoutId = setTimeout(() => { try { abortCtl.abort(); } catch { /* 已经结束 */ } }, CLOUD_REQUEST_TIMEOUT_MS);
    }
  } catch {
    abortCtl = null;
  }

  try {
    const res = await fetchFn(cloudUrl(path), init);
    const status = Number(res && res.status) || 0;
    let text = '';
    try { text = await res.text(); } catch { text = ''; }
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = null; }
    }

    const okFlag = !!(res && res.ok);
    if (!okFlag || (body && body.ok === false)) {
      const code = body && typeof body.error === 'string' ? body.error : 'http-' + status;
      const result = {
        ok: false,
        code,
        status,
        message: cloudErrorMessage(code, status, body && body.message),
        save: body && body.save ? body.save : null,
      };
      if (status === 401 && token) {
        cloudDropSession('登录已过期，请重新登录');
        result.sessionExpired = true;
        result.message = cloudError;
      }
      return result;
    }
    if (!body || typeof body !== 'object') {
      return { ok: false, code: 'bad-response', status, message: '服务器返回了无法识别的内容，请稍后再试' };
    }
    return { ok: true, status, data: body };
  } catch (err) {
    const aborted = !!(err && (err.name === 'AbortError' || err.name === 'TimeoutError'));
    return {
      ok: false,
      code: aborted ? 'timeout' : 'network',
      status: 0,
      message: aborted ? '连接云存档超时，请检查网络后重试' : '连不上云存档服务器，请检查网络',
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// ══════════════════════════════════════════════════════════
// 状态与回调
// ══════════════════════════════════════════════════════════

/** 界面拿到的唯一状态快照（render.js 直接把它塞给 accountHTML/adminHTML） */
function cloudStatus() {
  const user = cloudAuth && cloudAuth.user && cloudAuth.user.username
    ? {
      username: String(cloudAuth.user.username),
      role: cloudAuth.user.role === 'admin' ? 'admin' : 'user',
    }
    : null;
  return {
    user,
    busy: cloudBusy,
    error: cloudError,
    notice: cloudNotice,
    lastVersion: cloudLastVersion,
    lastSavedAt: cloudLastSavedAt,
    conflict: cloudConflict
      ? { remoteVersion: cloudConflict.remoteVersion, remoteUpdatedAt: cloudConflict.remoteUpdatedAt }
      : null,
    admin: {
      users: cloudAdminUsers,
      loading: cloudAdminLoading,
      error: cloudAdminError,
      confirmDelete: cloudConfirmDelete,
      // 改数据面板 + 最近的操作记录（0.69.0）
      edit: cloudAdminEdit,
      log: cloudAdminLog,
    },
  };
}

function cloudNotify() {
  if (!cloudOnChange) return;
  try { cloudOnChange(cloudStatus()); } catch { /* 回调出错不能影响云存档本身 */ }
}

/** 所有「玩家主动发起」的操作都走这里：统一 busy / 异常兜底 / 收尾刷新 */
async function cloudRun(task) {
  if (cloudBusy) return { ok: false, busy: true, message: '正在同步，请稍候' };
  cloudBusy = true;
  cloudNotify();
  let result;
  try {
    result = await task();
  } catch {
    cloudError = '云存档操作失败，请稍后再试';
    result = { ok: false, code: 'unknown', message: cloudError };
  }
  cloudBusy = false;
  cloudNotify();
  return result || { ok: false, message: cloudError };
}

function cloudSaveSession(token, user) {
  const nextUser = user && user.username
    ? { username: String(user.username), role: user.role === 'admin' ? 'admin' : 'user' }
    : null;
  cloudAuth = { token: String(token), user: nextUser, savedAt: Date.now() };
  try { Store.saveCloudAuth(cloudAuth); } catch { /* 存不下就只在本次运行有效 */ }
}

function cloudIsAdmin() {
  return !!(cloudAuth && cloudAuth.user && cloudAuth.user.role === 'admin');
}

/** 空档：既没打过局、也没有表现分。这时云端存档可以直接采用，不会丢本地进度。 */
function cloudEmptyProfile(p) {
  const src = p || profile;
  return !src || (Number(src.games) === 0 && Number(src.perf) === 0);
}

/** 把云端存档写回本地：normalizeProfile 补齐字段，setProfile 换掉整份档案 */
function cloudApplyRemote(save) {
  const data = save && save.data;
  if (!data || typeof data !== 'object') return false;
  const next = Store.normalizeProfile(data);
  if (cloudPushTimer) { clearTimeout(cloudPushTimer); cloudPushTimer = null; }
  cloudPendingSave = null;
  cloudSuppressHook = true;
  try {
    setProfile(next);
    try { Store.saveProfile(next); } catch { /* 本地存不下也先让这次恢复生效 */ }
  } finally {
    cloudSuppressHook = false;
  }
  cloudLastVersion = Number(save.version) || cloudLastVersion;
  cloudLastSavedAt = cloudTimeValue(save.updatedAt) || Date.now();
  return true;
}

/** PUT /api/save；409 时进入冲突态（不覆盖任何一边） */
async function cloudPutSave(baseVersion, data) {
  const bytes = cloudByteSize(data);
  if (bytes > CLOUD_SAVE_MAX_BYTES) {
    return {
      ok: false,
      code: 'save-too-large',
      status: 413,
      message: '本地存档超过 64 KB，无法上传（回放不在同步范围内）',
    };
  }
  const result = await cloudRequest('PUT', '/api/save', { data, baseVersion: Number(baseVersion) || 0 });
  if (result.ok) {
    const save = result.data.save || {};
    cloudLastVersion = Number(save.version) || (Number(baseVersion) || 0) + 1;
    cloudLastSavedAt = cloudTimeValue(save.updatedAt) || Date.now();
    cloudConflict = null;
    cloudRemoteSave = null;
    return { ok: true, version: cloudLastVersion, updatedAt: cloudLastSavedAt };
  }
  if (result.status === 409) {
    const remote = result.save || (result.data && result.data.save) || null;
    cloudRemoteSave = remote;
    cloudConflict = {
      remoteVersion: remote ? Number(remote.version) || 0 : 0,
      remoteUpdatedAt: remote ? remote.updatedAt || 0 : 0,
    };
    return {
      ok: false,
      code: 'conflict',
      conflict: true,
      status: 409,
      message: result.message || '云端存档已被更新，请选择保留哪一份',
    };
  }
  return result;
}

/**
 * 登录 / 注册成功后的第一次对齐（协议 §2）：
 *   云端没有存档 → 上传本地；
 *   本地是空档   → 直接采用云端；
 *   两边都有     → 进冲突态，等玩家自己选。
 */
async function cloudSyncAfterLogin() {
  const result = await cloudRequest('GET', '/api/save');
  if (!result.ok) {
    if (!result.sessionExpired) {
      cloudError = result.message;
      cloudNotice = '已登录，但没能读到云端存档';
    }
    return result;
  }

  const save = result.data.save;
  if (!save) {
    cloudLastVersion = 0;
    cloudLastSavedAt = 0;
    cloudNotice = '云端还没有存档，正在上传本地进度…';
    cloudNotify();
    const uploaded = await cloudPutSave(0, Store.normalizeProfile(profile));
    if (uploaded.ok) {
      cloudError = '';
      cloudNotice = '登录成功，本地进度已上传到云端';
    } else if (uploaded.conflict) {
      cloudError = '';
      cloudNotice = '云端存档刚刚被更新，请选择用哪一份';
    } else {
      cloudError = uploaded.message || '上传本地进度失败，请稍后再试';
      cloudNotice = '';
    }
    return uploaded;
  }

  cloudLastVersion = Number(save.version) || 0;
  cloudRemoteSave = save;
  if (cloudEmptyProfile(profile)) {
    if (cloudApplyRemote(save)) {
      cloudError = '';
      cloudNotice = '登录成功，已载入云端存档';
      return { ok: true };
    }
    cloudError = '云端存档格式不对，未能载入';
    cloudNotice = '';
    return { ok: false, message: cloudError };
  }

  cloudConflict = {
    remoteVersion: cloudLastVersion,
    remoteUpdatedAt: save.updatedAt || 0,
  };
  cloudError = '';
  cloudNotice = '云端和本地都有进度，请选择用哪一份（不会自动覆盖）';
  return { ok: true, conflict: true };
}

/** 启动时顺手验一下 token：失败不影响开局，401 才清登录态 */
async function cloudVerifySession() {
  if (!cloudAuth || !cloudAuth.token) return;
  const result = await cloudRequest('GET', '/api/auth/me');
  if (result.ok) {
    const me = result.data.user;
    if (me && me.username) {
      cloudAuth = {
        ...cloudAuth,
        user: { username: String(me.username), role: me.role === 'admin' ? 'admin' : 'user' },
      };
      try { Store.saveCloudAuth(cloudAuth); } catch { /* 忽略 */ }
      cloudNotify();
    }
    return;
  }
  if (result.sessionExpired) cloudNotify();
  // 网络失败静默：启动时离线不该给玩家弹一条「连不上」
}

// ══════════════════════════════════════════════════════════
// 本地存档 → 云端（防抖自动上传）
// ══════════════════════════════════════════════════════════

/**
 * Store.saveProfile 的成功回调（钩子由 store.js 调用）。
 * 这里只登记「有一份新进度」，2 秒内再改只重置定时器；真正上传在 cloudFlushPendingSave。
 */
function cloudOnLocalSave(next) {
  if (cloudSuppressHook) return;              // useCloud 写回本地，不算玩家改动
  if (!cloudAuth || !cloudAuth.token) return; // 没登录就静默跳过
  if (cloudConflict) return;                  // 冲突态绝不自动覆盖
  cloudPendingSave = next || profile;
  if (cloudPushTimer) clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(() => {
    cloudPushTimer = null;
    cloudFlushPendingSave();
  }, CLOUD_SAVE_DEBOUNCE_MS);
}

async function cloudFlushPendingSave() {
  if (!cloudAuth || !cloudAuth.token || cloudConflict) return;
  if (cloudPushing) {
    // 上一轮还没回来：过一会儿再试，别并发 PUT（两个 baseVersion 会互相打架）
    if (cloudPushTimer) clearTimeout(cloudPushTimer);
    cloudPushTimer = setTimeout(() => {
      cloudPushTimer = null;
      cloudFlushPendingSave();
    }, 800);
    return;
  }
  const data = Store.normalizeProfile(cloudPendingSave || profile);
  cloudPushing = true;
  try {
    const result = await cloudPutSave(cloudLastVersion, data);
    if (!cloudAuth) return; // 期间玩家退出了登录
    if (result.ok) {
      cloudError = '';
      cloudNotify(); // 首页 / 账户页的「最近同步」要跟着变
      return;
    }
    if (result.conflict) {
      cloudError = '';
      cloudNotice = '云端存档已被更新，请选择用哪一份';
      cloudNotify();
      return;
    }
    if (result.sessionExpired) {
      cloudNotify();
      return;
    }
    // 自动上传失败：记下中文提示，但不在玩的时候打断；下次打开账户页能看到
    cloudError = result.message || '云存档上传失败，请检查网络';
  } finally {
    cloudPushing = false;
  }
}

// ══════════════════════════════════════════════════════════
// 公开 API：初始化 / 登录 / 同步
// ══════════════════════════════════════════════════════════

/**
 * 读登录态 + 注册本地存档钩子。onChange 在状态变化时被调用（main.js 用它刷新当前屏）。
 * 不阻塞启动：token 校验在后台跑，通过了 / 过期了再各自通知一次。
 */
function init(options) {
  const opts = options || {};
  cloudOnChange = typeof opts.onChange === 'function' ? opts.onChange : null;
  cloudAuth = Store.loadCloudAuth();
  cloudBusy = false;
  cloudError = '';
  cloudNotice = '';
  cloudConflict = null;
  cloudRemoteSave = null;
  cloudPendingSave = null;
  cloudPushing = false;
  cloudAdminUsers = [];
  cloudAdminLoading = false;
  cloudAdminError = '';
  cloudConfirmDelete = '';
  cloudAdminEdit = null;
  cloudAdminLog = [];
  if (cloudPushTimer) { clearTimeout(cloudPushTimer); cloudPushTimer = null; }
  try { Store.setCloudSaveHook(cloudOnLocalSave); } catch { /* 老版本 store 没有钩子就跳过 */ }
  if (cloudAuth && cloudAuth.token) cloudVerifySession();
  return cloudStatus();
}

/** 登录 / 注册的共用部分：成功以后一定要做一次云端对齐 */
function cloudAuthAction(path, username, password) {
  const name = String(username === undefined || username === null ? '' : username).trim();
  const pass = String(password === undefined || password === null ? '' : password);
  if (!name || !pass) {
    cloudError = '请输入用户名和密码';
    cloudNotice = '';
    cloudNotify();
    return Promise.resolve({ ok: false, message: cloudError });
  }
  return cloudRun(async () => {
    cloudError = '';
    cloudNotice = '正在验证账号…';
    cloudConflict = null;
    cloudRemoteSave = null;
    cloudLastVersion = 0;
    cloudLastSavedAt = 0;
    cloudNotify();

    const result = await cloudRequest('POST', path, { username: name, password: pass }, { token: null });
    if (!result.ok) {
      cloudError = result.message;
      cloudNotice = '';
      return result;
    }
    const token = result.data.token;
    if (typeof token !== 'string' || !token) {
      cloudError = '服务器没有返回登录凭证，请稍后再试';
      cloudNotice = '';
      return { ok: false, message: cloudError };
    }
    cloudSaveSession(token, result.data.user);
    cloudNotice = '登录成功，正在检查云端存档…';
    cloudNotify();
    const synced = await cloudSyncAfterLogin();
    return synced && synced.ok === false ? synced : { ok: true, conflict: !!(synced && synced.conflict) };
  });
}

function login(username, password) {
  return cloudAuthAction('/api/auth/login', username, password);
}

function register(username, password) {
  return cloudAuthAction('/api/auth/register', username, password);
}

/** 退出登录：本机立即生效；服务端让 token 失效只是顺手的事，失败不影响 */
async function logout() {
  const token = cloudAuth && cloudAuth.token;
  if (cloudPushTimer) { clearTimeout(cloudPushTimer); cloudPushTimer = null; }
  cloudAuth = null;
  try { Store.clearCloudAuth(); } catch { /* 忽略 */ }
  cloudLastVersion = 0;
  cloudLastSavedAt = 0;
  cloudConflict = null;
  cloudRemoteSave = null;
  cloudPendingSave = null;
  cloudAdminUsers = [];
  cloudAdminLoading = false;
  cloudAdminError = '';
  cloudConfirmDelete = '';
  cloudAdminEdit = null;
  cloudAdminLog = [];
  cloudError = '';
  cloudNotice = '已退出登录，本地进度仍然保留';
  cloudNotify();
  if (token) {
    try { await cloudRequest('POST', '/api/auth/logout', undefined, { token }); } catch { /* 忽略 */ }
  }
  return { ok: true };
}

function changePassword(currentPassword, newPassword) {
  if (!cloudAuth) {
    cloudError = '请先登录云存档';
    cloudNotice = '';
    cloudNotify();
    return Promise.resolve({ ok: false, message: cloudError });
  }
  const oldPass = String(currentPassword === undefined || currentPassword === null ? '' : currentPassword);
  const nextPass = String(newPassword === undefined || newPassword === null ? '' : newPassword);
  if (!oldPass || !nextPass) {
    cloudError = '请填写当前密码和新密码';
    cloudNotice = '';
    cloudNotify();
    return Promise.resolve({ ok: false, message: cloudError });
  }
  return cloudRun(async () => {
    cloudError = '';
    cloudNotice = '';
    const result = await cloudRequest('POST', '/api/auth/password', {
      currentPassword: oldPass,
      newPassword: nextPass,
    });
    if (!result.ok) {
      cloudError = result.message;
      return result;
    }
    // 改密码会让旧 token 全部失效，服务端会顺手发一个新的
    if (result.data && typeof result.data.token === 'string' && result.data.token) {
      cloudSaveSession(result.data.token, cloudAuth && cloudAuth.user);
    }
    cloudNotice = '密码已修改；其它设备需要重新登录';
    return { ok: true };
  });
}

/** 立即上传本地（不等防抖） */
function pushLocal() {
  if (!cloudAuth) {
    cloudError = '请先登录云存档';
    cloudNotice = '';
    cloudNotify();
    return Promise.resolve({ ok: false, message: cloudError });
  }
  return cloudRun(async () => {
    cloudError = '';
    cloudNotice = '正在上传本地存档…';
    const base = cloudConflict ? cloudConflict.remoteVersion : cloudLastVersion;
    const result = await cloudPutSave(base, Store.normalizeProfile(profile));
    if (result.ok) {
      cloudConflict = null;
      cloudNotice = '本地进度已上传到云端';
    } else if (result.conflict) {
      cloudNotice = '云端存档已被更新，请选择用哪一份';
    } else {
      cloudError = result.message;
      cloudNotice = '';
    }
    return result;
  });
}

/** 拉取云端：本地有进度时只进入冲突态，绝不自动覆盖 */
function pullRemote() {
  if (!cloudAuth) {
    cloudError = '请先登录云存档';
    cloudNotice = '';
    cloudNotify();
    return Promise.resolve({ ok: false, message: cloudError });
  }
  return cloudRun(async () => {
    cloudError = '';
    cloudNotice = '正在读取云端存档…';
    const result = await cloudRequest('GET', '/api/save');
    if (!result.ok) {
      cloudError = result.message;
      cloudNotice = '';
      return result;
    }
    const save = result.data.save;
    if (!save) {
      cloudLastVersion = 0;
      cloudRemoteSave = null;
      cloudConflict = null;
      cloudNotice = '云端还没有存档，可以先「上传本地」';
      return { ok: false, message: cloudNotice };
    }
    cloudRemoteSave = save;
    cloudLastVersion = Number(save.version) || 0;

    if (cloudEmptyProfile(profile)) {
      if (!cloudApplyRemote(save)) {
        cloudError = '云端存档格式不对，未能载入';
        cloudNotice = '';
        return { ok: false, message: cloudError };
      }
      cloudConflict = null;
      cloudError = '';
      cloudNotice = '已用云端存档覆盖本地';
      return { ok: true };
    }

    cloudConflict = {
      remoteVersion: cloudLastVersion,
      remoteUpdatedAt: save.updatedAt || 0,
    };
    cloudNotice = '云端与本地都有进度，请选择用哪一份（不会自动覆盖）';
    return { ok: true, conflict: true };
  });
}

/** 冲突二选一：用本地覆盖云端（带着云端当前版本号上传，避免又撞 409） */
function useLocal() {
  if (!cloudAuth) {
    cloudError = '请先登录云存档';
    cloudNotice = '';
    cloudNotify();
    return Promise.resolve({ ok: false, message: cloudError });
  }
  return cloudRun(async () => {
    cloudError = '';
    cloudNotice = '正在用本地存档覆盖云端…';
    const base = cloudConflict ? cloudConflict.remoteVersion : cloudLastVersion;
    const result = await cloudPutSave(base, Store.normalizeProfile(profile));
    if (result.ok) {
      cloudConflict = null;
      cloudNotice = '已用本地存档覆盖云端';
    } else if (result.conflict) {
      cloudNotice = '云端又更新了，请重新选择用哪一份';
    } else {
      cloudError = result.message;
      cloudNotice = '';
    }
    return result;
  });
}

/** 冲突二选一：用云端覆盖本地 */
function useCloud() {
  if (!cloudAuth) {
    cloudError = '请先登录云存档';
    cloudNotice = '';
    cloudNotify();
    return Promise.resolve({ ok: false, message: cloudError });
  }
  return cloudRun(async () => {
    cloudError = '';
    cloudNotice = '正在载入云端存档…';
    let save = cloudRemoteSave;
    if (!save || !save.data) {
      const result = await cloudRequest('GET', '/api/save');
      if (!result.ok) {
        cloudError = result.message;
        cloudNotice = '';
        return result;
      }
      save = result.data.save;
    }
    if (!save || !save.data) {
      cloudError = '云端还没有存档，无法使用';
      cloudNotice = '';
      return { ok: false, message: cloudError };
    }
    if (!cloudApplyRemote(save)) {
      cloudError = '云端存档格式不对，未能载入';
      cloudNotice = '';
      return { ok: false, message: cloudError };
    }
    cloudConflict = null;
    cloudError = '';
    cloudNotice = '已使用云端存档，本地已更新';
    return { ok: true };
  });
}

// ══════════════════════════════════════════════════════════
// 管理员
// ══════════════════════════════════════════════════════════

/** 服务端返回的字段可能很多，这里只收界面要用的，并统一类型 */
function cloudCleanUser(raw) {
  const save = raw.save && typeof raw.save === 'object' ? raw.save : null;
  const summary = save && save.summary && typeof save.summary === 'object' ? save.summary : null;
  return {
    username: String(raw.username || ''),
    role: raw.role === 'admin' ? 'admin' : 'user',
    createdAt: raw.createdAt || '',
    updatedAt: raw.updatedAt || '',
    lastLoginAt: raw.lastLoginAt || '',
    save: save
      ? {
        version: Number(save.version) || 0,
        updatedAt: save.updatedAt || '',
        bytes: Number(save.bytes) || 0,
        summary: summary
          ? {
            games: Number(summary.games) || 0,
            wins: Number(summary.wins) || 0,
            perf: Number(summary.perf) || 0,
            gold: Number(summary.gold) || 0,
          }
          : null,
      }
      : null,
  };
}

function loadAdminUsers() {
  if (!cloudAuth) {
    cloudAdminUsers = [];
    cloudAdminLoading = false;
    cloudAdminError = '请先登录云存档';
    cloudNotify();
    return Promise.resolve({ ok: false, message: cloudAdminError });
  }
  if (!cloudIsAdmin()) {
    cloudAdminUsers = [];
    cloudAdminLoading = false;
    cloudAdminError = '需要管理员权限';
    cloudNotify();
    return Promise.resolve({ ok: false, message: cloudAdminError });
  }
  if (cloudAdminLoading) return Promise.resolve({ ok: false, busy: true });
  cloudAdminLoading = true;
  cloudAdminError = '';
  cloudNotify();

  return cloudRequest('GET', '/api/admin/users').then((result) => {
    cloudAdminLoading = false;
    if (!result.ok) {
      cloudAdminError = result.message || '读取用户列表失败，请稍后重试';
      cloudNotify();
      return result;
    }
    const list = result.data && Array.isArray(result.data.users) ? result.data.users : [];
    cloudAdminUsers = list
      .filter((u) => u && typeof u === 'object' && u.username)
      .map(cloudCleanUser);
    cloudAdminError = '';
    cloudNotify();
    return { ok: true, users: cloudAdminUsers };
  }).catch(() => {
    cloudAdminLoading = false;
    cloudAdminError = '读取用户列表失败，请稍后重试';
    cloudNotify();
    return { ok: false, message: cloudAdminError };
  });
}

function deleteUser(username) {
  const name = String(username === undefined || username === null ? '' : username).trim();
  if (!name) {
    cloudAdminError = '缺少要删除的用户名';
    cloudNotify();
    return Promise.resolve({ ok: false, message: cloudAdminError });
  }
  if (!cloudIsAdmin()) {
    cloudAdminError = '需要管理员权限';
    cloudNotify();
    return Promise.resolve({ ok: false, message: cloudAdminError });
  }
  return cloudRun(async () => {
    cloudAdminError = '';
    cloudError = '';
    const result = await cloudRequest('POST', '/api/admin/delete', { username: name });
    if (!result.ok) {
      cloudAdminError = result.message || '删除失败，请稍后重试';
      return result;
    }
    const lower = name.toLowerCase();
    cloudAdminUsers = cloudAdminUsers.filter((u) => String(u.username).toLowerCase() !== lower);
    cloudConfirmDelete = '';
    cloudNotice = '已删除用户「' + name + '」';
    return { ok: true };
  });
}

function resetPassword(username, newPassword) {
  const name = String(username === undefined || username === null ? '' : username).trim();
  const pass = String(newPassword === undefined || newPassword === null ? '' : newPassword);
  if (!name) {
    cloudAdminError = '缺少要重置的用户名';
    cloudNotify();
    return Promise.resolve({ ok: false, message: cloudAdminError });
  }
  if (!pass) {
    cloudAdminError = '请先在「重置密码用的新口令」里填写新密码';
    cloudNotify();
    return Promise.resolve({ ok: false, message: cloudAdminError });
  }
  if (!cloudIsAdmin()) {
    cloudAdminError = '需要管理员权限';
    cloudNotify();
    return Promise.resolve({ ok: false, message: cloudAdminError });
  }
  return cloudRun(async () => {
    cloudAdminError = '';
    cloudError = '';
    const result = await cloudRequest('POST', '/api/admin/reset-password', {
      username: name,
      newPassword: pass,
    });
    if (!result.ok) {
      cloudAdminError = result.message || '重置密码失败，请稍后重试';
      return result;
    }
    cloudNotice = '已重置「' + name + '」的密码，该用户需要重新登录';
    return { ok: true };
  });
}

/**
 * 管理员「改数据」：把某个玩家当前的完整存档读下来摊进表单（0.69.0）。
 *
 * 和列表里那份 summary 的区别：summary 只有 4 个数字（对局/胜/表现分/金币），
 * 改数据要连星尘、负平、强化表一起看，所以单独走 /api/admin/save 读全量。
 */
function adminEditOpen(username) {
  const name = String(username === undefined || username === null ? '' : username).trim();
  if (!name) return Promise.resolve({ ok: false, message: '缺少用户名' });
  if (!cloudIsAdmin()) {
    cloudAdminError = '需要管理员权限';
    cloudNotify();
    return Promise.resolve({ ok: false, message: cloudAdminError });
  }
  cloudAdminEdit = {
    username: name,
    loading: true,
    saving: false,
    error: '',
    hint: '',
    rawOpen: false,
    version: 0,
    exists: false,
    forgeCount: 0,
    form: { gold: 0, dust: 0, perf: 0, games: 0, wins: 0, losses: 0, draws: 0 },
    raw: '{}',
  };
  cloudNotify();
  return cloudRequest('GET', '/api/admin/save?username=' + encodeURIComponent(name)).then((result) => {
    // 期间换了人（很快点了另一个「改数据」）就丢掉这次结果
    if (!cloudAdminEdit || cloudAdminEdit.username !== name) return result;
    cloudAdminEdit.loading = false;
    if (!result.ok) {
      cloudAdminEdit.error = result.message || '读取该玩家的存档失败，请稍后重试';
      cloudNotify();
      return result;
    }
    const save = result.data && result.data.save ? result.data.save : null;
    adminEditFill(cloudAdminEdit, save);
    cloudNotify();
    return { ok: true, save };
  }).catch(() => {
    if (cloudAdminEdit && cloudAdminEdit.username === name) {
      cloudAdminEdit.loading = false;
      cloudAdminEdit.error = '读取该玩家的存档失败，请稍后重试';
      cloudNotify();
    }
    return { ok: false, message: '读取失败' };
  });
}

/** 把服务端的一份存档摊进表单（没存档 = 一份空档案的样子） */
function adminEditFill(edit, save) {
  const data = save && save.data && typeof save.data === 'object' ? save.data : {};
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  edit.form = {
    gold: num(data.gold),
    dust: num(data.dust),
    perf: num(data.perf),
    games: num(data.games),
    wins: num(data.wins),
    losses: num(data.losses),
    draws: num(data.draws),
  };
  const cards = data.forge && data.forge.cards && typeof data.forge.cards === 'object' ? data.forge.cards : {};
  edit.forgeCount = Object.keys(cards).length;
  edit.version = save ? Number(save.version) || 0 : 0;
  edit.exists = !!save;
  try { edit.raw = JSON.stringify(data, null, 2); } catch { edit.raw = '{}'; }
}

function adminEditClose() {
  cloudAdminEdit = null;
  cloudNotify();
  return cloudStatus();
}

/** 表单字段落进状态（保存过程中会重绘，先存下来才不会把刚敲的数冲掉） */
function adminEditSetField(field, value) {
  if (!cloudAdminEdit) return null;
  const key = String(field || '');
  if (!Object.prototype.hasOwnProperty.call(cloudAdminEdit.form, key)) return null;
  const n = Math.floor(Number(value));
  cloudAdminEdit.form[key] = Number.isFinite(n) && n > 0 ? n : 0;
  return cloudAdminEdit.form[key];
}

function adminEditToggleRaw(open) {
  if (!cloudAdminEdit) return null;
  cloudAdminEdit.rawOpen = open === undefined ? !cloudAdminEdit.rawOpen : !!open;
  cloudNotify();
  return cloudAdminEdit.rawOpen;
}

/** 把列表里那一行的摘要换成刚写完的（省一次网络往返） */
function adminEditApplySummary(edit, save) {
  if (!edit || !save) return;
  const row = cloudAdminUsers.find((u) => String(u.username).toLowerCase() === edit.username.toLowerCase());
  if (!row) return;
  const s = save.summary && typeof save.summary === 'object' ? save.summary : {};
  row.save = {
    version: Number(save.version) || 0,
    updatedAt: save.updatedAt || '',
    bytes: Number(save.bytes) || 0,
    summary: {
      games: Number(s.games) || 0,
      wins: Number(s.wins) || 0,
      perf: Number(s.perf) || 0,
      gold: Number(s.gold) || 0,
    },
  };
}

/** 保存数值表单：只提交**表单上有的那几个字段**，别的字段服务端原样保留 */
function adminEditSave() {
  const edit = cloudAdminEdit;
  if (!edit) return Promise.resolve({ ok: false, message: '没有在编辑任何用户' });
  if (!cloudIsAdmin()) {
    edit.error = '需要管理员权限';
    cloudNotify();
    return Promise.resolve({ ok: false, message: edit.error });
  }
  if (edit.loading || edit.saving) return Promise.resolve({ ok: false, busy: true });
  const patch = {};
  for (const key of Object.keys(edit.form)) patch[key] = Number(edit.form[key]) || 0;
  return cloudRun(async () => {
    edit.saving = true;
    edit.error = '';
    edit.hint = '';
    cloudNotify();
    const result = await cloudRequest('POST', '/api/admin/save', { username: edit.username, patch });
    edit.saving = false;
    if (!result.ok) {
      edit.error = result.message || '保存失败，请稍后重试';
      cloudNotify();
      return result;
    }
    const save = result.data && result.data.save ? result.data.save : null;
    adminEditFill(edit, save);
    adminEditApplySummary(edit, save);
    edit.hint = '已写入云端 v' + (save ? save.version : edit.version)
      + '。玩家下次同步时选「用云端」即可生效（他那边的本地值会被这份覆盖）。';
    cloudNotice = '已修改「' + edit.username + '」的数据';
    loadAdminLog();
    cloudNotify();
    return { ok: true, save };
  });
}

/** 高级：整份 JSON 替换（客户端先解析，格式错就不发请求） */
function adminEditSaveRaw(text) {
  const edit = cloudAdminEdit;
  if (!edit) return Promise.resolve({ ok: false, message: '没有在编辑任何用户' });
  if (!cloudIsAdmin()) {
    edit.error = '需要管理员权限';
    cloudNotify();
    return Promise.resolve({ ok: false, message: edit.error });
  }
  if (edit.loading || edit.saving) return Promise.resolve({ ok: false, busy: true });
  let data;
  try {
    data = JSON.parse(String(text === undefined || text === null ? '' : text));
  } catch (err) {
    edit.error = 'JSON 格式不对：' + (err && err.message ? err.message : '解析失败');
    cloudNotify();
    return Promise.resolve({ ok: false, message: edit.error });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    edit.error = '最外层必须是一个 JSON 对象（{ … }）';
    cloudNotify();
    return Promise.resolve({ ok: false, message: edit.error });
  }
  return cloudRun(async () => {
    edit.saving = true;
    edit.error = '';
    edit.hint = '';
    cloudNotify();
    const result = await cloudRequest('POST', '/api/admin/save', { username: edit.username, data });
    edit.saving = false;
    if (!result.ok) {
      edit.error = result.message || '保存失败，请稍后重试';
      cloudNotify();
      return result;
    }
    const save = result.data && result.data.save ? result.data.save : null;
    adminEditFill(edit, save);
    adminEditApplySummary(edit, save);
    edit.hint = '整份存档已替换（v' + (save ? save.version : edit.version) + '）。';
    cloudNotice = '已整份替换「' + edit.username + '」的存档';
    loadAdminLog();
    cloudNotify();
    return { ok: true, save };
  });
}

/** 一键清空这个人的全部强化 / 精通（最常用的「重来」） */
function adminEditClearForge() {
  const edit = cloudAdminEdit;
  if (!edit) return Promise.resolve({ ok: false, message: '没有在编辑任何用户' });
  if (!cloudIsAdmin()) {
    edit.error = '需要管理员权限';
    cloudNotify();
    return Promise.resolve({ ok: false, message: edit.error });
  }
  if (edit.loading || edit.saving) return Promise.resolve({ ok: false, busy: true });
  return cloudRun(async () => {
    edit.saving = true;
    edit.error = '';
    edit.hint = '';
    cloudNotify();
    const result = await cloudRequest('POST', '/api/admin/save', {
      username: edit.username,
      patch: { forge: { v: 1, cards: {} } },
    });
    edit.saving = false;
    if (!result.ok) {
      edit.error = result.message || '清空强化失败，请稍后重试';
      cloudNotify();
      return result;
    }
    const save = result.data && result.data.save ? result.data.save : null;
    adminEditFill(edit, save);
    adminEditApplySummary(edit, save);
    edit.hint = '已清空全部强化 / 精通（云端 v' + (save ? save.version : edit.version) + '）。';
    cloudNotice = '已清空「' + edit.username + '」的强化';
    loadAdminLog();
    cloudNotify();
    return { ok: true, save };
  });
}

/**
 * 自检 / 截图用：把「管理员后台」摆成一个确定的样子（不发任何请求）。
 *
 * 门禁的 DOM 桩没有真网络，而管理后台要先「登录成管理员 + 拉到用户列表」才画得出来 ——
 * 真跑一遍会把别的分组的假 fetch 抢掉（已经踩过）。这里直接给状态，确定性更好。
 */
function adminDemo() {
  cloudAuth = { token: 'demo-admin', user: { username: '123', role: 'admin' }, savedAt: Date.now() };
  cloudBusy = false;
  cloudError = '';
  cloudNotice = '';
  cloudAdminError = '';
  cloudAdminLoading = false;
  cloudConfirmDelete = '';
  cloudAdminUsers = [
    {
      username: 'alice', role: 'user',
      createdAt: '2026-10-02T10:00:00.000Z', updatedAt: '', lastLoginAt: '2026-10-22T21:10:00.000Z',
      save: {
        version: 4, updatedAt: '2026-10-22T21:10:00.000Z', bytes: 186,
        summary: { games: 12, wins: 7, perf: 640, gold: 120 },
      },
    },
    {
      username: 'bob', role: 'user',
      createdAt: '2026-10-03T09:00:00.000Z', updatedAt: '', lastLoginAt: '2026-10-20T08:00:00.000Z',
      save: null,
    },
    {
      username: '123', role: 'admin',
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '', lastLoginAt: '2026-10-23T09:00:00.000Z',
      save: null,
    },
  ];
  cloudAdminLog = [{
    at: '2026-10-23T09:12:00.000Z', by: '123', username: 'alice',
    fields: ['gold', 'perf'], version: 4,
  }];
  cloudNotify();
  return cloudStatus();
}

/** 自检用：最后一次真发出去的请求 */
function lastCloudRequest() {
  return cloudLastRequest;
}

/** 自检用：最近的请求（新的在后），用于「找到那条 POST」这类断言 */
function cloudRequests() {
  return cloudRequestLog.slice();
}

/**
 * 把「改数据」面板直接摆成某一份存档的样子（不发请求）。
 * 自检与截图用：DOM 桩里没有真网络，靠它才能把每个分支（读到 / 已写入 / 出错 / JSON）
 * 都渲染出来看一遍。
 */
function adminEditShow(username, save) {
  const name = String(username || '').trim();
  if (!name) return null;
  cloudAdminEdit = {
    username: name,
    loading: false,
    saving: false,
    error: '',
    hint: '',
    rawOpen: false,
    version: 0,
    exists: false,
    forgeCount: 0,
    form: { gold: 0, dust: 0, perf: 0, games: 0, wins: 0, losses: 0, draws: 0 },
    raw: '{}',
  };
  adminEditFill(cloudAdminEdit, save || null);
  cloudNotify();
  return cloudAdminEdit;
}

/** 自检用：直接把面板改到某个状态（出错 / 已写入 / 展开 JSON…） */
function adminEditPatchState(patch) {
  if (!cloudAdminEdit) return null;
  Object.assign(cloudAdminEdit, patch && typeof patch === 'object' ? patch : {});
  cloudNotify();
  return cloudAdminEdit;
}

/** 读最近的管理操作（归档在服务端 meta:adminlog，最多 20 条） */
function loadAdminLog() {
  if (!cloudIsAdmin()) return Promise.resolve({ ok: false });
  return cloudRequest('GET', '/api/admin/log').then((result) => {
    if (result.ok) {
      const list = result.data && Array.isArray(result.data.log) ? result.data.log : [];
      cloudAdminLog = list.filter((e) => e && typeof e === 'object').slice(0, 20);
      cloudNotify();
      return { ok: true, log: cloudAdminLog };
    }
    return result;
  }).catch(() => ({ ok: false }));
}

/** 删除按钮的两步确认（第一次点进确认态，不直接删） */
function setConfirmDelete(username) {
  cloudConfirmDelete = username ? String(username) : '';
  cloudNotify();
  return cloudStatus();
}

export {
  init, login, register, logout, changePassword,
  pushLocal, pullRemote, useLocal, useCloud,
  loadAdminUsers, deleteUser, resetPassword, setConfirmDelete,
  // 改玩家数据（0.69.0）
  adminEditOpen, adminEditClose, adminEditSetField, adminEditToggleRaw,
  adminEditSave, adminEditSaveRaw, adminEditClearForge, loadAdminLog,
  adminEditShow, adminEditPatchState, lastCloudRequest, cloudRequests, adminDemo,
  cloudStatus,
};
