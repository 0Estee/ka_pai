/**
 * 强化 / 精通：卡牌成长系统的**全部数值与规则**（纯函数，不碰 DOM）。
 *
 * ── 给作者的一页话 ──────────────────────────────────────
 *  强化：花金币，把一张牌练 9 次。单位每次 +0.1 攻 +0.1 血，第 9 次 +0.2
 *        （九次合计 +1.0/+1.0）；锦囊前 9 次**不加数值**，只是攒「精通的资格」。
 *  精通：练满 9 次后可以「精通」，消耗这些强化换一个永久收益：
 *        · 单位：从 3 个随机技能里选 1 个挂上（攻/血回到基础值，白赚技能）
 *        · 锦囊：费用 −1（原费 ≤2 的只 −0.25），最多 2 次
 *        每张牌最多精通 2 次；洗掉只撤掉**最近一次**精通，强化次数不退还，
 *        要重新练 9 次才能再精通。
 *  技能：白 / 绿 / 橙 / 紫 / 彩 五档，档位权重 50 / 30 / 15 / 4.5 / 0.5，三选一。
 *        （作者 2026-10-24 改版：旧 16 个技能全部作废，改用新表。）
 *
 * ── 存档形状（profile.forge）────────────────────────────
 *   { v:1, cards: { [cardId]: { lvl:0..9, masteries:['w_atk', ...] } } }
 *   lvl       当前累计强化次数（精通后清零）
 *   masteries 已挂上的技能 id（锦囊则只记次数，技能表不参与）
 *
 * ── 和引擎的接口 ────────────────────────────────────────
 *   buildSideEnhance(cardLib, profile) → { [cardId]: {atk,hp,cost,kw} }
 *   这个增量表在开局时交给引擎（state.enhance[side]），
 *   引擎只在「单位落地」和「算手牌费用」两处读它。
 */

import { initialOf } from './pinyin.js';

/** 一张牌最多强化到第几次 */
export const ENHANCE_MAX = 9;
/** 一张牌最多精通几次 */
export const MASTERY_MAX = 2;
/** 前 8 次的单次增量 */
export const ENHANCE_STEP = 0.1;
/** 第 9 次的单次增量 */
export const ENHANCE_LAST_STEP = 0.2;

/**
 * 强化一次的金币价：12,16,20,…,44（九次合计 252）。
 * 用「当前等级」计价，所以第 9 次最贵。
 */
export function enhanceGoldCost(lvl) {
  const n = Math.max(0, Math.min(ENHANCE_MAX - 1, Math.floor(Number(lvl) || 0)));
  return 12 + 4 * n;
}

/** 第 n 次精通（n = 已精通次数）要花的星尘：20、40 */
export function masteryDustCost(used) {
  return 20 * (Math.min(MASTERY_MAX - 1, Math.max(0, Math.floor(Number(used) || 0))) + 1);
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

/** 强化 lvl 次累计加多少攻/血（单位卡）。 */
export function enhanceValue(lvl) {
  const n = Math.max(0, Math.min(ENHANCE_MAX, Math.floor(Number(lvl) || 0)));
  let v = 0;
  for (let i = 1; i <= n; i++) v += i === ENHANCE_MAX ? ENHANCE_LAST_STEP : ENHANCE_STEP;
  return round1(v);
}

// ══════════════════════════════════════════════════════════
// 技能表
// ══════════════════════════════════════════════════════════

/**
 * 五档稀有度（作者 2026-10-24 改版）：抽取权重依次降低，效果依次增强。
 * 权重是**档位**的权重，同档内每个技能等概率。
 */
export const RARITY = {
  white: { key: 'white', name: '白', label: '普通', weight: 50, color: '#c9d1dc' },
  green: { key: 'green', name: '绿', label: '优秀', weight: 30, color: '#5fd39a' },
  orange: { key: 'orange', name: '橙', label: '稀有', weight: 15, color: '#e8a34a' },
  purple: { key: 'purple', name: '紫', label: '史诗', weight: 4.5, color: '#b082ff' },
  rainbow: { key: 'rainbow', name: '彩', label: '传说', weight: 0.5, color: '#ff6fb5' },
};

/**
 * 技能池。atk/hp 是直接加在单位实例上的数值；
 * kw 是词条（走引擎的 KEYWORD_DEFS，x 为参数）。
 * 只有单位卡能挂技能 —— 锦囊精通走减费，不抽技能。
 */
export const SKILLS = [
  // ── 白（档位权重 50）────────────────────────────────────
  { id: 'w_temper', rarity: 'white', name: '淬身', text: '+1 攻击 +1 生命', atk: 1, hp: 1 },
  { id: 'w_fury', rarity: 'white', name: '狂暴', text: '暴击 2', kw: [{ id: 'crit', x: 2 }] },
  { id: 'w_precise', rarity: 'white', name: '精准', text: '若有暴击效果，则必定触发', flags: { critAlways: true } },
  { id: 'w_tough', rarity: 'white', name: '强体', text: '+2.4 生命', hp: 2.4 },
  { id: 'w_venom', rarity: 'white', name: '恶毒', text: '淬毒 1', kw: [{ id: 'poison', x: 1 }] },
  { id: 'w_holy', rarity: 'white', name: '圣光', text: '祝福 3', kw: [{ id: 'blessing', x: 3 }] },

  // ── 绿（档位权重 30）────────────────────────────────────
  {
    id: 'g_plenty', rarity: 'green', name: '富足', text: '打出:抽一张牌',
    fx: [{ trigger: 'onPlay', actions: [{ op: 'draw', amount: 1 }] }],
  },
  {
    id: 'g_bloodthirst', rarity: 'green', name: '嗜血', text: '造成伤害:友方国王回复 1.5 生命',
    fx: [{ trigger: 'onDealDamage', actions: [{ op: 'heal', amount: 1.5, target: { kind: 'ownKing' } }] }],
  },
  { id: 'g_evolve', rarity: 'green', name: '进化', text: '两栖，+1 生命', hp: 1, kw: [{ id: 'amphibious', x: 0 }] },
  {
    id: 'g_unyielding', rarity: 'green', name: '不屈', text: '装甲 1，受到的来自锦囊的伤害 -1',
    kw: [{ id: 'armor', x: 1 }], flags: { spellDamageReduce: 1 },
  },
  {
    id: 'g_twist', rarity: 'green', name: '扭曲', text: '+1 攻击 +1 生命，交换攻击数值和生命数值',
    atk: 1, hp: 1, flags: { swapStats: true },
  },
  {
    id: 'g_brutal', rarity: 'green', name: '残暴', text: '暴击 3，暴击触发概率设为 65%',
    kw: [{ id: 'crit', x: 3 }], flags: { critChance: 0.65 },
  },

  // ── 橙（档位权重 15）────────────────────────────────────
  { id: 'o_stealth', rarity: 'orange', name: '隐蔽', text: '锦囊免疫', kw: [{ id: 'spellImmune', x: 0 }] },
  { id: 'o_teamwork', rarity: 'orange', name: '协作', text: '减少等同于场上队友数的费用', flags: { costPerAlly: 1 } },
  {
    id: 'o_sacred', rarity: 'orange', name: '圣洁', text: '祝福 2。在场:友方国王获祝福 2',
    kw: [{ id: 'blessing', x: 2 }], kingAura: { blessing: 2 },
  },
  {
    id: 'o_arcane', rarity: 'orange', name: '奥义',
    text: '回合开始:若回合数≥4，随机对两名敌人造成 3 点伤害，对敌方国王造成 2 点伤害',
    fx: [{
      trigger: 'onTurnStart',
      when: { turnAtLeast: 4 },
      actions: [
        { op: 'damage', amount: 3, target: { kind: 'randomEnemyUnits', count: 2 } },
        { op: 'damage', amount: 2, target: { kind: 'enemyKing' } },
      ],
    }],
  },
  {
    id: 'o_almighty', rarity: 'orange', name: '全能',
    text: '随机获得[穿透1][疾病][暴击1][祝福3][溅射1]中的两个，增加等同于词条数的攻击',
    expand: 'almighty',
  },

  // ── 紫（档位权重 4.5）───────────────────────────────────
  {
    id: 'p_eternal', rarity: 'purple', name: '永恒',
    text: '-2 攻击。开战回合:获得无敌。锦囊牌回合:获得锦囊免疫',
    atk: -2,
    fx: [
      { trigger: 'onCombatStart', actions: [{ op: 'grantKeyword', keyword: 'invincible', untilTurnEnd: true }] },
      { trigger: 'onEnemyCastSpell', actions: [{ op: 'grantKeyword', keyword: 'spellImmune', untilTurnEnd: true }] },
    ],
  },
  {
    id: 'p_combo', rarity: 'purple', name: '连击',
    text: '-1 攻击，双重打击。[双重打击]触发后，若本回合友方打出过 2 张锦囊，额外攻击一次',
    atk: -1, kw: [{ id: 'doubleStrike', x: 0 }], flags: { comboStrike: true },
  },
  {
    id: 'p_undying', rarity: 'purple', name: '不灭', text: '装甲 2。在场:友方国王生命至少为 1',
    kw: [{ id: 'armor', x: 2 }], kingAura: { hpFloor: 1 },
  },
  {
    id: 'p_focus', rarity: 'purple', name: '会心',
    text: '穿透 2。若回合数≥9，获得暴击 20。暴击触发概率设为 10%',
    kw: [{ id: 'pierce', x: 2 }], flags: { critChance: 0.1, critAfterTurn: { turn: 9, x: 20 } },
  },
  {
    id: 'p_devour', rarity: 'purple', name: '吞噬', text: '打出:消灭一名敌人',
    fx: [{ trigger: 'onPlay', actions: [{ op: 'destroy', reason: '吞噬', target: { kind: 'lowestHpEnemyUnit' } }] }],
  },
  {
    id: 'p_trick', rarity: 'purple', name: '戏法', text: '打出:把所有敌人变为兔子',
    fx: [{ trigger: 'onPlay', actions: [{ op: 'transform', cardId: 'U329', target: { kind: 'allEnemyUnits' } }] }],
  },
  {
    id: 'p_clone', rarity: 'purple', name: '复制', text: '打出:在场上召唤本单位的同名卡牌',
    fx: [{ trigger: 'onPlay', actions: [{ op: 'summonSelf' }] }],
  },
  {
    id: 'p_universal', rarity: 'purple', name: '兼爱',
    text: '开战回合开始前，双方国王和所有单位回复 10 点生命',
    fx: [{
      trigger: 'onCombatStart',
      oncePerTurn: true,
      actions: [
        { op: 'heal', amount: 10, target: { kind: 'allUnits' } },
        { op: 'heal', amount: 10, target: { kind: 'ownKing' } },
        { op: 'heal', amount: 10, target: { kind: 'enemyKing' } },
      ],
    }],
  },

  // ── 彩（档位权重 0.5）───────────────────────────────────
  {
    id: 'u_annihilate', rarity: 'rainbow', name: '湮灭',
    text: '打出:弃置敌方手中的单位牌，消灭所有敌人',
    fx: [{
      trigger: 'onPlay',
      actions: [
        { op: 'discardHandUnits', target: { kind: 'opponentHand' } },
        { op: 'destroy', reason: '湮灭', target: { kind: 'allEnemyUnits' } },
      ],
    }],
  },
  {
    id: 'u_heatDeath', rarity: 'rainbow', name: '热寂', text: '打出:若回合数≥12，消灭敌方国王',
    fx: [{
      trigger: 'onPlay',
      actions: [{
        op: 'conditional', if: { turnAtLeast: 12 },
        then: [{ op: 'destroy', allowKing: true, reason: '热寂', target: { kind: 'enemyKing' } }],
      }],
    }],
  },
  {
    id: 'u_endless', rarity: 'rainbow', name: '无尽', text: '打出:若友方国王生命为 1，将友方国王生命设为 99',
    fx: [{
      trigger: 'onPlay',
      actions: [{
        op: 'conditional', if: { ownKingHpAtMost: 1 },
        then: [{ op: 'setKingHp', amount: 99, target: { kind: 'ownKing' } }],
      }],
    }],
  },
];

export const SKILL_BY_ID = Object.fromEntries(SKILLS.map((s) => [s.id, s]));

/**
 * 「全能」的随机池（作者 2026-10-24）：随机拿其中两个，攻击力再涨拿到几个。
 * 抽取必须**可复现**（联机锁步 / 回放 / 云存档），所以不用 Math.random，
 * 而是对 cardId 做 FNV-1a 散列取分数 —— 同一张牌永远拿同样的两个词条。
 */
const ALMIGHTY_POOL = [
  { id: 'pierce', x: 1 },
  { id: 'disease', x: 0 },
  { id: 'crit', x: 1 },
  { id: 'blessing', x: 3 },
  { id: 'splash', x: 1 },
];

/** 把「全能」展开成两个词条 + 攻击加成（返回 {kw:[], atk}） */
function expandAlmighty(cardId) {
  const pool = ALMIGHTY_POOL.slice();
  const picked = [];
  const h = hash32('almighty:' + String(cardId || ''));
  for (let i = 0; i < 2 && pool.length > 0; i++) {
    const idx = Math.floor(frac(h, i) * pool.length) % pool.length;
    picked.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return { kw: picked, atk: picked.length };
}

/** 刷新三选一的花费（星尘）。作者 2026-10-24：再想想不再重抽，重抽要花星尘。 */
export const REFRESH_DUST_COST = 10;

/** 刷新一次三选一（locked 里的技能 id 保留不动，其余重抽） */
export function redrawSkills(current, lockedIds, rand = Math.random, n = 3) {
  const locked = (current || []).filter((s) => (lockedIds || []).indexOf(s.id) >= 0);
  const need = Math.max(0, n - locked.length);
  const rest = drawSkills(rand, need + locked.length).filter(
    (s) => (lockedIds || []).indexOf(s.id) < 0 && !locked.some((l) => l.id === s.id),
  );
  return locked.concat(rest.slice(0, need));
}

/** 从给定池子里按稀有度权重抽一个下标（r ∈ [0,1)） */
function pickWeighted(pool, r) {
  const total = pool.reduce((sum, s) => sum + RARITY[s.rarity].weight, 0);
  let hit = Math.max(0, Math.min(0.999999, Number(r) || 0)) * total;
  for (let i = 0; i < pool.length; i++) {
    hit -= RARITY[pool[i].rarity].weight;
    if (hit < 0) return i;
  }
  return pool.length - 1;
}

/**
 * 抽 n 个**不重复**的技能。
 * @param {function():number} rand 0..1 的随机源（默认 Math.random）
 * @returns {object[]} 技能定义数组
 */
export function drawSkills(rand = Math.random, n = 3) {
  const pool = SKILLS.slice();
  const out = [];
  const count = Math.max(0, Math.min(n, pool.length));
  for (let i = 0; i < count; i++) {
    // 每次都从**剩下的**技能里按权重抽：稀有技能被抽走后，剩余池的权重总和同步变小
    const idx = pickWeighted(pool, rand());
    out.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return out;
}

// ══════════════════════════════════════════════════════════
// 档案读写
// ══════════════════════════════════════════════════════════

const EMPTY_REC = { lvl: 0, masteries: [] };

/** 取一张牌的强化记录（没有就返回零记录常量，不要改它） */
export function recordFor(profile, cardId) {
  const cards = profile && profile.forge && profile.forge.cards;
  const rec = cards && cards[cardId];
  return rec && typeof rec === 'object' ? rec : EMPTY_REC;
}

/** 复制一份档案 + 卡牌记录，供纯函数式改写 */
function withRecord(profile, cardId, rec) {
  const base = profile || {};
  const forge = base.forge && base.forge.cards ? base.forge : { v: 1, cards: {} };
  const cards = { ...forge.cards };
  if (rec.lvl === 0 && (!rec.masteries || rec.masteries.length === 0)) delete cards[cardId];
  else cards[cardId] = rec;
  return { ...base, forge: { v: 1, cards } };
}

function isSpell(def) {
  return !!def && def.type === 'spell';
}

/**
 * 这张牌能不能进强化工坊（令牌、阵营专属牌、白板测试卡都不进）。
 *
 * `legacy` 标记见 engine/cards/test-cards.js 的 DEMO_CARDS：
 * 那些 W01/K04/E01 是引擎自检用的白板，作者 2026-10-18 要求从玩家可见处清干净。
 */
export function isForgeable(def) {
  return !!def && !!def.id && !def.token && !def.faction && !def.legacy;
}

/**
 * 卡牌在**当前强化状态**下的实际数值（给界面显示、AI 估值、AI 的强化表用）。
 *
 * 单位：攻/血 = 卡面 + 强化累计 + 技能加成；cost 不变
 * 锦囊：cost = 卡面 − 精通次数 ×（原费 ≤2 时 0.25，否则 1）；没有攻/血
 *
 * 除了数值，还会把技能带来的三类**机制**原样带出来（作者 2026-10-24 五档技能表）：
 *   keywords  走引擎的 KEYWORD_DEFS（暴击 / 装甲 / 祝福…）
 *   fx        触发式异能（打出:抽一张、造成伤害:回血…），直接挂到单位身上
 *   flags     单位级的开关（暴击概率 / 攻血交换 / 锦囊减伤…）
 *   kingAura  「在场时给友方国王的被动」（祝福上限 / 生命下限）
 *   expand    「全能」这种随机展开成词条 + 攻击的，在这里就地展开
 */
export function statsFor(def, rec) {
  const r = rec || EMPTY_REC;
  const masteries = Array.isArray(r.masteries) ? r.masteries : [];
  if (isSpell(def)) {
    const baseCost = Number(def.cost) || 0;
    const per = baseCost <= 2 ? 0.25 : 1;
    return {
      atk: null,
      hp: null,
      cost: round2(Math.max(0, baseCost - masteries.length * per)),
      keywords: [], fx: [], flags: {}, kingAura: null,
      masteries: masteries.length,
      lvl: Number(r.lvl) || 0,
    };
  }
  const add = enhanceValue(r.lvl);
  let atk = (Number(def.atk) || 0) + add;
  let hp = (Number(def.hp) || 0) + add;
  const keywords = [];
  const fx = [];
  const flags = {};
  let kingAura = null;
  for (const id of masteries) {
    const s = SKILL_BY_ID[id];
    if (!s) continue;
    atk += s.atk || 0;
    hp += s.hp || 0;
    for (const k of s.kw || []) keywords.push({ id: k.id, x: k.x });
    for (const e of s.fx || []) fx.push(e);
    if (s.flags) Object.assign(flags, s.flags);
    if (s.kingAura) kingAura = Object.assign(kingAura || {}, s.kingAura);
    // 「全能」：随机两个词条 + 攻击加成（同一张牌永远展开成同样的结果）
    if (s.expand === 'almighty') {
      const ex = expandAlmighty(def && def.id);
      atk += ex.atk;
      for (const k of ex.kw) keywords.push({ id: k.id, x: k.x });
    }
  }
  return {
    atk: round1(atk),
    hp: round1(hp),
    cost: Number(def.cost) || 0,
    keywords, fx, flags, kingAura,
    masteries: masteries.length,
    lvl: Number(r.lvl) || 0,
  };
}

/** 数值显示：整数不带小数点，0.5 这种保留一位 */
export function fmtNum(v) {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// ══════════════════════════════════════════════════════════
// 三个动作：强化 / 精通 / 洗掉
// ══════════════════════════════════════════════════════════

/** 能不能强化一次 */
export function canEnhance(profile, def, cardId) {
  if (!isForgeable(def)) return { ok: false, reason: '这张牌不能强化' };
  const rec = recordFor(profile, cardId);
  if (rec.lvl >= ENHANCE_MAX) {
    return { ok: false, reason: isSpell(def) ? '已经练满，去精通它' : '已经练满，去精通或洗掉' };
  }
  const cost = enhanceGoldCost(rec.lvl);
  if ((Number(profile && profile.gold) || 0) < cost) {
    return { ok: false, reason: `金币不足（需要 ${cost}）`, cost };
  }
  return { ok: true, cost };
}

/** 花金币强化一次。返回 {ok, profile?, cost?, reason?} */
export function applyEnhance(profile, def, cardId) {
  const gate = canEnhance(profile, def, cardId);
  if (!gate.ok) return gate;
  const rec = recordFor(profile, cardId);
  const next = withRecord(profile, cardId, { lvl: rec.lvl + 1, masteries: rec.masteries.slice() });
  next.gold = (Number(profile.gold) || 0) - gate.cost;
  return { ok: true, profile: next, cost: gate.cost, lvl: rec.lvl + 1 };
}

/** 能不能精通（练满 + 次数没到 + 星尘够） */
export function canMaster(profile, def, cardId) {
  if (!isForgeable(def)) return { ok: false, reason: '这张牌不能精通' };
  const rec = recordFor(profile, cardId);
  if (rec.masteries.length >= MASTERY_MAX) return { ok: false, reason: `已经精通 ${MASTERY_MAX} 次（上限）` };
  if (rec.lvl < ENHANCE_MAX) return { ok: false, reason: `还要强化 ${ENHANCE_MAX - rec.lvl} 次` };
  const cost = masteryDustCost(rec.masteries.length);
  if ((Number(profile && profile.dust) || 0) < cost) {
    return { ok: false, reason: `星尘不足（需要 ${cost}）`, cost };
  }
  return { ok: true, cost };
}

/**
 * 精通。单位必须带 skillId（三选一的结果）；锦囊忽略 skillId。
 * 单位的强化累计清零（换技能），锦囊的也清零（换减费）。
 */
export function applyMastery(profile, def, cardId, skillId) {
  const gate = canMaster(profile, def, cardId);
  if (!gate.ok) return gate;
  const rec = recordFor(profile, cardId);
  const masteries = rec.masteries.slice();
  if (isSpell(def)) {
    masteries.push('spell_cost');
  } else {
    const skill = SKILL_BY_ID[skillId];
    if (!skill) return { ok: false, reason: '没有选择技能' };
    if (masteries.includes(skillId)) return { ok: false, reason: '这个技能已经挂过了' };
    masteries.push(skillId);
  }
  const next = withRecord(profile, cardId, { lvl: 0, masteries });
  next.dust = Math.max(0, (Number(profile.dust) || 0) - gate.cost);
  return { ok: true, profile: next, cost: gate.cost, skillId: isSpell(def) ? null : skillId };
}

/** 能不能洗掉最近一次精通 */
export function canWash(profile, def, cardId) {
  const rec = recordFor(profile, cardId);
  if (!rec.masteries.length) return { ok: false, reason: '没有可洗掉的精通' };
  return { ok: true };
}

/** 洗掉最近一次精通：只撤技能/减费，不退星尘，强化次数也不会回来。 */
export function applyWash(profile, def, cardId) {
  const gate = canWash(profile, def, cardId);
  if (!gate.ok) return gate;
  const rec = recordFor(profile, cardId);
  const masteries = rec.masteries.slice(0, -1);
  return { ok: true, profile: withRecord(profile, cardId, { lvl: 0, masteries }) };
}

// ══════════════════════════════════════════════════════════
// 给引擎的增量表
// ══════════════════════════════════════════════════════════

/**
 * 把档案里的强化记录翻译成引擎的「每方增量表」。
 *
 * 只输出与卡面不同的部分：atk/hp 差值、cost 差值、技能词条，
 * 以及技能带来的 `fx`（触发式异能）、`flags`（单位级开关）、`kingAura`（国王被动）。
 * 引擎在 costOf 与 instantiateUnit 里读它，所以**单位攻/血、锦囊费用、技能机制**
 * 会按方生效，而名字/效果/阵营继续读基础卡牌库。
 */
export function buildSideEnhance(cardLib, profile) {
  const out = {};
  const cards = (profile && profile.forge && profile.forge.cards) || {};
  for (const [cardId, rec] of Object.entries(cards)) {
    const def = cardLib && cardLib[cardId];
    if (!def || !isForgeable(def)) continue;
    const st = statsFor(def, rec);
    const delta = {
      atk: round1(st.atk === null ? 0 : st.atk - (Number(def.atk) || 0)),
      hp: round1(st.hp === null ? 0 : st.hp - (Number(def.hp) || 0)),
      cost: round2(st.cost - (Number(def.cost) || 0)),
      kw: st.keywords,
    };
    if (st.fx && st.fx.length) delta.fx = st.fx;
    if (st.flags && Object.keys(st.flags).length) delta.flags = st.flags;
    if (st.kingAura) delta.kingAura = st.kingAura;
    if (delta.atk || delta.hp || delta.cost || delta.kw.length || delta.fx || delta.flags || delta.kingAura) {
      out[cardId] = delta;
    }
  }
  return out;
}

/** 双方增量表（[side0, side1]），开局直接塞给 createGame 的 enhance。 */
export function buildEnhancePair(cardLib, humanProfile, foeEnhance) {
  return [buildSideEnhance(cardLib, humanProfile), foeEnhance || {}];
}

// ══════════════════════════════════════════════════════════
// AI 的强化（按难度、按种子确定性生成）
// ══════════════════════════════════════════════════════════

/**
 * 难度 → AI 的强化力度。
 *  chance  : 这张牌被强化的概率
 *  mastery : 练满的牌里，额外精通的概率
 * 简单完全不强化，让新手先熟悉基础牌。
 */
const AI_TUNE = {
  easy: { chance: 0, mastery: 0 },
  normal: { chance: 0.15, mastery: 0.15 },
  hard: { chance: 0.35, mastery: 0.35 },
  nightmare: { chance: 0.6, mastery: 0.55 },
  impossible: { chance: 0.85, mastery: 0.8 },
};

/** 32 位 FNV-1a：同一个 (seed, cardId) 永远得到同一个数（不消耗对局 rng） */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 从哈希里取第 k 个 0..1 的伪随机数 */
function frac(h, k) {
  let x = (h ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
}

/**
 * 给 AI 生成一份「与玩家档案同形状」的强化记录（可以直接丢给 buildSideEnhance）。
 *
 * 关键：**不消耗 state.rng**。全部由 (seed, cardId) 哈希决定，
 * 所以回放时同样的种子 + 同样的难度一定还原出同样的 AI 强化。
 */
export function aiForge(cardLib, { seed = 0, difficulty = 'normal' } = {}) {
  const tune = AI_TUNE[difficulty] || AI_TUNE.normal;
  const cards = {};
  // 返回**档案形状**（{forge:{cards}}）而不是裸的 cards —— 这样它能直接喂给
  // buildSideEnhance()，玩家档案与 AI 档案走完全同一条翻译路径。
  if (!tune.chance) return { forge: { v: 1, cards } };
  for (const [id, def] of Object.entries(cardLib || {})) {
    if (!isForgeable(def)) continue;
    const h = hash32(`${seed >>> 0}:${difficulty}:${id}`);
    if (frac(h, 0) >= tune.chance) continue;
    const lvl = 1 + Math.floor(frac(h, 1) * ENHANCE_MAX); // 1..9
    const masteries = [];
    if (lvl === ENHANCE_MAX && frac(h, 2) < tune.mastery) {
      if (isSpell(def)) {
        masteries.push('spell_cost');
        if (frac(h, 3) < tune.mastery * 0.5) masteries.push('spell_cost');
      } else {
        const count = frac(h, 3) < tune.mastery * 0.4 ? 2 : 1;
        const pool = SKILLS.slice();
        for (let i = 0; i < count && pool.length; i++) {
          const idx = pickWeighted(pool, frac(h, 4 + i));
          masteries.push(pool[idx].id);
          pool.splice(idx, 1);
        }
      }
    }
    cards[id] = { lvl, masteries };
  }
  return { forge: { v: 1, cards } };
}

// ══════════════════════════════════════════════════════════
// 强化工坊的列表
// ══════════════════════════════════════════════════════════

/**
 * 工坊列表。默认按卡名首字母分组，也可以切换成按类型（基础卡 / 锦囊卡）。
 *
 * @param {object} cardLib
 * @param {object} profile
 * @param {'initial'|'type'} groupBy
 * @returns {{groups:Array<{key:string,label:string,cards:object[]}>, cards:object[]}}
 */
export function workshopCards(cardLib, profile, groupBy = 'initial') {
  const cards = [];
  for (const [id, def] of Object.entries(cardLib || {})) {
    if (!isForgeable(def)) continue;
    const rec = recordFor(profile, id);
    cards.push({
      id,
      def,
      rec,
      stats: statsFor(def, rec),
      initial: initialOf(def.name),
      type: isSpell(def) ? 'spell' : 'unit',
    });
  }
  // 先按名称排（拼音首字母 + 名称兜底），保证组内顺序稳定
  cards.sort((a, b) => {
    // '#'（其他：数字/拉丁开头）永远排在字母组后面，别顶在列表最前
    if (a.initial !== b.initial) {
      if (a.initial === '#') return 1;
      if (b.initial === '#') return -1;
      return a.initial < b.initial ? -1 : 1;
    }
    return String(a.def.name).localeCompare(String(b.def.name), 'zh-Hans-CN');
  });

  const groups = [];
  if (groupBy === 'type') {
    const unit = cards.filter((c) => c.type === 'unit');
    const spell = cards.filter((c) => c.type === 'spell');
    if (unit.length) groups.push({ key: 'unit', label: '基础卡（单位）', cards: unit });
    if (spell.length) groups.push({ key: 'spell', label: '锦囊卡', cards: spell });
  } else {
    let cur = null;
    for (const c of cards) {
      if (!cur || cur.key !== c.initial) {
        cur = { key: c.initial, label: c.initial === '#' ? '其他' : c.initial.toUpperCase(), cards: [] };
        groups.push(cur);
      }
      cur.cards.push(c);
    }
  }
  return { groups, cards };
}

/** 这张牌精通后大概会变成什么样（给确认弹窗写一句人话） */
export function masteryHint(def) {
  if (isSpell(def)) {
    const base = Number(def.cost) || 0;
    const per = base <= 2 ? 0.25 : 1;
    return `费用 ${fmtNum(base)} → ${fmtNum(Math.max(0, base - per))}（原费 ≤2 时每次只 −0.25）`;
  }
  return '失去全部强化数值，从 3 个随机技能中选 1 个永久挂上';
}
