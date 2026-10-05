/**
 * 场地与单位：日志、单位查询、站位/移动/弹射、以及「被弹射时」的观察者。
 *
 * 从 mechanics.js 拆出（纯搬移，行为不变）：
 *   log / findUnit / laneUnits / allUnitsInLane / allUnits / enemyFrontUnit /
 *   enemyCombatTarget / findBodyguard / removeUnitFromBoard / destroyUnit /
 *   vanishUnit / canMoveTo / moveUnitToLane / bounceUnit / notifyBounceWatchers
 *
 * 依赖方向：constants/keywords/rng ← board ← damage/stats
 */

import { LANES, ROWS, SIDE, KING_MAX_HP, REBIRTH_HP } from './constants.js';
import { getKw, hasKw, isFrozen, computeFinalDamage, nimbleShouldDrown, parseKeyword, canPlaceInLane, isUntargetable } from './keywords.js';
import { chance, shuffle } from './rng.js';
// ⚠ board ←→ damage 是一个**函数声明的环**：board 要 queueTrigger / queueKingTrigger，
//   damage 要 destroyUnit。两边都只有函数声明（没有加载期求值的顶层 const），
//   ESM 与打包器都能靠函数提升正常工作；不要往这两个文件里加顶层 const 互相引用。
import { queueTrigger, queueKingTrigger } from './damage.js';

/** 统一写日志 */
export function log(state, entry) {
  state.log.push({ turn: state.turn, phase: state.phase, ...entry });
}

/** 找到单位对象（按 uid） */
export function findUnit(state, uid) {
  for (const lane of LANES) {
    for (const side of [0, 1]) {
      for (const row of ROWS) {
        const u = state.board[lane].units[side][row];
        if (u && u.uid === uid) return u;
      }
    }
  }
  return null;
}

/** 某条线路上某一方的全部单位，顺序固定为 前排 → 后排（用于穿透等） */
export function laneUnits(state, lane, side) {
  const slot = state.board[lane].units[side];
  const out = [];
  for (const row of ROWS) if (slot[row]) out.push(slot[row]);
  return out;
}

/** 某条线路上双方全部单位 */
export function allUnitsInLane(state, lane) {
  return [...laneUnits(state, lane, 0), ...laneUnits(state, lane, 1)];
}

/** 棋盘上全部单位 */
export function allUnits(state) {
  const out = [];
  for (const lane of LANES) out.push(...allUnitsInLane(state, lane));
  return out;
}

/** 敌方**前排**单位。用于「穿透」这类需要区分前后排的效果 */
export function enemyFrontUnit(state, lane, side) {
  return state.board[lane].units[1 - side].front || null;
}

/**
 * 普通交战的攻击目标：**前排 → 后排 → 国王**。
 *
 * 前排是掩护：只要敌方前排还站着，普通攻击就只能打前排；
 * 前排一旦清空，后排就暴露出来，会被普通攻击命中；
 * 前后排都没人，才轮到国王。
 *
 * 注意这修订了早期版本的行为 —— 那时前排为空会**直接跳到国王**，
 * 把后排整个忽略掉（作者报的 bug）。
 * 「溅射」和「穿透」不受此限制：它们在前排还在时也能打到后排。
 *
 * 返回单位对象；整条线路没有敌方单位时返回 null（调用方改打国王）。
 */
export function enemyCombatTarget(state, lane, side) {
  const foe = state.board[lane].units[1 - side];
  // 两种「略过这张牌」，行为一致，来源不同：
  //   · 「任何单位攻击时将略过这张牌」（卡牌「蜜蜂」）→ 卡上的数据字段 `bypassInCombat`
  //   · 「无法选中」（卡牌「神威」）→ 作者 2026-10：「开战回合时这条线上
  //     敌方单位的攻击将略过这张牌」——标记挂在单位身上，所以这里也要略过它
  for (const row of ROWS) {
    const u = foe[row];
    if (!u) continue;
    if (u.bypassInCombat || isUntargetable(u)) continue;
    return u;
  }
  return null;
}

/**
 * 「这张牌将为后方的单位承受伤害」（卡牌「伪装土堆」）：
 * 同线路**前排**站着一个带 `bodyguard` 的单位时，打向它后排友军的伤害改由它承受。
 * 只处理「前排替后排挨打」这一种方向 —— 这是卡面唯一写明的。返回代收者或 null。
 */
export function findBodyguard(state, unit) {
  if (!unit || unit.removed || unit.row !== 'back') return null;
  const front = state.board[unit.lane].units[unit.side].front;
  if (front && front !== unit && front.bodyguard && !front.removed) return front;
  return null;
}

/** 把单位从棋盘上移除 */
export function removeUnitFromBoard(state, unit) {
  const slot = state.board[unit.lane].units[unit.side];
  if (slot[unit.row] && slot[unit.row].uid === unit.uid) slot[unit.row] = null;
}

/**
 * 「消灭」一个单位（不是伤害，因此可以消灭无敌单位 —— 裁决 B7）。
 * 会触发该单位的 onDeath 异能，以及**其控制者国王身上附着的**
 * 「友方单位被消灭时」异能（卡牌「战略纵深」）。
 *
 * 「复生」会在这里拦一道：带复生的单位第一次被消灭时原处复活，
 * 并失去复生（作者补充规则）。见下方注释里的取舍说明。
 */
export function destroyUnit(state, unit, reason = 'destroy') {
  if (!unit || unit.removed) return;

  // ── 复生（作者补充规则 + 已裁决细节）
  //
  // 作者裁决：
  //   · 复活**回满血**
  //   · **不触发**「被消灭:」异能，也不触发国王的「友方单位被消灭时」被动
  //     （否则复生等于「免死 + 白嫖一次死亡异能」）
  //   · 复活不触发打出效果
  if (hasKw(unit, 'rebirth')) {
    unit.keywords = unit.keywords.filter((k) => k.id !== 'rebirth');
    unit.hp = Math.min(REBIRTH_HP, unit.maxHp);
    unit.marks = [];
    unit.lastDamageSource = null;
    log(state, {
      type: 'rebirth', uid: unit.uid, cardId: unit.cardId,
      lane: unit.lane, row: unit.row, side: unit.side, hp: unit.hp, reason,
    });
    return;
  }

  unit.removed = true;
  removeUnitFromBoard(state, unit);
  state.discard.push(unit.cardId);
  state.stats.unitsDestroyed++;   // 全局计数（卡牌「卫兵：4个单位被消灭后…」要读它）
  // 带上卡名：战报要显示「哪张卡被消灭」。只给 cardId 的话界面上会出现 U401 这种内部编号。
  const destroyName = (state.cardLib[unit.cardId] || {}).name || unit.cardId;
  log(state, { type: 'destroy', uid: unit.uid, cardId: unit.cardId, name: destroyName, lane: unit.lane, row: unit.row, side: unit.side, reason });
  queueTrigger(state, unit, 'onDeath', { reason });

  // 国王附着的被动（「战略纵深」：友方单位被消灭时抽一张牌）
  const owner = state.players[unit.side];
  for (const eff of owner.kingEffects || []) {
    if (eff.trigger === 'onFriendlyUnitDestroyed') {
      queueKingTrigger(state, unit.side, eff.trigger, { unit, reason });
    }
  }

  // 「全场有单位被消灭时」的观察者（卡牌「卫兵」靠它 + when:{deathsAtLeast:4} 判定）
  for (const watcher of allUnits(state)) {
    if (watcher.removed) continue;
    if (!(watcher.effects || []).some((e) => e.trigger === 'onAnyUnitDestroyed')) continue;
    queueTrigger(state, watcher, 'onAnyUnitDestroyed', { victim: unit, reason });
  }

  /**
   * 「献祭」是我方主动消灭自己人（作者 2026-10-03）：
   * 除了正常的被消灭效果，再给同侧、带 onAllySacrificed 异能的单位排一个触发
   * （恶魔虚影靠「我方每被献祭一个单位」成长）。
   */
  if (reason === 'sacrifice') {
    for (const watcher of allUnits(state)) {
      if (watcher.removed || watcher.side !== unit.side) continue;
      if (!(watcher.effects || []).some((e) => e.trigger === 'onAllySacrificed')) continue;
      queueTrigger(state, watcher, 'onAllySacrificed', { victim: unit });
    }
  }
}

/**
 * 主动献祭一名己方单位（作者 2026-10-03：恶魔阵营的玩家在「结束回合」左边多一个
 * 献祭按钮，可以把场上任一己方单位献祭；献祭算作被消灭，会触发被消灭效果）。
 * 供界面调用；与卡牌的 sacrifice 动作走同一条 destroyUnit 路径。返回是否成功。
 */
export function sacrificeUnitOnBoard(state, side, uid) {
  const unit = findUnit(state, uid);
  if (!unit || unit.removed || unit.side !== side) return false;
  destroyUnit(state, unit, 'sacrifice');
  return true;
}

/**
 * 「使其消失」—— 融合进化把被顶掉的友方单位移走。
 *
 * 与 destroyUnit 的关键区别：**什么被消灭效果都不触发**（作者明确要求），
 * 包括该单位的 onDeath 和国王的「友方单位被消灭时」被动。
 * 单位仍然进弃牌堆（它确实离场了）。
 */
export function vanishUnit(state, unit, reason = 'fuse') {
  if (!unit || unit.removed) return;
  unit.removed = true;
  removeUnitFromBoard(state, unit);
  state.discard.push(unit.cardId);
  log(state, {
    type: 'vanish', uid: unit.uid, cardId: unit.cardId,
    lane: unit.lane, row: unit.row, side: unit.side, reason,
  });
}

/**
 * 能不能把 unit 移到 lane —— 只判定，不改状态（给界面/AI 列可选项用）。
 * moveUnitToLane 也走这个判定，两处口径永远一致。
 *
 * ⚠ **移动和放置走同一套地形规则**（作者 2026-09 裁决）。以前这里只管
 *   扎根/占位，完全不看地形，于是任何单位都能被「捕猎」「移动」类效果
 *   塞进水路 —— 水生单位也能被移出水面。两种情况都是错的。
 *   现在直接复用 canPlaceInLane，两处口径再也不会分叉：
 *     · 有「水生」→ 只能去水路
 *     · 有「两栖」（含轻灵达标）→ 任意线路
 *     · 其余 → 不能进水路
 */
export function canMoveTo(state, unit, lane, opts = {}) {
  if (!unit || unit.removed) return false;
  if (!LANES.includes(lane)) return false;
  if (unit.lane === lane) return false;

  // 地形：水生只能水路、两栖任意、其余不能进水路
  if (!canPlaceInLane(unit, lane)) return false;

  const rooted = opts.isRooted ? opts.isRooted(unit) : hasKw(unit, 'rooted');
  if (rooted) return false;

  const slot = state.board[lane].units[unit.side];
  if (slot[unit.row]) return false;
  const existing = ROWS.map((r) => slot[r]).filter(Boolean);
  if (existing.length >= 1) {
    const ok = existing.some((u) => hasKw(u, 'combo')) || hasKw(unit, 'combo');
    if (!ok) return false;
  }
  return true;
}

/**
 * 把单位移到另一条线路（「捕猎」用，也是被搁置很久的「移动」机制的第一个用途）。
 *
 * 保持原来的排（前排/后排）。移动不成功就原地不动 —— 返回 false。
 * 挡住移动的情况见 canMoveTo。
 */
export function moveUnitToLane(state, unit, lane, opts = {}) {
  if (!canMoveTo(state, unit, lane, opts)) return false;

  const from = unit.lane;
  removeUnitFromBoard(state, unit);
  unit.lane = lane;
  state.board[lane].units[unit.side][unit.row] = unit;
  log(state, { type: 'move', uid: unit.uid, from, to: lane, row: unit.row });
  // 「进入一条线:」异能（卡牌「抱脸虫」）—— 移动也算进入
  queueTrigger(state, unit, 'onEnterLane', { from, lane });
  return true;
}

/**
 * 「弹射」——作者裁决：**把单位退回其拥有者的手牌**（不是消灭）。
 *
 * 这正是「扎根」的克星：`扎根 = 无法被弹射`，所以带扎根的单位弹不动。
 * 退回手牌的是一张**新的手牌实例**（iid 重新分配），原单位从棋盘上摘掉。
 * 不算「被消灭」：不触发 onDeath，也不惊动国王的「友方单位被消灭时」。
 *
 * 返回是否真的弹走了。
 */
export function bounceUnit(state, unit, opts = {}) {
  if (!unit || unit.removed) return false;
  const rooted = opts.isRooted ? opts.isRooted(unit) : hasKw(unit, 'rooted');
  if (rooted) return false;

  // 手牌上限不做限制（规则书未定义），直接加进去
  const owner = state.players[unit.side];
  const cardId = unit.cardId;
  const from = { lane: unit.lane, row: unit.row };

  // 「回手后保留加成」：把已经长在场上单位身上的数值差额记到**回手的那张牌**上，
  // 之后重新打出时会由 applyHandStatDelta 重新加上去。
  // ⚠️ 2026-09 改卡之后**没有卡在用**这个选项了（扫地僧改成「打出时按进场次数加成」，
  //    回手不再保留加成）。机制留着给以后的卡用：要用就在 actions 里写 preserveStats: true。
  const def = state.cardLib[cardId] || {};
  const keep = {};
  if (opts.keepStats) {
    const dAtk = unit.atk - (def.atk || 0);
    const dHp = unit.maxHp - (def.hp || 0);
    if (dAtk) keep.atk = dAtk;
    if (dHp) keep.maxHp = dHp;
  }

  vanishUnit(state, unit, 'bounce');
  const handCard = { iid: state.nextIid++, cardId };
  if (keep.atk || keep.maxHp) handCard.statDelta = keep;
  owner.hand.push(handCard);
  log(state, { type: 'bounce', cardId, side: unit.side, lane: from.lane, row: from.row, keep });
  // 「有单位被弹射时:」（卡牌「跳杆运动员」）—— 全场监听，和「有敌人受到伤害时」一个路子
  notifyBounceWatchers(state, unit);
  return true;
}

/** 「有单位被弹射时:」的观察者通知。不连锁（弹射不会由弹射产生）。 */
export function notifyBounceWatchers(state, bounced) {
  if (!bounced) return;
  for (const watcher of allUnits(state)) {
    if (watcher.removed) continue;
    const effects = watcher.effects || [];
    if (!effects.some((e) => e.trigger === 'onUnitBounced')) continue;
    queueTrigger(state, watcher, 'onUnitBounced', { bounced, bouncedSide: bounced.side });
  }
}

// 
// 陷阱（作者 2026-10 口径）
//    单位回合 / 锦囊回合都能打出；**不算打出卡牌**
//    按线路从左到右自动放进陷阱格；每方最多两个，满了不能再用
//    没触发的陷阱，到「下一回合的**同类型**阶段」回手
//    触发后本回合内持续有效，效果结束（回合末）才消失
//    费用照付，但**未揭示的陷阱花费在敌方视角里要加回去**（见 visibleMana）
// 

/** 每方最多同时有几个陷阱（作者口径：两个，填满不能再用） */
export const TRAP_MAX = 2;

/** 这个卡牌定义是不是陷阱：词条带 `trap`，或 type 直接是 'trap' */
export function isTrapCard(def) {
  if (!def) return false;
  if (def.type === 'trap') return true;
  return (def.keywords || []).some((k) => {
    const id = typeof k === 'string' ? k.split(':')[0] : (k && k.id);
    return id === 'trap';
  });
}

/**
 * 某一方现在埋着的陷阱，按**线路从左到右**的顺序返回 `[{ lane, trap }]`。
 * 陷阱格复用 `board[lane].traps[side]`（makeBoard 里本来就有这个位置）。
 */
export function trapsOf(state, side) {
  const out = [];
  for (const lane of LANES) {
    const t = state.board[lane].traps[side];
    if (t) out.push({ lane, trap: t });
  }
  return out;
}

/**
 * 把一张陷阱埋伏进该方**最左边空着**的陷阱格。
 * 返回埋进的那条线路；已经埋满两个则返回 null（调用方负责拒绝这次出牌）。
 */
export function placeTrap(state, side, cardId, paid) {
  if (trapsOf(state, side).length >= TRAP_MAX) return null;
  for (const lane of LANES) {
    if (state.board[lane].traps[side]) continue;
    state.board[lane].traps[side] = {
      cardId,
      owner: side,
      paid: paid || 0,
      placedTurn: state.turn,
      // 打出时是单位回合还是锦囊回合  回手要按「同类型阶段」算
      phaseKind: state.phase && state.phase.startsWith('DEPLOY') ? 'deploy' : 'spell',
      revealed: false,
      expiresTurn: null,
    };
    log(state, { type: 'trap-placed', side, lane, cardId });
    return lane;
  }
  return null;
}

/** 该方**未揭示**的陷阱一共花了多少钱（敌方视角要加回去的那部分） */
export function hiddenTrapMana(state, side) {
  let sum = 0;
  for (const { trap } of trapsOf(state, side)) if (!trap.revealed) sum += trap.paid || 0;
  return sum;
}

/**
 * 某个玩家**在敌方视角下**的费用。
 *  只给界面显示用：引擎里所有的费用判定一律读 `players[side].mana` 的真值
 *    这是「让对方看不见」，不是「真的没花」。
 */
export function visibleMana(state, side) {
  return state.players[side].mana + hiddenTrapMana(state, side);
}

/**
 * 阶段开始时的收尾：**没触发过**的陷阱，如果已经到了「下一回合的同类型阶段」，
 * 就回到它主人的手牌（作者口径：单位回合打的，下个回合的单位回合回手）。
 */
export function returnExpiredTraps(state, kind) {
  for (const side of [0, 1]) {
    for (const { lane, trap } of trapsOf(state, side)) {
      if (trap.revealed) continue;
      if (trap.phaseKind !== kind) continue;
      if (state.turn <= trap.placedTurn) continue;   // 同一个回合内不回手
      state.board[lane].traps[side] = null;
      state.players[side].hand.push({ iid: state.nextIid++, cardId: trap.cardId });
      log(state, { type: 'trap-returned', side, lane, cardId: trap.cardId });
    }
  }
}

/** 回合结束：已经触发过（本回合生效）的陷阱，效果结束就消失 */
export function expireRevealedTraps(state) {
  for (const side of [0, 1]) {
    for (const { lane, trap } of trapsOf(state, side)) {
      if (!trap.revealed) continue;
      if (trap.expiresTurn !== null && state.turn >= trap.expiresTurn) {
        state.board[lane].traps[side] = null;
        log(state, { type: 'trap-gone', side, lane, cardId: trap.cardId });
      }
    }
  }
}