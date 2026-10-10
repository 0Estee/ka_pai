/**
 * 属性与牌库：词条的授予/剥夺、数值修改、抽牌、费用。
 *
 * 从 mechanics.js 拆出（纯搬移，行为不变）：
 *   grantKeyword / expireTimedKeywords / sealUnit / isSealed / revokeKeyword /
 *   returnCardsToDeck / buffAtk / buffMaxHp / debuffMaxHp / setUnitStats /
 *   advanceStatStep / drawCards / gainManaCap / gainMana
 *
 * 依赖方向：board ← damage ← stats
 */

import { LANES, ROWS, SIDE, KING_MAX_HP, REBIRTH_HP } from './constants.js';
import { getKw, hasKw, isFrozen, computeFinalDamage, nimbleShouldDrown, parseKeyword } from './keywords.js';
import { chance, shuffle } from './rng.js';
import { log, findUnit, laneUnits, allUnitsInLane, allUnits, destroyUnit } from './board.js';
import { queueTrigger, checkNimble } from './damage.js';
import { alchemyOnDraw } from './factions.js';

// ─────────────────────────────────────────────────────────
// 词条的授予 / 剥夺
// ─────────────────────────────────────────────────────────

/**
 * 永久授予一个词条（卡牌「狂犬病：一名队友获得疾病」）。
 * 与光环的区别：这是**永久写进单位**的，不会因为来源离场而消失。
 * 已经拥有该词条时不重复添加。
 *
 * opts.untilTurn = N：这条词条只在第 N 回合有效（卡牌「炫彩糖果：本回合获得无敌」）。
 * 到期的清理在 engine.js 的 onTurnEnd（把过期项从 unit.keywords 里摘掉），
 * 这样不依赖 state 的 hasKw 在回合结束后也不会读到它。
 */
export function grantKeyword(state, unit, keywordId, x = 0, opts = {}) {
  if (!unit || unit.removed) return false;
  const parsed = parseKeyword(keywordId);
  const existing = getKw(unit, parsed.id);
  if (existing) {
    // 已经永久拥有就不动；只把「有时限的那一份」补上
    if (opts.untilTurn && !existing.untilTurn) existing.untilTurn = opts.untilTurn;
    return false;
  }
  const kw = { id: parsed.id, x: parsed.x || x || 0 };
  if (opts.untilTurn) kw.untilTurn = opts.untilTurn;
  unit.keywords.push(kw);
  log(state, { type: 'grant-keyword', uid: unit.uid, keyword: parsed.id, x: kw.x, untilTurn: kw.untilTurn || null });
  return true;
}

/** 清掉所有到期的「有时限词条」。在回合结束时调用。 */
export function expireTimedKeywords(state) {
  for (const unit of allUnits(state)) {
    if (unit.removed) continue;
    const before = unit.keywords.length;
    unit.keywords = unit.keywords.filter((k) => !(k.untilTurn && state.turn >= k.untilTurn));
    if (unit.keywords.length !== before) {
      log(state, { type: 'keyword-expired', uid: unit.uid, n: before - unit.keywords.length });
    }
  }
}

/**
 * 封印一个单位（卡牌「禁军」「大封印碑」「卫兵」）。
 *
 * **作者裁决 D62（2026-09）**：被封印者**除攻击力与生命之外的一切特殊效果全部失效** ——
 *   · 异能 `effects`（含「被消灭:」遗言）不发动 → `choices.js` 的 `runTriggeredEffects` 拦
 *   · 词条全停（祝福/装甲/荆棘/溅射/组合…）→ `auras.js` 的 `allKeywordsOf` 拦
 *   · 它自己的「在场」光环停止、它也不再吃任何光环加成 → `auras.js` 的 `auraAtkDelta` 拦
 * **永久**，直到该单位离场（没有回合数、没有解封动作）。
 * 一次性封印与「在场」式封印光环（大封印碑）都是这个口径。
 */
export function sealUnit(state, unit, reason = 'seal') {
  if (!unit || unit.removed) return false;
  if (unit.sealed) return false;
  unit.sealed = true;
  log(state, { type: 'seal', uid: unit.uid, cardId: unit.cardId, reason });
  return true;
}

/** 单位被封印时它的 effects 不生效 */
export function isSealed(unit) {
  return !!(unit && unit.sealed);
}

/**
 * 把若干张卡放回牌库（卡牌「回收」洗回牌组、「利奥波德」返回牌堆顶）。
 *   to='top'     → 按给定顺序压到牌堆顶（后放的在上）
 *   to='shuffle' → 洗进牌库
 */
export function returnCardsToDeck(state, cardIds, to = 'top') {
  if (!cardIds || cardIds.length === 0) return 0;
  if (to === 'shuffle') {
    state.deck.push(...cardIds);
    // 用引擎自己的 rng，保证可复现
    shuffle(state.rng, state.deck);
  } else {
    // unshift 会把最后一个放最上面，所以倒着压
    for (let i = cardIds.length - 1; i >= 0; i--) state.deck.unshift(cardIds[i]);
  }
  log(state, { type: 'return-to-deck', to, count: cardIds.length, deckLeft: state.deck.length });
  return cardIds.length;
}

/** 剥夺一个词条（例如「复生」用掉之后 —— 引擎内部也用这个） */
export function revokeKeyword(state, unit, keywordId) {
  if (!unit || unit.removed) return false;
  const before = unit.keywords.length;
  unit.keywords = unit.keywords.filter((k) => k.id !== keywordId);
  if (unit.keywords.length === before) return false;
  log(state, { type: 'revoke-keyword', uid: unit.uid, keyword: keywordId });
  return true;
}

/**
 * 把一只单位的攻击力**永久锁死**（卡牌「诅咒」「神罚」）。
 *
 * 作者 2026-10 口径：永久设为 0 = 本局剩下的时间内不能通过加成提升攻击力，攻击力只能为 0。
 * 所以不只是把 atk 写成 0，还在 unit.atkLocked 上留一个标记，
 * 让所有改攻击力的通道（buffAtk / setUnitStats）全部让路。
 */
export function lockAtk(state, unit, value = 0) {
  if (!unit || unit.removed) return;
  unit.atk = Math.max(0, value);
  unit.atkLocked = Math.max(0, value);
  log(state, { type: 'atk-locked', uid: unit.uid, atk: unit.atk });
}

/**
 * 调整某个**已有词条的数量** x，没有就新加一个（卡牌「神使：回合开始:获得+1装甲」）。
 *
 * 为什么不直接用 grantKeyword：那个遇到同名已有词条会**直接返回 false**（同名词条不叠加），
 * 而作者口径「+1装甲」要的正是把装甲的 X 加 1。
 */
export function buffKeywordX(state, unit, keywordId, delta = 1) {
  if (!unit || unit.removed || !delta) return;
  const existing = (unit.keywords || []).find((k) => k.id === keywordId);
  if (existing) existing.x = Math.max(0, (existing.x || 0) + delta);
  else unit.keywords.push({ id: keywordId, x: Math.max(0, delta) });
  log(state, { type: 'buff-keyword-x', uid: unit.uid, keyword: keywordId, delta, x: existing ? existing.x : Math.max(0, delta) });
}

export function buffAtk(state, unit, amount) {
  if (!unit || unit.removed) return;
  /** 被「永久设为0」锁死的单位不再接受任何攻击力加成（卡牌「诅咒」「神罚」） */
  if (unit.atkLocked !== undefined && unit.atkLocked !== null) return;
  unit.atk = Math.max(0, unit.atk + amount);
  log(state, { type: 'buff-atk', uid: unit.uid, amount, atk: unit.atk });
}

/** 提升生命上限并同时治疗等量生命 */
export function buffMaxHp(state, unit, amount) {
  if (!unit || unit.removed) return;
  unit.maxHp += amount;
  unit.hp += amount;
  log(state, { type: 'buff-maxhp', uid: unit.uid, amount, maxHp: unit.maxHp, hp: unit.hp });
  checkNimble(state, unit);
}

/**
 * 从共享牌库抽牌。牌库为空则返回抽到的数量（< n）。
 * opts.raw === false 时不发原料（开局起手用；作者口径：开局抽的牌不产原料）。
 */
export function drawCards(state, side, n, opts = {}) {
  const p = state.players[side];
  const drawnIds = [];
  for (let i = 0; i < n; i++) {
    if (state.deck.length === 0) {
      state.deckEmpty = true;
      break;
    }
    const cardId = state.deck.shift();
    p.hand.push({ iid: state.nextIid++, cardId });
    drawnIds.push(cardId);
  }
  log(state, { type: 'draw', side, count: drawnIds.length, deckLeft: state.deck.length });

  // 「敌方抽牌时:」（卡牌「希佩尔海军上将号」）—— 播给对手的观察者
  if (drawnIds.length > 0) {
    for (const watcher of allUnits(state)) {
      if (watcher.removed || watcher.side === side) continue;
      if (!(watcher.effects || []).some((e) => e.trigger === 'onOpponentDraw')) continue;
      queueTrigger(state, watcher, 'onOpponentDraw', { drawerSide: side, cards: drawnIds });
    }
  }
  // 炼金：每抽一张牌就从原料堆里抽一张原料（起手除外，见 opts.raw）
  if (opts.raw !== false) alchemyOnDraw(state, side, drawnIds.length);
  return drawnIds.length;
}

/** 费用上限增长（规则书 §6）。立刻同时补满当前费用。 */
export function gainManaCap(state, side, amount) {
  const p = state.players[side];
  p.manaCapBonus += amount;
  p.manaCap += amount;
  p.mana += amount;
  log(state, { type: 'mana-cap', side, amount, manaCap: p.manaCap, mana: p.mana });
}

/** 立即获得费用（不改变上限） */
export function gainMana(state, side, amount) {
  const p = state.players[side];
  p.mana += amount;
  log(state, { type: 'mana', side, amount, mana: p.mana });
}

// ─────────────────────────────────────────────────────────
// 变形
// ─────────────────────────────────────────────────────────

/**
 * 把一只场上的单位**就地变成另一张牌**（卡牌「魔术师：让一名敌人变为 令牌[兔子]」）。
 *
 * 作者 2026-09 裁决的口径：
 *   · 是**真正的变形** —— 名字、卡 id、攻血、词条、异能全部换成目标那张牌（兔子 U329）
 *   · 之前的加成**完全重置**：变出来的就是干净的 1/2 兔子，不是在它现有数值上改
 *   · **不算重新进入战场**：uid 不变、不记进场次数、不触发「打出」异能
 *   · 位置与阵营不变（原地变形，还在那条线那一排）
 *
 * **为什么放在 stats.js**：它本质是「数值 + 词条 + 异能」三样一起改写，
 * 正是这个文件的职责；而且 stats.js 已经 import 了 `log`。
 * （放在 setup.js 会缺 `log`，而 setup ← stats 的方向又不允许从 board.js 补。）
 *
 * 实现选择「就地改写同一个对象」而不是「销毁旧的、造一个新的」：
 * 棋盘引用、`findUnit(uid)`、界面里已经打开的详情面板、以及效果队列里
 * 已经抓住这个单位的事件，全都继续有效 —— 换对象会让它们指向一只已经不在场上的幽灵。
 *
 * ⚠ 保留 `sealed`（一只被封印的敌人变成兔子之后，封印状态不该因此掉）；
 *   清掉 `marks`（淬毒/疾病/冻结/无法选中都是那只原单位身上的东西）。
 */
export function transformUnit(state, unit, newCardId) {
  if (!unit || unit.removed) return false;
  const def = state.cardLib && state.cardLib[newCardId];
  if (!def) return false;

  const from = { cardId: unit.cardId, name: unit.name, atk: unit.atk, hp: unit.hp };

  unit.cardId = def.id;
  unit.name = def.name;
  // 完全重置：直接取新卡的基准值，不叠加任何旧修正
  unit.atk = def.atk;
  unit.hp = def.hp;
  unit.maxHp = def.hp;
  // 词条与异能整块换掉（兔子两者都没有 → 变成一张白板）
  unit.keywords = (def.keywords || []).map(parseKeyword);
  // 同上：按实例复制，别把卡库的数组挂到单位身上
  unit.effects = (def.effects || []).map((e) => Object.assign({}, e));
  // 这些「不是词条、但写在卡面定义里」的攻击口径也要跟着换
  unit.attackWithHp = !!def.attackWithHp;
  unit.bypassInCombat = !!def.bypassInCombat;
  unit.bodyguard = !!def.bodyguard;
  unit.choosesTarget = !!def.choosesTarget;
  // 属于「那只原单位」的东西一律清掉（封印是例外，见上）
  unit.marks = [];
  unit.lastDamageSource = null;

  log(state, {
    type: 'transform', uid: unit.uid, side: unit.side, lane: unit.lane, row: unit.row,
    fromCardId: from.cardId, fromName: from.name, fromAtk: from.atk, fromHp: from.hp,
    toCardId: def.id, toName: def.name, atk: unit.atk, hp: unit.hp,
  });
  return true;
}