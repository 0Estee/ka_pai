/**
 * 建局与单位实例。
 *
 * 从 engine.js 拆出（纯搬移，行为不变）：
 *   PENDING / makePlayer / makeBoard / createGame / instantiateUnit
 * 另含两个内部工具：attackPower（这一击的伤害基数）、probeFromDef（卡牌定义 → 落点探针）。
 *
 * ⚠️ startGame 不在这里 —— 它开头就要调 enterPhase，而 enterPhase 住在 turns.js。
 *    为了不让 setup ←→ turns 绕成环，startGame 跟 enterPhase 放在一起（turns.js）。
 *
 * 依赖方向：constants/rng/keywords ← mechanics ← setup ← turns/play/choices/combat
 */

import { LANES, KING_MAX_HP, fixNum } from './constants.js';
import { createRng, shuffle } from './rng.js';
import { parseKeyword } from './keywords.js';
import { effectiveAtk } from './auras.js';

/**
 * 「需要向玩家提问」的哨兵值。
 * generator 里 yield 出它表示「先挂起，等 resolveChoice 喂回选项」。
 * choices.js 与 engine.js 门面都要用，所以必须导出。
 */
export const PENDING = Symbol('PENDING');

// ══════════════════════════════════════════════════════════
// 建局
// ══════════════════════════════════════════════════════════

function makePlayer(side, faction = null) {
  return {
    side,
    kingHp: KING_MAX_HP,
    kingMaxHp: KING_MAX_HP,
    mana: 0,
    manaCap: 0,
    manaCapBonus: 0,
    hand: [],
    // 国王身上附着的永久被动（卡牌「战略纵深」）。见 effects.js 的 attachKingEffect
    kingEffects: [],
    // 国王身上的标记（淬毒等）。国王不是单位、没有 marks 容器，所以记在玩家对象上。
    kingMarks: [],
    /**
     * 本局**这张牌进入战场的次数**，key = cardId（卡牌「扫地僧」的打出效果要读它）。
     * 各方各算自己的。只在这里存计数，具体怎么用见 amounts.js 的 `{ perOwnEntry: N }`。
     */
    entries: {},

    // 阵营（作者 2026-10-03 的超能力系统）。null = 中立：没有超能力可抽。
    faction,
    // 本局已经抽到的超能力（cardId 列表，同一个不会抽第二次）
    superpowers: [],
    // 已经触发过的国王血量阈值（15 / 9 / 3 各一张，只触发一次）
    spThresholds: {},
    /**
     * 本局**这张牌被用过几次**（key = cardId，各方各算自己的）。
     * 「连斩」按这个涨费用：本局每用过一张连斩，这张牌 +1 花费。
     * 与 entries 的区别：entries 记「进场次数」（单位），这里记「使用次数」（含锦囊）。
     */
    usedCount: {},
    /** 「友方手中卡牌-1花费」这类**永久**手牌费用修正（卡牌「新兴研究」），负数 = 减费 */
    handCostDelta: 0,
    /**
     * 上一张打出的锦囊 / 当前正在结算的锦囊（卡牌「克隆」要重复上一张的效果）。
     * play.js 在锦囊**结算完成后**才把 lastSpell 记成本次这张，
     * 所以结算期间 lastSpell 仍是上一张、currentSpell 是本次这张（防自我递归）。
     */
    lastSpell: null,
    currentSpell: null,
    /** 「友方国王本回合每次受伤-N」（卡牌「祈祷」）：{ amount, turn }，按回合失效 */
    kingDamageReduce: null,
  };
}

function makeBoard() {
  const board = {};
  for (const lane of LANES) {
    board[lane] = {
      units: [{ front: null, back: null }, { front: null, back: null }],
      traps: [null, null], // v0.2 未启用（裁决 D2）
    };
  }
  return board;
}

/**
 * @param {object} cfg
 * @param {number} cfg.seed           随机种子（同种子 = 同对局）
 * @param {number} cfg.firstPlayer    先手方 0 | 1
 * @param {string[]} cfg.deck         共享牌库（卡牌 id 数组）
 * @param {object} cfg.cardLib        卡牌库 { [cardId]: CardDef }
 * @param {boolean} cfg.shuffleDeck   是否洗牌
   * @param {string[]} cfg.factions     双方阵营（[先手, 后手] 的 key；不传 = 中立）
 */
export function createGame(cfg = {}) {
  const {
    seed = 20240501,
    firstPlayer = 0,
    deck = [],
    cardLib = {},
    shuffleDeck = true,
    factions = [],
    // 双方强化增量（[side0, side1]）。不传 = 都没有强化，行为与旧版完全一致。
    enhance = null,
  } = cfg;

  const rng = createRng(seed);
  const deckCopy = deck.slice();
  if (shuffleDeck) shuffle(rng, deckCopy);

  return {
    seed,
    turn: 0,
    phase: null,
    firstPlayer,
    players: [makePlayer(0, factions[0]), makePlayer(1, factions[1])],
    deck: deckCopy,
    discard: [],
    board: makeBoard(),
    rng,
    log: [],
    triggerQueue: [],
    pending: null,
    autoResolveChoices: true,
    /**
     * 本地玩家是哪一方（单机 0；联机时客人是 1）。
     *
     * 引擎用不到它来做规则判定，只在**开战中途停下来问人**时判断
     * 「这一问该不该挂起等人」：是真人那侧的「拟定目标攻击」（强化士兵）
     * 才挂起，AI 那侧按 targetPicker 自己挑（否则 AI 的这张牌永远出不了手，
     * 因为没人会去答它的请求）。
     */
    humanSide: 0,
    /**
     * 「拟定目标攻击」在自动结算（AI 侧）时的挑目标策略。
     * 由界面注入（app/js/ai.js 的 aiTargetPicker）；不注入就用引擎自带口径
     * （combat.js 的 combatTargetPicker）。保持「纯函数 + 不依赖 rng」，回放才确定。
     */
    targetPicker: null,
    winner: null,
    winReason: null,
    deckEmpty: false,
    cardLib,
    /**
     * 强化 / 精通带来的**每方**卡牌增量（2026-10「强化工坊」）。
     *
     * 形如 [{ [cardId]: { atk, hp, cost, kw:[{id,x}] } }, {...}]：
     * 索引是方（0/1），因为双方可以各自强化同一张卡，而牌库是共享的。
     * 只有**单位攻/血、词条、锦囊费用**需要按方区分，其余（名字/效果/阵营）
     * 继续读基础 cardLib —— 这也是不重构成「每方一份 cardLib」的原因。
     */
    enhance: normalizeEnhance(enhance),
    stats: { cardsPlayed: 0, unitsDestroyed: 0, killsBySide: [0, 0] },
    nextUid: 1,
    nextIid: 1,
    extraAttackUsed: {},
    // 本回合对某一方伤害的封顶（卡牌「反应装甲」）
    damageCaps: [],
    // 「下个大回合开始时召唤」的排队（阵营超能力「召唤仪式」）
    delayedSummons: [],
    /** 「下个回合开始时抽牌」（卡牌「前沿科技」）：[{ side, n, atTurn }] */
    delayedDraws: [],
    // 「拟定目标攻击」的指定结果：{ [uid]: {uid} | {king:true, side} }
    combatPlans: {},
    // 本回合已经问过选目标的单位（先制 + 追击共用第一次的答案，不重复问）
    combatTargetAsked: {},
    // 线路封锁：{ [lane]: untilTurn }（卡牌「氢弹」）。turn <= untilTurn 期间不能放置单位。
    laneLocks: {},
    _pendingDeaths: [],
  };
}

// ══════════════════════════════════════════════════════════
// 强化 / 精通增量
// ══════════════════════════════════════════════════════════

/** 没有强化时的零值（常量，**不要修改它**） */
const NO_ENHANCE = { atk: 0, hp: 0, cost: 0, kw: [], fx: [], flags: {}, kingAura: null };

/**
 * 把外部传进来的强化表洗成引擎认的形状。
 *
 * 允许的来源：玩家档案（强化工坊）、联机 start 消息、回放存档。
 * 脏数据一律丢弃 —— 存档坏掉不该让对局开不起来。
 *
 * 除 atk/hp/cost/kw 之外还带三样（作者 2026-10-24 五档技能表）：
 *   fx       触发式异能，直接挂到单位身上
 *   flags    单位级开关（暴击概率 / 攻血交换 / 锦囊减伤…）
 *   kingAura 在场时给友方国王的被动（祝福上限 / 生命下限）
 */
export function normalizeEnhance(raw) {
  const out = [{}, {}];
  if (!Array.isArray(raw)) return out;
  for (let side = 0; side < 2; side++) {
    const src = raw[side];
    if (!src || typeof src !== 'object') continue;
    for (const [cardId, v] of Object.entries(src)) {
      if (!v || typeof v !== 'object') continue;
      const atk = Number(v.atk) || 0;
      const hp = Number(v.hp) || 0;
      const cost = Number(v.cost) || 0;
      const kw = Array.isArray(v.kw)
        ? v.kw
          .filter((k) => k && typeof k.id === 'string')
          .map((k) => ({ id: k.id, x: Number(k.x) || 0 }))
        : [];
      const fx = Array.isArray(v.fx) ? sanitizeEffects(v.fx) : [];
      const flags = v.flags && typeof v.flags === 'object' ? sanitizeFlags(v.flags) : null;
      const kingAura = v.kingAura && typeof v.kingAura === 'object' ? sanitizeKingAura(v.kingAura) : null;
      if (atk === 0 && hp === 0 && cost === 0 && kw.length === 0
          && fx.length === 0 && !flags && !kingAura) continue;
      out[side][cardId] = { atk, hp, cost, kw, fx, flags, kingAura };
    }
  }
  return out;
}

/** 深拷贝一份异能表（技能给的 fx 不能被某一局改脏，卡库是双方共享的） */
function sanitizeEffects(list) {
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object' || typeof e.trigger !== 'string') continue;
    try {
      out.push(JSON.parse(JSON.stringify(e)));
    } catch (_) { /* 脏数据跳过 */ }
  }
  return out;
}

const FLAG_KEYS = ['critAlways', 'critChance', 'swapStats', 'spellDamageReduce', 'costPerAlly', 'comboStrike'];
function sanitizeFlags(src) {
  const out = {};
  for (const k of FLAG_KEYS) {
    if (src[k] === undefined) continue;
    if (k === 'critAlways' || k === 'swapStats' || k === 'comboStrike') out[k] = !!src[k];
    else out[k] = Number(src[k]) || 0;
  }
  if (src.critAfterTurn && typeof src.critAfterTurn === 'object') {
    out.critAfterTurn = { turn: Number(src.critAfterTurn.turn) || 0, x: Number(src.critAfterTurn.x) || 0 };
  }
  return Object.keys(out).length ? out : null;
}

function sanitizeKingAura(src) {
  const out = {};
  if (src.blessing !== undefined) out.blessing = Number(src.blessing) || 0;
  if (src.hpFloor !== undefined) out.hpFloor = Number(src.hpFloor) || 0;
  return Object.keys(out).length ? out : null;
}

/** 取某方某张卡的强化增量；没有就返回零值常量。 */
export function enhanceFor(state, side, cardId) {
  const sideMap = state && state.enhance && state.enhance[side];
  const rec = sideMap && sideMap[cardId];
  return rec || NO_ENHANCE;
}

/**
 * 合并词条：同 id 的 x 相加（装甲 1 + 装甲 1 = 装甲 2）。
 * 基础词条来自卡面，增量来自技能。
 */
export function mergeKeywords(base, extra) {
  const out = (base || []).map((k) => ({ id: k.id, x: k.x }));
  if (!extra || !extra.length) return out;
  for (const k of extra) {
    const hit = out.find((o) => o.id === k.id);
    if (hit) hit.x += Number(k.x) || 0;
    else out.push({ id: k.id, x: Number(k.x) || 0 });
  }
  return out;
}

// ══════════════════════════════════════════════════════════
// 单位实例
// ══════════════════════════════════════════════════════════

/**
 * 卡面定义的 effects 数组必须**按实例复制**。
 *
 * 「attachEffect」（色欲 / 黑曜石）会把异能追加到单位身上；如果单位直接持有卡面定义
 * 的那个数组，这次追加就写进了卡库  之后所有同名卡（连对手的）都会白得一条异能。
 */
function instanceEffects(def) {
  return (def.effects || []).map((e) => Object.assign({}, e));
}

export function instantiateUnit(state, def, side, lane, row) {
  // 「本局对战中这张牌进入战场的次数」（卡牌「扫地僧」）。
  // 记在这一处是因为**打出**（play.js）和**召唤**（combat.js）都经过它，
  // 两条路的「进入战场」都会算上。
  const owner = state.players && state.players[side];
  if (owner) {
    if (!owner.entries) owner.entries = {};
    owner.entries[def.id] = (owner.entries[def.id] || 0) + 1;
  }

  // 强化 / 精通：只在这一处把增量落到单位身上，之后所有规则都照常读实例字段。
  // 牌库是双方共享的，所以增量必须按 side 取，不能写进 def。
  const enh = enhanceFor(state, side, def.id);
  // 强化是 0.1 一档，直接相加会得到 6.300000000000001；落地就算成两位小数，
  // 之后界面、伤害、回血读到的都是干净的数。
  const hp = fixNum((Number(def.hp) || 0) + enh.hp);
  let atk = fixNum((Number(def.atk) || 0) + enh.atk);
  let maxHp = hp;
  let curHp = hp;
  const flags = enh.flags || {};
  // 「扭曲」：先 +1/+1（已在 atk/hp 里了），再把攻/血**数值对调**（作者 2026-10-24）
  if (flags.swapStats) {
    const t = atk;
    atk = curHp;
    curHp = t;
    maxHp = t;
  }
  const unit = {
    uid: state.nextUid++,
    cardId: def.id,
    name: def.name,
    side, lane, row,
    atk,
    hp: curHp,
    maxHp,
    keywords: mergeKeywords((def.keywords || []).map(parseKeyword), enh.kw),
    // 技能带的触发式异能（「富足：打出抽一张」等）跟着实例走，不写进共享卡库
    effects: instanceEffects(def).concat((enh.fx || []).map((e) => Object.assign({}, e))),
    marks: [],
    removed: false,
    lastDamageSource: null,
    // 「此攻击使用♥而不是⚔」（卡牌「武术大师」）—— 不是词条，是这张牌自己的攻击口径
    attackWithHp: !!def.attackWithHp,
    // 「任何单位攻击时将略过这张牌」（蜜蜂）—— 不挡枪
    bypassInCombat: !!def.bypassInCombat,
    // 「为后方的单位承受伤害」（伪装土堆）—— 替后排挨打
    bodyguard: !!def.bodyguard,
    // 「拟定目标攻击」（强化士兵）—— 开战时由玩家指定打谁
    choosesTarget: !!def.choosesTarget,
    // 炼金：巫毒娃娃 (U430) - 每回合友方国王首次受到的伤害改由敌方国王承受
    voodooDoll: !!def.voodooDoll,
  };
  // ── 技能里的单位级开关（作者 2026-10-24 五档技能表）
  if (flags.critAlways) unit.critAlways = true;
  if (flags.critChance !== undefined) unit.critChance = flags.critChance;
  if (flags.critAfterTurn) unit.critAfterTurn = flags.critAfterTurn;
  if (flags.spellDamageReduce) unit.spellDamageReduce = flags.spellDamageReduce;
  if (flags.costPerAlly) unit.costPerAlly = flags.costPerAlly;
  if (flags.comboStrike) unit.comboStrike = true;
  // 「在场:友方国王获祝福 / 生命至少为 1」—— 由 damage.js 扫场上单位取
  if (enh.kingAura) unit.kingAura = enh.kingAura;
  return unit;
}

/**
 * 一个单位这一击的**伤害基数**。
 *
 * 平时是有效攻击力（含光环）；「武术大师」那类「此攻击使用♥而不是⚔」的单位用当前生命。
 * 交战筛选、伤害计算、溅射/穿透的基数都走这里，保证三处口径一致。
 */
export function attackPower(state, unit) {
  if (!unit) return 0;
  return unit.attackWithHp ? Math.max(0, unit.hp) : effectiveAtk(state, unit);
}

export function probeFromDef(def) {
  return { keywords: (def.keywords || []).map(parseKeyword), hp: def.hp, maxHp: def.hp };
}
