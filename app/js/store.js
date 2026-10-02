/**
 * 本地存档层。
 *
 * 为什么要单独包一层：
 *  1. Android WebView 从 `file://` 加载时，localStorage 未必可用
 *     （虽然 MainActivity 已经开了 setDomStorageEnabled，但不同设备/权限下仍可能抛异常）；
 *  2. `tools/check-bundle.mjs` 的 DOM stub 里**根本没有 localStorage**，
 *     直接调用会让构建门禁挂掉。
 *
 * 所以每一次读写都必须兜在 try/catch 里，失败就退化到**内存存储**：
 * 顶多是「关掉游戏后进度丢失」，绝不能让存档问题把游戏搞崩。
 */

const MEMORY = new Map();
let mode = null; // 'local' | 'memory'

/** 探测可用的存储后端（结果缓存，只探一次） */
function detect() {
  if (mode !== null) return mode;
  try {
    const ls = globalThis.localStorage;
    if (ls) {
      const probe = '__kapai_probe__';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      mode = 'local';
      return mode;
    }
  } catch {
    // 访问 localStorage 本身就抛异常（隐私模式 / 沙箱 / 非浏览器环境）
  }
  mode = 'memory';
  return mode;
}

/** 'local' = 真的存下来了；'memory' = 只在本次运行有效 */
export function storageMode() {
  return detect();
}

export function readJSON(key, fallback) {
  try {
    const raw = detect() === 'local' ? globalThis.localStorage.getItem(key) : MEMORY.get(key);
    if (raw === null || raw === undefined) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** 返回是否写入成功（配额满会返回 false，调用方可以据此提示用户） */
export function writeJSON(key, value) {
  let raw;
  try {
    raw = JSON.stringify(value);
  } catch {
    return false;
  }
  if (typeof raw !== 'string') return false;

  if (detect() === 'local') {
    try {
      globalThis.localStorage.setItem(key, raw);
      return true;
    } catch {
      return false; // 配额满 / 被拒绝
    }
  }
  MEMORY.set(key, raw);
  return true;
}

export function removeKey(key) {
  if (detect() === 'local') {
    try { globalThis.localStorage.removeItem(key); } catch { /* 忽略 */ }
  } else {
    MEMORY.delete(key);
  }
}

/** 粗略估算某个 key 占了多少字节（UTF-16 按 2 字节算，中文够准） */
export function bytesOf(key) {
  try {
    const raw = detect() === 'local' ? globalThis.localStorage.getItem(key) : MEMORY.get(key);
    return raw ? raw.length * 2 : 0;
  } catch {
    return 0;
  }
}

// ══════════════════════════════════════════════════════════
// 玩家存档（金币 / 等级 / 战绩）
// ══════════════════════════════════════════════════════════

const PROFILE_KEY = 'kapai.profile.v1';

/**
 * 原生存档通道（Android）。
 *
 * ⚠️ 为什么玩家档案**必须**走它，而不是 localStorage：
 *   WebView 的 localStorage 按**来源**隔离。首页来自 `file://`，
 *   而联机页来自 `http://主机:8765` —— 两个来源 = 两份存档。
 *   症状：一进联机就变成「0 金币、1 级」的新账号，联机里赚的金币也回不到主存档，
 *   于是「联机影响本地金币」这条规则根本无从谈起。
 *   SharedPreferences 是进程级的，与来源无关，两边读到的是同一份。
 *
 * 桌面（浏览器 / 测试）没有这个桥，自动退回 localStorage，不影响开发与门禁。
 */
function nativeStore() {
  try {
    const b = globalThis.KapaiNative;
    if (!b || typeof b.readProfile !== 'function') return null;
    return b;
  } catch {
    return null;
  }
}

export function defaultProfile() {
  return {
    v: 1,
    gold: 0,
    lifetimeGold: 0, // 累计获得过的金币（花掉也会保留），等级按它算
    games: 0,
    wins: 0,
    losses: 0,
    draws: 0,
  };
}

export function loadProfile() {
  // 优先走原生存档：联机页与首页必须读到同一份
  const ns = nativeStore();
  if (ns) {
    try {
      const raw = String(ns.readProfile() || '');
      if (!raw) return null;              // 空 = 还没有档案（首次进游戏）
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        ...defaultProfile(), ...parsed,
        gold: Number(parsed.gold) || 0,
        lifetimeGold: Number(parsed.lifetimeGold) || 0,
      };
    } catch {
      // 原生读失败（数据坏了 / 桥异常）：退回 localStorage，别让存档问题挡开局
    }
  }
  const raw = readJSON(PROFILE_KEY, null);
  if (!raw || typeof raw !== 'object') return null; // null = 还没有档案
  return { ...defaultProfile(), ...raw, gold: Number(raw.gold) || 0, lifetimeGold: Number(raw.lifetimeGold) || 0 };
}

export function saveProfile(profile) {
  const ns = nativeStore();
  if (ns) {
    try {
      if (String(ns.writeProfile(JSON.stringify(profile))) === 'true') return true;
    } catch { /* 落到 localStorage */ }
  }
  return writeJSON(PROFILE_KEY, profile);
}

export function clearProfile() {
  removeKey(PROFILE_KEY);
}

// ══════════════════════════════════════════════════════════
// 回放档案
// ══════════════════════════════════════════════════════════

const REPLAY_KEY = 'kapai.replays.v1';

export function loadReplays() {
  const list = readJSON(REPLAY_KEY, []);
  return Array.isArray(list) ? list : [];
}

export function saveReplays(list) {
  return writeJSON(REPLAY_KEY, list);
}

export function replaysBytes() {
  return bytesOf(REPLAY_KEY);
}

// ══════════════════════════════════════════════════════════
// 设置
// ══════════════════════════════════════════════════════════

const SETTINGS_KEY = 'kapai.settings.v1';

export function defaultSettings() {
  return { v: 1, theme: 'dark' };
}

export function loadSettings() {
  return { ...defaultSettings(), ...readJSON(SETTINGS_KEY, {}) };
}

export function saveSettings(settings) {
  return writeJSON(SETTINGS_KEY, settings);
}

/** 给测试用：清掉所有本地数据（内存后端也清） */
export function __resetAll() {
  for (const k of [PROFILE_KEY, REPLAY_KEY, SETTINGS_KEY]) removeKey(k);
  MEMORY.clear();
}
