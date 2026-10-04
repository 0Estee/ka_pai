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

import { LANES, KING_MAX_HP } from './constants.js';
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

export function makePlayer(side, faction = null) {
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

export function makeBoard() {
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
    choiceQueue: [],
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
    stats: { cardsPlayed: 0, unitsDestroyed: 0 },
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
// 单位实例
// ══════════════════════════════════════════════════════════

export function instantiateUnit(state, def, side, lane, row) {
  // 「本局对战中这张牌进入战场的次数」（卡牌「扫地僧」）。
  // 记在这一处是因为**打出**（play.js）和**召唤**（combat.js）都经过它，
  // 两条路的「进入战场」都会算上。
  const owner = state.players && state.players[side];
  if (owner) {
    if (!owner.entries) owner.entries = {};
    owner.entries[def.id] = (owner.entries[def.id] || 0) + 1;
  }

  return {
    uid: state.nextUid++,
    cardId: def.id,
    name: def.name,
    side, lane, row,
    atk: def.atk,
    hp: def.hp,
    maxHp: def.hp,
    keywords: (def.keywords || []).map(parseKeyword),
    effects: def.effects || [],
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
  };
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
