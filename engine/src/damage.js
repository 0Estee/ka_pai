/**
 * 伤害、死亡与状态标记：消灭/消失、伤害管线、触发入队、治疗、冻结、伤害封顶。
 *
 * 从 mechanics.js 拆出（纯搬移，行为不变）：
 *   destroyUnit / vanishUnit / dealDamage / onDealtDamage / notifyDamageWatchers /
 *   queueTrigger / queueKingTrigger / healUnit / healKing / damageCapFor /
 *   addDamageCap / freezeUnit / consumeFreeze / checkNimble / checkAllNimble
 *
 * 依赖方向：board ← damage ← stats
 */

import { checkSuperpowerThresholds } from './factions.js';
import { LANES, ROWS, SIDE, KING_MAX_HP, REBIRTH_HP } from './constants.js';
import { getKw, hasKw, isFrozen, computeFinalDamage, nimbleShouldDrown, parseKeyword, isUntargetable } from './keywords.js';
import { chance, shuffle } from './rng.js';
//  这一句让 damage  auras 多一条边（auras  mechanics  damage 本来就有环）。
//   项目规矩是「环里只放函数声明、不要放加载期求值的顶层 const」
//   这里只用到一个函数，且只在调用期使用，ESM 与打包器都安全。
import { isSealedByAura } from './auras.js';
import {
  log, findUnit, laneUnits, allUnitsInLane, allUnits, enemyFrontUnit, enemyCombatTarget,
  findBodyguard, removeUnitFromBoard, destroyUnit, canMoveTo, moveUnitToLane, bounceUnit, trapsOf,
} from './board.js';

// ─────────────────────────────────────────────────────────
// 状态标记（冻结）
// ─────────────────────────────────────────────────────────

/**
 * 冻结一个单位。状态型、不叠加：已经冻住就不再挂第二个标记
 * （否则要被打两次才能解冻，与「下一次攻击时解除」矛盾）。
 */
export function freezeUnit(state, unit) {
  if (!unit || unit.removed) return false;
  if (isFrozen(unit)) return false;
  unit.marks.push({ type: 'freeze', appliedTurn: state.turn });
  log(state, { type: 'freeze', uid: unit.uid });
  return true;
}

/**
 * 开战时结算冻结：把这一批里被冻住的单位挑出来，摘掉标记、不让它攻击。
 * 返回**本回合真的能出手**的那批。
 *
 * 只对「本来会攻击」的单位结算 —— 攻击力 0 的单位永远不攻击，
 * 冻它没有意义，标记留着（作者原文是「下一次攻击时」）。
 */
export function consumeFreeze(state, units) {
  const ready = [];
  for (const u of units) {
    if (isFrozen(u)) {
      u.marks = u.marks.filter((m) => m.type !== 'freeze');
      log(state, { type: 'freeze-skip', uid: u.uid, lane: u.lane });
      continue;
    }
    ready.push(u);
  }
  return ready;
}

/**
 * 造成伤害。source 可以是单位对象或 null。
 * opts:
 *   ignoreMechanisms  跳过祝福/装甲（淬毒用）
 *   noCrit            不触发暴击（荆棘反弹用）
 *   noThorns          不触发荆棘（荆棘反弹用，防无限循环）
 *   noKeywords        不触发任何「造成伤害时」词条（淬毒/疾病/暴击）
 *   noWatchers        不惊动「有敌人受到伤害时」的观察者（防连锁，见 notifyDamageWatchers）
 *   isCombat          标记为交战伤害（用于双重打击/狂热的判定）
 *
 * 返回实际造成的伤害值。
 */
export function dealDamage(state, source, target, raw, opts = {}) {
  if (raw <= 0) return 0;

  // ── 「为后方的单位承受伤害」（卡牌「伪装土堆」）：伤害改由同线路前排的代收者吃下。
  //    放在最前面，所以封顶/暴击/祝福/装甲全都按**代收者**算 —— 它才是真正挨打的那个。
  if (target && target.kind === 'unit' && !opts.noRedirect) {
    const bg = findBodyguard(state, target.unit);
    if (bg) {
      log(state, { type: 'damage-redirect', from: target.unit.uid, to: bg.uid, amount: raw });
      target = { kind: 'unit', unit: bg };
    }
  }

  /**
   * 「无法选中」：不可被**敌方**锦囊和单位的效果影响（作者 2026-10 口径）。
   *
   * 放在伤害管线最前面，专门拦**不经过选择**的那些伤害 —— 溅射 / 穿透 /
   * 观察者（怨魂鲨鱼）/ 荆棘反弹 / 触发式异能。它们不「选目标」，
   * 所以 targets.js 那层过滤器拦不住，只能在这里拦。
   * 友方对它的伤害照旧（source.side 相同就放行）；source 为 null（环境伤害、
   * 判不出敌我）也不拦。
   */
  if (target && target.kind === 'unit' && !opts.noUntargetable
      && isUntargetable(target.unit) && source !== target.unit) {
    // source 可能是 null（环境伤害 / 无来源），所以这里不能直接读 source.side\n    log(state, { type: 'untargetable-block', uid: target.unit.uid, from: source ? source.side : null, amount: raw });
    return 0;
  }

  //  陷阱触发（卡牌「反应装甲」）：伤害要落到挨打那一方身上时，
  //    先看它有没有埋着没触发的陷阱（作者 2026-10 口径：触发后本回合内有效，
  //    效果结束才消失；封顶是**单次伤害**封顶）。
  triggerTrapOnDamage(state, source, target);

  // ── 本回合的伤害封顶（卡牌「反应装甲」）
  let incoming = raw;
  if (source && !opts.noCap) {
    const cap = damageCapFor(state, source.side);
    if (cap !== null && incoming > cap) {
      log(state, { type: 'damage-capped', from: incoming, to: cap, side: source.side });
      incoming = cap;
    }
  }

  // ── 暴击：在进入修正链之前加伤（作为同一次伤害实例，避免连锁 —— 裁决 B9）
  let amount = incoming;
  if (source && !opts.noCrit && !opts.noKeywords) {
    const crit = getKw(source, 'crit');
    if (crit && crit.x > 0 && chance(state.rng, 0.5)) {
      amount += crit.x;
      log(state, { type: 'crit', uid: source.uid, x: crit.x, lane: source.lane });
    }
  }

  const isKing = target.kind === 'king';
  /**
   * 「是否被封印」要在这里算：一次性封印（`unit.sealed`）与光环式封印
   *（大封印碑，`isSealedByAura`）都只有拿得到 state 的地方才看得见，
   * 而 computeFinalDamage 只拿得到单位。算好塞进 opts 传下去（裁决 D62）。
   */
  const sealed = !isKing && (!!target.unit.sealed || isSealedByAura(state, target.unit));
  const finalAmount = isKing
    ? amount
    : computeFinalDamage(target.unit, amount, { ...opts, sealed });

  if (finalAmount <= 0) {
    log(state, { type: 'damage-blocked', target: isKing ? `king${target.side}` : target.unit.uid, raw: amount });
    return 0;
  }

  /**
   * 「本回合国王无敌」（阵营超能力「庇佑」）：标记记在玩家对象上，只看本回合。
   * 与单位无敌同口径：无视机制的伤害（淬毒）照样被挡，必中（unpreventable）穿透。
   */
  if (isKing && state.players[target.side].kingInvincibleTurn === state.turn
      && !(opts && opts.unpreventable)) {
    log(state, { type: 'damage-blocked', target: `king${target.side}`, raw: amount });
    return 0;
  }

  if (isKing) {
    const p = state.players[target.side];
    p.kingHp -= finalAmount;
    log(state, { type: 'king-damage', side: target.side, amount: finalAmount, hp: p.kingHp, source: source ? source.uid : null });

    // 「造成伤害:」异能**包括对国王造成伤害**（作者确认，规则书 §1 已同步修订）。
    // 「淬毒」现在**也能挂到国王身上**（作者 2026-10 要求）；「疾病」仍然不触发（国王不是单位）。
    if (source && !opts.noKeywords) {
      onDealtDamage(state, source, null, finalAmount, { kingSide: target.side });
    }
    // 阵营超能力：国王血量掉到 15 / 9 / 3 以下时各抽一张（作者 2026-10-03）。
    // 不放在上面的 source 判断里  自己对自己造成的伤害（召唤仪式）也该照抽。
    checkSuperpowerThresholds(state, target.side);
  } else {
    const unit = target.unit;
    if (unit.removed) return 0;
    unit.hp -= finalAmount;
    unit.lastDamageSource = source ? source.uid : null;
    // 带上位置：界面要按格子放「掉字」单位被打死之后就已经不在棋盘上了，光有 uid 找不到格子。
  log(state, { type: 'damage', uid: unit.uid, amount: finalAmount, hp: unit.hp, source: source ? source.uid : null, lane: unit.lane, side: unit.side, row: unit.row });

    // ── 荆棘：按「最终伤害」对来源反弹（裁决 B6）
    //    虚拟来源（带词条的锦囊）不在棋盘上，反弹它没有意义，直接跳过 ——
    //    否则会去扣一个不存在单位的血、还把它塞进弃牌堆。
    const thorns = getKw(unit, 'thorns');
    if (thorns && thorns.x > 0 && source && !opts.noThorns && !source.virtual) {
      log(state, { type: 'thorns', uid: unit.uid, x: thorns.x, source: source.uid });
      dealDamage(state, unit, { kind: 'unit', unit: source }, thorns.x, {
        noThorns: true, noCrit: true, noKeywords: true,
      });
    }

    // ── 造成伤害时触发的词条（仅当来源是单位，且伤害 > 0）
    if (source && !opts.noKeywords) {
      onDealtDamage(state, source, unit, finalAmount);
    }

    // ── 「受到伤害:」异能（卡牌「红火蚁：每扣除1♥,便对指定单位造成1点伤害」）
    //    payload 带 amount，配合 effect.repeat='damageAmount' 可以「每点触发一次」。
    //    防死循环：由 onDamaged 异能自己造成的伤害不再触发 onDamaged。
    if (!opts.noDamagedTrigger) {
      queueTrigger(state, unit, 'onDamaged', { amount: finalAmount, sourceUid: source ? source.uid : null });
    }

    // ── 「有敌人受到伤害时」的观察者（鲨鱼 / 怨魂）
    if (!opts.noWatchers) notifyDamageWatchers(state, unit);

    // ── 生命归零 → 消灭
    // 开战批次中挂起，等整条线路的伤害全部结算完再统一处理死亡，
    // 这样「同一线路内同时结算」才成立（否则先算的单位会抢先杀掉后算的单位）。
    if (unit.hp <= 0) {
      if (opts.deferDeath) {
        if (!state._pendingDeaths.includes(unit)) state._pendingDeaths.push(unit);
      } else {
        destroyUnit(state, unit, 'lethal-damage');
      }
    }
  }

  return finalAmount;
}

/**
 * 「造成伤害:」异能 与 淬毒 / 疾病 的共同入口。
 *
 * victim 为 null 表示这次伤害打的是**国王**（opts.kingSide 说明是哪一方）：
 *   · 「造成伤害:」异能照常触发
 *   · 「淬毒」照常挂到国王身上（标记记在玩家对象上）、「疾病」不触发（国王不是单位）
 */
export function onDealtDamage(state, source, victim, amount, opts = {}) {
  if (amount <= 0) return;

  // victim 为 null 时用 opts.kingSide 指明「打的是哪一方国王」（国王中毒要用）。
  const kingSide = victim ? null : (opts.kingSide === undefined ? null : opts.kingSide);

  if (victim || kingSide !== null) {
    const poison = getKw(source, 'poison');
    if (poison && poison.x > 0) {
      const mark = { type: 'poison', x: poison.x, sourceUid: source.uid, appliedTurn: state.turn };
      if (victim) {
        victim.marks.push(mark);
        log(state, { type: 'poison-applied', uid: victim.uid, x: poison.x });
      } else {
        state.players[kingSide].kingMarks.push(mark);
        log(state, { type: 'poison-applied', kingSide, x: poison.x });
      }
    }

    if (victim && hasKw(source, 'disease')) {
      victim.marks.push({ type: 'disease', sourceUid: source.uid, appliedTurn: state.turn });
      log(state, { type: 'disease-applied', uid: victim.uid });
    }
  }

  queueTrigger(state, source, 'onDealDamage', {
    victimUid: victim ? victim.uid : null,
    // ⚠️ 必须带**对象**，不能只带 uid：「造成伤害:弹射那名敌人」这类效果
    // 靠 triggerVictim 取受害者，只给 uid 的话它会静默返回空 ——
    // 表现是「效果看起来挂上了，但什么都没发生」。
    victim,
    toKing: !victim,
    amount,
  });
}

/**
 * 「有敌人受到伤害时，对其造成1点伤害」—— 鲨鱼 / 怨魂。
 *
 * 这是一个**观察者**触发器，和「造成伤害:」（由攻击方触发）不同：
 * 它不关心伤害是谁造成的，只要**敌方单位**掉血就触发，包括：
 *   · 被敌方单位交战打伤
 *   · 被自己的法术打伤
 *   · 被荆棘反弹打伤
 *
 * 两条已裁决的边界：
 *   1. **不含国王**。国王不是单位，如果让它也触发，血量 20 的国王会被
 *      每个观察者放大一遍伤害，滚雪球过于严重（待作者确认，见裁决 D21）。
 *   2. **不连锁**。观察者自己造成的这点伤害不会再惊动其他观察者，
 *      否则「怨魂 A ↔ 怨魂 B」会无限互相触发。由 opts.noWatchers 实现。
 */
export function notifyDamageWatchers(state, victim) {
  if (!victim || victim.removed) return;
  for (const watcher of allUnits(state)) {
    if (watcher.removed) continue;
    if (watcher.side === victim.side) continue;
    const effects = watcher.effects || [];
    if (!effects.some((e) => e.trigger === 'onEnemyDamaged')) continue;
    queueTrigger(state, watcher, 'onEnemyDamaged', { victim });
  }
}

// ─────────────────────────────────────────────────────────
// 触发队列
// ─────────────────────────────────────────────────────────

/**
 * 把单位的某个异能放进触发队列。
 * 真正的执行由 engine.js 的 flushTriggers 完成，避免机制层反向依赖效果层。
 *
 * 注意：这里存的是**单位对象的引用**而不是 uid。
 * 因为「被消灭:」异能需要在单位已经离开战场之后仍然能执行，
 * 按 uid 反查会查不到（单位已从 board 上摘除）。
 */
export function queueTrigger(state, unit, triggerName, payload = {}) {
  state.triggerQueue.push({ unit, triggerName, payload });
}

/**
 * 国王附着的异能入队（卡牌「战略纵深」）。
 * 与 queueTrigger 的区别：来源不是单位，而是某个玩家编号。
 */
export function queueKingTrigger(state, side, triggerName, payload = {}) {
  state.triggerQueue.push({ kingSide: side, triggerName, payload });
}

export function healUnit(state, unit, amount) {
  if (!unit || unit.removed || amount <= 0) return;
  const before = unit.hp;
  unit.hp = Math.min(unit.maxHp, unit.hp + amount);
  log(state, { type: 'heal', uid: unit.uid, from: before, to: unit.hp });
  checkNimble(state, unit);
}

/**
 * 回复国王生命。
 *
 * 注意：这修订了《裁决清单》里的 C3（原建议「国王不可被治疗」）——
 * 卡片「蚊子」明确要求为自己的国王回血，所以国王可被治疗，
 * 但**上限仍是 kingMaxHp（20）**，且已败北的国王不回血。
 */
export function healKing(state, side, amount) {
  if (amount <= 0) return;
  const p = state.players[side];
  if (p.kingHp <= 0) return;
  const before = p.kingHp;
  p.kingHp = Math.min(p.kingMaxHp, p.kingHp + amount);
  log(state, { type: 'king-heal', side, from: before, to: p.kingHp, amount: p.kingHp - before });
}



/**
 * 降低生命上限并同时扣掉等量当前生命（卡牌「骨折：-2攻-1血」）。
 *
 * 与「伤害」的区别很重要：
 *   · 这是**数值修改**，不是伤害 → 不触发装甲/祝福/荆棘，
 *     也不惊动「有敌人受到伤害时」的观察者（鲨鱼/怨魂）。
 *   · 生命被扣到 0 或以下 → 单位被消灭（正常走 onDeath）。
 */
export function debuffMaxHp(state, unit, amount) {
  if (!unit || unit.removed || amount <= 0) return;
  unit.maxHp = Math.max(0, unit.maxHp - amount);
  unit.hp -= amount;
  log(state, { type: 'debuff-maxhp', uid: unit.uid, amount, maxHp: unit.maxHp, hp: unit.hp });
  if (unit.hp <= 0) {
    destroyUnit(state, unit, 'stat-loss');
    return;
  }
  checkNimble(state, unit);
}


/**
 * 把单位数值**设为固定值**（不是加减）。
 * 用于「♥变为4」这类写法。`maxHp` 变小到低于当前生命时，当前生命跟着降；降到 0 就消灭。
 */
export function setUnitStats(state, unit, { hp, maxHp, atk }) {
  if (!unit || unit.removed) return;
  if (atk !== undefined) unit.atk = Math.max(0, atk);
  if (maxHp !== undefined) unit.maxHp = Math.max(0, maxHp);
  if (hp !== undefined) unit.hp = hp;
  if (unit.hp > unit.maxHp) unit.hp = unit.maxHp;
  log(state, { type: 'set-stats', uid: unit.uid, hp: unit.hp, maxHp: unit.maxHp, atk: unit.atk });
  if (unit.hp <= 0) { destroyUnit(state, unit, 'stat-set'); return; }
  checkNimble(state, unit);
}

/**
 * 「依次变为」（卡牌「劫匪团队：受到伤害:依次变为:3/2、2/1」）。
 * 每次触发往后走一格，走到末尾就停在最后一格。
 */
export function advanceStatStep(state, unit, steps) {
  if (!unit || unit.removed || !steps || !steps.length) return;
  const cur = unit.statStep === undefined ? -1 : unit.statStep;
  unit.statStep = Math.min(cur + 1, steps.length - 1);
  const s = steps[unit.statStep];
  setUnitStats(state, unit, { atk: s.atk, hp: s.hp, maxHp: s.hp });
  log(state, { type: 'stat-step', uid: unit.uid, step: unit.statStep, atk: s.atk, hp: s.hp });
}

/**
 * 这一回合对某个来源阵营的伤害封顶（卡牌「反应装甲：本回合,所有敌方卡牌造成的伤害至多为X」）。
 * 返回封顶值；没有限制时返回 null。
 */
export function damageCapFor(state, sourceSide) {
  for (const cap of state.damageCaps || []) {
    if (cap.turn !== state.turn) continue;
    if (cap.side !== sourceSide) continue;
    return cap.value;
  }
  return null;
}

/** 登记一条本回合的伤害封顶 */
export function addDamageCap(state, side, value, turns = 1) {
  if (!Array.isArray(state.damageCaps)) state.damageCaps = [];
  state.damageCaps.push({ side, value, turn: state.turn + turns - 1 });
  log(state, { type: 'damage-cap', side, value, untilTurn: state.turn + turns - 1 });
}

/**
 * 轻灵的状态检查：失去两栖且在水路 → 消灭。
 * 每一次生命变动之后都必须调用（规则书 §5.3 / 词条 nimble）。
 */
export function checkNimble(state, unit) {
  if (!unit || unit.removed) return;
  if (nimbleShouldDrown(unit)) {
    log(state, { type: 'nimble-drown', uid: unit.uid });
    destroyUnit(state, unit, 'nimble-drown');
  }
}

/** 对棋盘上所有单位做一次轻灵状态检查 */
export function checkAllNimble(state) {
  for (const unit of allUnits(state)) checkNimble(state, unit);
}

/**
 * 陷阱的触发点：伤害要落到某一方身上时，先看那一方有没有埋着没触发的陷阱。
 *
 * 目前只有「反应装甲」（U371，词条 陷阱）这一张陷阱卡，所以按卡 id 分派；
 * 以后加陷阱卡时在这里补一条（或在卡上加 trigger 字段再通用化）。
 * 反应装甲的口径（作者 2026-10）：
 *    触发后**本回合内**所有敌方造成的伤害至多为 2（且是**单次**封顶，不是累计）；
 *    触发时揭示，本回合效果结束（回合末）就消失（见 board.js 的 expireRevealedTraps）。
 */
function triggerTrapOnDamage(state, source, target) {
  if (!source || !target) return null;
  const victimSide = target.kind === "king" ? target.side : (target.unit ? target.unit.side : null);
  if (victimSide === null || source.side === victimSide) return null;
  for (const { lane, trap } of trapsOf(state, victimSide)) {
    if (trap.revealed) continue;
    if (trap.cardId !== "U371") continue;
    trap.revealed = true;
    trap.expiresTurn = state.turn;
    addDamageCap(state, source.side, 2, 1);
    log(state, { type: "trap-triggered", side: victimSide, lane, cardId: trap.cardId, cap: 2 });
    return trap;
  }
  return null;
}
