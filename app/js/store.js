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

import { capGold } from './economy.js';

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

function readJSON(key, fallback) {
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
function writeJSON(key, value) {
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

/** 粗略估算某个 key 占了多少字节（UTF-16 按 2 字节算，中文够准） */
function bytesOf(key) {
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
 * 原生存档桥（Android 端用 SharedPreferences，经 `KapaiNative` 暴露）。
 *
 * ⚠️ 为什么玩家档案与回放**都必须**走它，而不是 localStorage：
 *   WebView 的 localStorage 按**来源**隔离。首页来自 `file://`，
 *   而联机页来自 `http://主机:8765` —— 两个来源 = 两份存档。
 *   症状：一进联机就变成「0 金币、1 级」的新账号，联机里赚的金币回不到主存档；
 *   回放同理（联机页打完的那局，在首页的「回放对局」里是空的）。
 *   SharedPreferences 是进程级的、与来源无关，两边读到的是同一份。
 *
 * 桌面（浏览器 / 门禁 / 测试）没有这个桥 —— `required` 里的方法不全就返回 null，
 * 调用方自动退回 localStorage / 内存，不影响开发与门禁。
 */
function nativeBridge(...required) {
  try {
    const b = globalThis.KapaiNative;
    if (!b || required.some((m) => typeof b[m] !== 'function')) return null;
    return b;
  } catch {
    return null;
  }
}

export function defaultProfile() {
  return {
    v: 2,
    gold: 0,
    dust: 0,        // 星尘：精通卡牌用的材料
    perf: 0,        // 表现分：等级的**唯一**依据（2026-10 起不再看金币）
    lifetimeGold: 0, // 仅存档兼容（旧版升级曲线用），新代码不要再读它
    games: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    /**
     * 强化工坊的卡牌进度。
     *   { v:1, cards: { [cardId]: { lvl:0..9, masteries:['w_atk', ...] } } }
     * lvl        = 当前累计的强化次数（精通会清零）
     * masteries  = 已经挂上的技能 id，最多 2 个（锦囊则是「减费次数」）
     */
    forge: { v: 1, cards: {} },
  };
}

/** 把任意来源的档案补齐成当前版本；旧档案的等级按累计金币迁移到表现分。 */
export function normalizeProfile(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const base = defaultProfile();
  const perfRaw = Number(raw.perf);
  const perf = Number.isFinite(perfRaw) && raw.perf !== undefined && raw.perf !== null
    ? perfRaw
    : (Number(raw.lifetimeGold) || 0);

  const cards = {};
  const srcCards = raw.forge && raw.forge.cards && typeof raw.forge.cards === 'object' ? raw.forge.cards : {};
  for (const [id, rec] of Object.entries(srcCards)) {
    if (!rec || typeof rec !== 'object') continue;
    const lvl = Math.max(0, Math.min(9, Math.floor(Number(rec.lvl) || 0)));
    const masteries = Array.isArray(rec.masteries)
      ? rec.masteries.filter((s) => typeof s === 'string').slice(0, 2)
      : [];
    if (lvl === 0 && masteries.length === 0) continue;
    cards[id] = { lvl, masteries };
  }

  const capped = capGold(raw.gold, raw.dust);
  return {
    ...base,
    ...raw,
    v: base.v,
    gold: capped.gold,
    dust: capped.dust,
    perf: Math.max(0, perf),
    lifetimeGold: Number(raw.lifetimeGold) || 0,
    games: Number(raw.games) || 0,
    wins: Number(raw.wins) || 0,
    losses: Number(raw.losses) || 0,
    draws: Number(raw.draws) || 0,
    forge: { v: 1, cards },
  };
}

export function loadProfile() {
  // 优先走原生存档：联机页与首页必须读到同一份
  const ns = nativeBridge('readProfile');
  if (ns) {
    try {
      const raw = String(ns.readProfile() || '');
      if (!raw) return null;              // 空 = 还没有档案（首次进游戏）
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return normalizeProfile(parsed);
    } catch {
      // 原生读失败（数据坏了 / 桥异常）：退回 localStorage，别让存档问题挡开局
    }
  }
  const raw = readJSON(PROFILE_KEY, null);
  if (!raw || typeof raw !== 'object') return null; // null = 还没有档案
  return normalizeProfile(raw);
}

export function saveProfile(profile) {
  const ns = nativeBridge('readProfile', 'writeProfile');
  if (ns) {
    try {
      if (String(ns.writeProfile(JSON.stringify(profile))) === 'true') return true;
    } catch { /* 落到 localStorage */ }
  }
  return writeJSON(PROFILE_KEY, profile);
}

// ══════════════════════════════════════════════════════════
// 回放档案
// ══════════════════════════════════════════════════════════

const REPLAY_KEY = 'kapai.replays.v1';

export function loadReplays() {
  const ns = nativeBridge('readReplays', 'writeReplays');
  if (ns) {
    try {
      const raw = String(ns.readReplays() || '');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
      // 原生这边还是空的：把旧版本存在 localStorage 里的那几局搬过来。
      // （只有同一个来源内读得到，所以这是「尽量不丢」，不是万无一失。）
      const legacy = readJSON(REPLAY_KEY, []);
      const list = Array.isArray(legacy) ? legacy : [];
      if (list.length) {
        try { ns.writeReplays(JSON.stringify(list)); } catch { /* 搬不动就算了 */ }
      }
      return list;
    } catch {
      // 桥异常（数据坏了 / 读取被拒）：退回本地存储，别让存档挡住开局
    }
  }
  const list = readJSON(REPLAY_KEY, []);
  return Array.isArray(list) ? list : [];
}

/** 返回是否写入成功（原生拒绝 / 配额满都返回 false，调用方会丢旧的一半再试） */
export function saveReplays(list) {
  const ns = nativeBridge('readReplays', 'writeReplays');
  if (ns) {
    try {
      if (String(ns.writeReplays(JSON.stringify(list))) === 'true') return true;
      // 有原生通道时不要再往 localStorage 里塞一份影子存档，
      // 否则下次读的是原生那份，本地这份会变成永远更新不到的垃圾。
      return false;
    } catch { /* 桥异常，退回本地存储 */ }
  }
  return writeJSON(REPLAY_KEY, list);
}

export function replaysBytes() {
  const ns = nativeBridge('readReplays', 'writeReplays');
  if (ns) {
    try { return String(ns.readReplays() || '').length * 2; } catch { /* 退回本地估算 */ }
  }
  return bytesOf(REPLAY_KEY);
}

// ══════════════════════════════════════════════════════════
// 设置
// ══════════════════════════════════════════════════════════

const SETTINGS_KEY = 'kapai.settings.v1';

function defaultSettings() {
  return { v: 1, theme: 'dark' };
}

export function loadSettings() {
  return { ...defaultSettings(), ...readJSON(SETTINGS_KEY, {}) };
}

export function saveSettings(settings) {
  return writeJSON(SETTINGS_KEY, settings);
}
