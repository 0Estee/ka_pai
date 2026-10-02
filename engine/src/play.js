/**
 * 出牌与合法性：费用、可打的牌、落点判定，以及打出/召唤的结算入口。
 *
 * 从 engine.js 拆出（纯搬移，行为不变）：
 *   costOf / getLegalPlays / legalPlacements / canPlaceUnit / playCard /
 *   notifyAllyPlayed / notifyEnemyCastSpell / resolveHunt
 *
 * 依赖方向：mechanics ← setup ← play ← choices/combat
 */

import {
  LANES, ROWS, SIDE, SIDE_NAME, LANE_NAME, PHASES, PHASE_ACTOR,
  PHASE_ALLOWED_CARD_TYPE, CARD_TYPE, KING_MAX_HP, MAX_TURNS, ADJACENT_LANES,
  manaCapForTurn, DRAW_ON_FIRST_TURN, roleName,
} from './constants.js';
import { createRng, shuffle } from './rng.js';
import { parseKeyword, getKw, hasKw, canPlaceInLane } from './keywords.js';
import * as M from './mechanics.js';
import { effectiveAtk, hasRooted, hasKeyword, getKeyword, isSealedByAura } from './auras.js';
import { execActions } from './effects.js';
import { instantiateUnit, probeFromDef } from './setup.js';
import { isTrapCard, placeTrap, TRAP_MAX } from './board.js';
import { isOver, getActor, checkGameOver, triggerInHandEffects, applyHandStatDelta } from './turns.js';
import { apiFor, applySummonModify } from './combat.js';
import { flushTriggers, driveGenerator } from './choices.js';

// ══════════════════════════════════════════════════════════
// 合法性
// ══════════════════════════════════════════════════════════

/**
 * 一张手牌的**实际费用** = 卡面费用 + 这张牌实例上的修正。
 *
 * 「-1 花费」这类效果（神秘礼物 / 僵尸 / 歼-10 / 黑龙）写在**手牌实例**上，
 * 不是写在卡牌定义上 —— 同一张卡的不同副本可以有不同费用。
 * ⚠️ 合法性校验、界面显示、AI 评估三处都必须走这个函数，
 *    漏一处就会出现「看起来付得起、点下去报错」。
 */
export function costOf(state, handCard) {
  if (!handCard) return 0;
  const def = state.cardLib[handCard.cardId];
  if (!def) return 0;
  return Math.max(0, def.cost + (handCard.costDelta || 0));
}

/**
 * 某方当前可以打出的所有牌及合法位置。
 * 返回 [{ iid, cardId, cost, places:[{lane,row}|null] }]
 */
export function getLegalPlays(state, side) {
  if (isOver(state) || state.pending) return [];
  if (getActor(state) !== side) return [];

  const allowedType = PHASE_ALLOWED_CARD_TYPE[state.phase];
  const p = state.players[side];
  const out = [];

  for (const handCard of p.hand) {
    const def = state.cardLib[handCard.cardId];
    if (!def) continue;
    if (def.type !== allowedType) continue;
    const cost = costOf(state, handCard);
    if (cost > p.mana) continue;

    const places = def.type === CARD_TYPE.UNIT
      ? legalPlacements(state, side, def)
      : [null];
    if (places.length === 0) continue;

    out.push({ iid: handCard.iid, cardId: handCard.cardId, cost, places });
  }
  return out;
}

export function legalPlacements(state, side, def) {
  const probe = probeFromDef(def);
  // 「融合进化」：允许把这张牌打在**已有友方单位的位置上**（那个单位会消失）
  const fuse = hasKw(probe, 'fuse');
  const places = [];
  for (const lane of LANES) {
    if (!canPlaceInLane(probe, lane)) continue;
    for (const row of ROWS) {
      if (canPlaceUnit(state, side, probe, lane, row, { allowFuse: fuse })) places.push({ lane, row });
    }
  }
  return places;
}

/**
 * 占位规则（裁决 D4）：
 *   每路每方默认只能放 1 个（任选前排或后排）；
 *   已有单位带「组合」，或新单位带「组合」时，可放第 2 个（前后排各 1）。
 *
 * opts.allowFuse = true（「融合进化」）：格子上有己方单位也算合法 ——
 *   那个单位会被「消失」掉，新单位顶替它的位置。因为是把人换掉而不是多占一个位，
 *   所以不受「每路 1 个」的限制。
 */
export function canPlaceUnit(state, side, probe, lane, row, opts = {}) {
  // 地形封锁（卡牌「氢弹：令平地不可放置单位一回合」）
  // 判定口径：被封锁的线路在 `state.turn <= untilTurn` 期间不能放置任何单位。
  const lock = (state.laneLocks || {})[lane];
  if (lock !== undefined && state.turn <= lock) return false;

  const slot = state.board[lane].units[side];
  if (slot[row]) return opts.allowFuse === true;
  const existing = ROWS.map((r) => slot[r]).filter(Boolean);
  if (existing.length === 0) return true;
  if (existing.length >= 2) return false;
  const existingHasCombo = existing.some((u) => hasKeyword(state, u, 'combo'));
  const newHasCombo = hasKeyword(state, probe, 'combo');
  return existingHasCombo || newHasCombo;
}

// ══════════════════════════════════════════════════════════
// 出牌
// ══════════════════════════════════════════════════════════

/**
 * @param {object} state
 * @param {number} side
 * @param {number} iid                手牌实例 id
 * @param {object} opts               { lane, row, targetUid, choices }
 */
export function playCard(state, side, iid, opts = {}) {
  if (isOver(state)) throw new Error('对局已结束');
  if (state.pending) throw new Error('存在待处理的交互请求，请先 resolveChoice');

  const actor = getActor(state);
  if (actor !== side) throw new Error(`现在是「${state.phase}」阶段，应由${roleName(state, actor)}行动`);

  const allowedType = PHASE_ALLOWED_CARD_TYPE[state.phase];
  const p = state.players[side];
  const idx = p.hand.findIndex((c) => c.iid === iid);
  if (idx < 0) throw new Error(`手牌中没有 iid=${iid}`);

  const handCard = p.hand[idx];
  const def = state.cardLib[handCard.cardId];
  if (!def) throw new Error(`卡牌库缺少卡牌定义: ${handCard.cardId}`);
  // 陷阱是例外：作者口径「单位回合或锦囊回合都能打出」，所以不受阶段类型限制
  if (def.type !== allowedType && !isTrapCard(def)) throw new Error(`本阶段只能打出「${allowedType}」，不能打出「${def.type}」`);
  const cost = costOf(state, handCard);
  if (cost > p.mana) throw new Error(`费用不足：需要 ${cost}，剩余 ${p.mana}`);

  //  陷阱（作者 2026-10 口径）：陷阱不是「打出卡牌」，而是**埋伏**进陷阱格里。
  //    所以这里要在 `cardsPlayed++` 与「在手牌中」被动之前拦下来：
  //       不计入打出张数（人间大炮的「有队友被打出时」不会响）
  //       不触发「在手牌中」的被动
  //       不广播「敌方打出锦囊」
  //    费用照付；效果等触发条件达成时再由 damage.js / 后续牌结算。
  if (isTrapCard(def)) {
    const lane = placeTrap(state, side, handCard.cardId, cost);
    if (lane === null) throw new Error(`陷阱格已满（每方最多 ${TRAP_MAX} 个），不能再用陷阱`);
    p.hand.splice(idx, 1);
    p.mana -= cost;
    return { trap: lane };
  }


  p.hand.splice(idx, 1);
  p.mana -= cost;
  state.stats.cardsPlayed++;

  // 「在手牌中:在你出牌时…」（卡牌「黑龙」）—— 打出任意一张牌时，
  // 手上带这条异能的牌先结算一次。放在「移出手牌之后」，
  // 所以它自己被派出去的那一次不会触发它自己。
  triggerInHandEffects(state, side);

  if (Array.isArray(opts.choices)) state.choiceQueue.push(...opts.choices);

  const ctx = {
    state,
    controller: side,
    card: def,
    source: null,
    chosenLane: opts.lane ?? null,
    chosenTargetUid: opts.targetUid ?? null,
    // 目标指定为「国王」（用于"敌方单位或国王"这类复合选择器）
    chosenTargetIsKing: opts.targetKing === true,
    api: apiFor(state),
  };

  if (def.type === CARD_TYPE.UNIT) {
    const { lane, row } = opts;
    if (!lane || !row) throw new Error('放置单位必须指定 lane 与 row');

    const probe = probeFromDef(def);
    // 地形限制（水生 / 两栖 / 轻灵）与占位限制都要过
    const legalTerrain = canPlaceInLane(probe, lane);
    const fuse = hasKw(probe, 'fuse');
    const occupant = state.board[lane].units[side][row];
    const legalSlot = legalTerrain && canPlaceUnit(state, side, probe, lane, row, { allowFuse: fuse });
    if (!legalSlot) {
      // 回滚，避免出现「付了费但没落地」的坏状态
      p.hand.splice(idx, 0, handCard);
      p.mana += cost;
      state.stats.cardsPlayed--;
      throw new Error(legalTerrain
        ? `无法将「${def.name}」放置在 ${LANE_NAME[lane]}-${row}（该位置已被占用或线路已满）`
        : `无法将「${def.name}」放置在 ${LANE_NAME[lane]}（地形限制）`);
    }
    // 「融合进化」：先把被顶掉的友方单位「消失」（不触发任何被消灭效果）
    // fusedAway 会作为 onPlay 的 payload 传下去 —— 卡牌可以写
    // 「融合进化:这张牌获得双重打击」（霸王龙），靠 effect.when === 'fused' 区分。
    const fusedAway = !!(fuse && occupant && !occupant.removed);
    if (fusedAway) {
      M.vanishUnit(state, occupant, `fuse-by-${def.id}`);
    }
    const unit = instantiateUnit(state, def, side, lane, row);
    applyHandStatDelta(state, unit, handCard);
    // 这张牌打出来时，手牌上挂着多少**费用修正**。僵尸换代时要继承它再加 1
    // （见 amounts.js 的 `{ sourceCostDelta: true, plus: 1 }`）。
    unit.paidCostDelta = handCard.costDelta || 0;
    state.board[lane].units[side][row] = unit;
    ctx.source = unit;
    M.log(state, { type: 'deploy', uid: unit.uid, cardId: def.id, name: def.name, side, lane, row, fused: fusedAway });
    M.queueTrigger(state, unit, 'onPlay', { fused: fusedAway, lane });
    // 「进入一条线:」异能 —— 打出也算「进入」这条线路（与移动同一个触发）
    M.queueTrigger(state, unit, 'onEnterLane', { from: null, lane });
    // 「有队友被打出时:」（卡牌「人间大炮」）—— 播给同侧的其他单位
    notifyAllyPlayed(state, unit, side);
    // 「捕猎」：敌方有单位被打出时，捕猎单位移动过去
    resolveHunt(state, unit);
  } else {
    /**
     * 锦囊自己带词条时（毒镖「淬毒1」、火球「暴击1」、橄榄球「溅射1」），
     * 伤害管线需要有**来源单位**才读得到词条 —— 而锦囊本来没有来源。
     * 这里给它造一个「虚拟来源」：只用来承载词条，不在棋盘上、不是真单位。
     *
     * 解决的是「给锦囊写上淬毒，结果目标不挂毒、也不报错」这种静默失效。
     * ⚠️ 只有走伤害管线的词条（暴击 / 淬毒 / 疾病）会生效；
     *    溅射 / 穿透 是**交战**路径上的逻辑（collectAttackEvents），锦囊上写了不生效。
     */
    if ((def.keywords || []).length > 0) {
      ctx.source = {
        uid: -(state.nextUid++),           // 负数 uid：绝不会和真单位撞
        cardId: def.id,
        name: def.name,
        side,
        lane: ctx.chosenLane,
        row: 'front',
        atk: 0, hp: 0, maxHp: 0,
        keywords: def.keywords.map(parseKeyword),
        effects: [],
        marks: [],
        removed: false,
        virtual: true,                     // 见 mechanics.dealDamage 的荆棘护栏
      };
    }
    M.log(state, { type: 'cast', cardId: def.id, name: def.name, side, lane: ctx.chosenLane });
    // 「对方打出锦囊牌时:」（卡牌「拳击手」「苍耳」）
    notifyEnemyCastSpell(state, def, side);
    driveGenerator(state, execActions(state, ctx, def.actions || []));
  }

  flushTriggers(state);
  if (def.type !== CARD_TYPE.UNIT) state.discard.push(def.id);
  // 「轻灵」是状态检查：任何生命变动之后都要复检（血量掉到一半以下可能在水路淹死）
  M.checkAllNimble(state);
  flushTriggers(state);
  checkGameOver(state);
  return state;
}

/** 「有队友被打出时:」的观察者（卡牌「人间大炮」） */
export function notifyAllyPlayed(state, played, side) {
  for (const u of M.allUnits(state)) {
    if (u.removed || u === played || u.side !== side) continue;
    if (!(u.effects || []).some((e) => e.trigger === 'onAllyPlayed')) continue;
    M.queueTrigger(state, u, 'onAllyPlayed', { played });
  }
}

/** 「对方打出锦囊牌时:」的观察者（卡牌「拳击手」加身材、「苍耳」反伤） */
export function notifyEnemyCastSpell(state, def, casterSide) {
  for (const u of M.allUnits(state)) {
    if (u.removed || u.side === casterSide) continue;
    if (!(u.effects || []).some((e) => e.trigger === 'onEnemyCastSpell')) continue;
    M.queueTrigger(state, u, 'onEnemyCastSpell', { cardId: def.id, cardName: def.name, casterSide });
  }
}

/**
 * 「捕猎」（作者补充规则）：
 *   拥有该词条的单位，在有**敌方单位被打出**时，若可能，移动至那个敌方单位的线路。
 *   若有多个捕猎单位，按「山地 → 水路」的优先级依次移动。
 *
 * 优先级取的是**移动前**各自所在的线路顺序（LANES 的顺序），
 * 所以先动的是原本更靠山地的那一个；前面的动完可能占掉位置，
 * 后面的就「不可能」了 —— 这正是「若可能」的含义。
 * 「扎根」的单位不会被移动（由 auras 层判定，含拷问官光环授予的扎根）。
 */
export function resolveHunt(state, deployed) {
  if (!deployed || deployed.removed) return;
  const hunters = M.allUnits(state)
    .filter((u) => !u.removed && u.side !== deployed.side && hasKeyword(state, u, 'hunt'))
    .sort((a, b) => LANES.indexOf(a.lane) - LANES.indexOf(b.lane));

  for (const hunter of hunters) {
    if (hunter.removed) continue;
    M.moveUnitToLane(state, hunter, deployed.lane, { isRooted: (u) => hasRooted(state, u) });
  }
}
