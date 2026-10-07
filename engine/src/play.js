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
import { effectiveAtk, hasRooted, hasKeyword, getKeyword, isSealedByAura, syncStatAuras } from './auras.js';
import { execActions } from './effects.js';
import { instantiateUnit, probeFromDef } from './setup.js';
import { isTrapCard, placeTrap, TRAP_MAX } from './board.js';
import { isOver, getActor, checkGameOver, triggerInHandEffects, applyHandStatDelta, advance } from './turns.js';
import { apiFor, applySummonModify } from './combat.js';
import { flushTriggers, driveGenerator } from './choices.js';
import { isRawMaterial, comboTokenFor, returnRawMaterials, alchemyUnlock, alchemyTideOn } from './factions.js';

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
  // 这张手牌实例此刻挂在谁手上  「永久减费」与「按使用次数涨费」读的是那一方的账
  let owner = null;
  for (const p of state.players) {
    if (p.hand && p.hand.indexOf(handCard) >= 0) { owner = p; break; }
  }
  // 永久减费（科学令牌「新兴研究」U421）：写在这一方身上，本局剩下的时间都有效
  const handDelta = owner ? (owner.handCostDelta || 0) : 0;
  // 按「本局这张牌被用过几次」涨费（剑道令牌「连斩」U410：第 1 张不加费，之后每张 +1）
  const perUse = def.perUseCost && owner ? (owner.usedCount[def.id] || 0) * def.perUseCost : 0;
  return Math.max(0, def.cost + (handCard.costDelta || 0) + handDelta + perUse);
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
    // 原料（金沙/厄毒之尘/陨铁/硫磺）不能直接打出：只能通过「炼药」消耗。
    if (isRawMaterial(def)) continue;
    // 「解禁」：炼金阵营的锦囊在放置阶段也能打出。
    const unlockedSpell = def.faction === 'alchemy' && alchemyUnlock(state, side);
    if (def.type !== allowedType && !unlockedSpell) continue;
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
  // 炼金：原料只能通过炼药消耗，当普通锦囊打出会立刻退回去（作者 2026-10-07 规格）
  if (idx >= 0 && isRawMaterial(state.cardLib[p.hand[idx].cardId])) throw new Error('原料牌只能用炼药消耗，不能直接打出');
  // 解禁：国王挂着许可时，超能力锦囊可以在自己的单位回合打出（只对超能力锦囊放宽）
  const unlockedSpell = idx >= 0 && alchemyUnlock(state, side) && (state.cardLib[p.hand[idx].cardId] || {}).faction === 'alchemy';
  if (idx < 0) throw new Error(`手牌中没有 iid=${iid}`);

  const handCard = p.hand[idx];
  const def = state.cardLib[handCard.cardId];
  if (!def) throw new Error(`卡牌库缺少卡牌定义: ${handCard.cardId}`);
  // 陷阱是例外：作者口径「单位回合或锦囊回合都能打出」，所以不受阶段类型限制
  if (def.type !== allowedType && !isTrapCard(def) && !unlockedSpell) throw new Error(`本阶段只能打出「${allowedType}」，不能打出「${def.type}」`);
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
  // 「本局这张牌被用过几次」（剑道令牌「连斩」按次数涨费，见 costOf 的 perUseCost）
  p.usedCount[def.id] = (p.usedCount[def.id] || 0) + 1;

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
    // 打出锦囊期间的记账（科学超能力「克隆」U419 要重新结算「上一张锦囊」）：
    //   currentSpell 在执行期间指向这一张，用来挡「克隆自己克隆自己」的死循环。
    p.currentSpell = def.id;
    driveGenerator(state, runSpellWithWatchers(state, ctx, def));
    p.lastSpell = def.id;
    p.currentSpell = null;
  }

  flushTriggers(state);
  if (def.type !== CARD_TYPE.UNIT) state.discard.push(def.id);
  // 「轻灵」是状态检查：任何生命变动之后都要复检（血量掉到一半以下可能在水路淹死）
  M.checkAllNimble(state);
  flushTriggers(state);
  syncStatAuras(state);
  checkGameOver(state);
  return state;
}

/**
 * 锦囊的结算入口：把「锦囊自己的效果」与「在手牌中的响应」串成**同一条 generator**。
 *
 * 为什么要串在一条链上：锦囊中途可能挂起问人（选目标 / 选线路），这时候整条 generator
 * 被存进 state.pending.gen。若把在手牌响应写在 playCard 的调用点之后，挂起恢复时那一步
 * 永远不会被跑到；串进同一条链就自然接得上，顺序也确定 = 锦囊效果完全结算完，再看手牌响应。
 */
function* runSpellWithWatchers(state, ctx, def) {
  // targets.js 的 resolveTargets 会把「本次锦囊选中的敌方单位」灌进来（见那里的包装）
  ctx.spellTargets = [];
  yield* execActions(state, ctx, def.actions || []);
  yield* applyInHandSpellWatchers(state, ctx);
  // 炼金潮：本回合友方打出非原料锦囊时抽一张牌。
  // 作者 2026-10-07 口径：打出炼金潮自己也算（它自身这时已经生效）。
  const tideOwner = state.players[ctx.controller];
  if (tideOwner && alchemyTideOn(state, ctx.controller) && !isRawMaterial(def)) {
    M.log(state, { type: 'alchemy-tide', side: ctx.controller, cardId: def.id });
    M.drawCards(state, ctx.controller, 1);
  }
}

/**
 * 「在手牌中时:有敌方单位成为锦囊牌的目标，则使其-1攻击力-1生命」
 * （音乐阵营超能力「和弦」U416，作者 2026-10 口径）。
 *
 * 发动不花费用（它本来就在 playCard 流程里，不走 playCard），但要有和打出锦囊一样的提示：
 * 所以照常写一条 in-hand-trigger 日志，界面按它弹和 cast 同一个展示。
 * 目标是 ctx.spellTargets（范围选择器也算成为目标；每张锦囊各触发一次，可叠加）。
 * 自己打自己的那一次不算  这张牌在结算前已经移出手牌了。
 */
function* applyInHandSpellWatchers(state, ctx) {
  const side = ctx.controller;
  const hit = [];
  for (const u of ctx.spellTargets || []) {
    if (u && !u.removed && hit.indexOf(u) < 0) hit.push(u);
  }
  if (hit.length === 0) return;
  for (const handCard of state.players[side].hand.slice()) {
    const wdef = state.cardLib[handCard.cardId];
    if (!wdef || !wdef.inHandSpellTarget) continue;
    const atk = wdef.inHandSpellTarget.atk || 0;
    const maxHp = wdef.inHandSpellTarget.maxHp || 0;
    for (const u of hit) {
      if (u.removed) continue;
      if (atk) M.buffAtk(state, u, atk);
      if (maxHp) M.debuffMaxHp(state, u, -maxHp);
    }
    M.log(state, { type: 'in-hand-trigger', cardId: wdef.id, name: wdef.name, side, uids: hit.map((u) => u.uid) });
  }
}

/** 「有队友被打出时:」的观察者（卡牌「人间大炮」） */
export function notifyAllyPlayed(state, played, side) {
  for (const u of M.allUnits(state)) {
    if (u.removed || u === played || u.side !== side) continue;
    if (!(u.effects || []).some((e) => e.trigger === 'onAllyPlayed')) continue;
    M.queueTrigger(state, u, 'onAllyPlayed', { played });
  }
  // 国王的「友方单位打出时:」被动（科学令牌「新兴研究」U421）：国王不是单位，
  // 挂不了单位异能，只能走国王触发表（queueKingTrigger），payload 带上被派出的那个单位。
  M.queueKingTrigger(state, side, 'onAllyPlayed', { played });
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

/**
 * 炼药（炼金阵营，作者 2026-10-07 规格）。
 *
 * 打出原料时再选手里其它原料，按「这一次消耗掉的原料」的组合把令牌加进手里：
 *   费用 = 消耗掉的原料各自费用的和（作者 Q2.A，所以被未收录粉尘压到 0 费的原料，
 *          不论打出还是参与组合都是 0 费）；
 *   组合对不上就不给令牌（原料照样回堆、费用照付）。
 *
 * 多选由界面累积好一次交给这里（iids 里第一张就是被「打出」的那张），
 * 这样联机/回放的锁步流水里只多一条动作。
 */
export function brew(state, side, iids) {
  if (isOver(state)) throw new Error('对局已经结束了');
  if (state.pending) throw new Error('存在待处理的交互请求，请先 resolveChoice');
  const actor = getActor(state);
  if (actor !== side) throw new Error('现在不是你的出牌阶段');
  const p = state.players[side];
  // 炼药是炼金阵营的专属机制：别的阵营连原料都拿不到，更不该能炼
  if (p.faction !== 'alchemy') throw new Error('只有炼金阵营能炼药');
  const ids = Array.isArray(iids) ? iids.slice() : [iids];
  const uniq = [];
  for (const id of ids) if (uniq.indexOf(id) < 0) uniq.push(id);
  if (uniq.length < 2) throw new Error('炼药至少要消耗两张原料');

  const picked = [];
  for (const id of uniq) {
    const idx = p.hand.findIndex((c) => c.iid === id);
    if (idx < 0) throw new Error('手牌里没有这张原料');
    const hc = p.hand[idx];
    if (!isRawMaterial(state.cardLib[hc.cardId])) throw new Error('只能消耗原料');
    picked.push({ idx, hc });
  }
  let cost = 0;
  for (const it of picked) cost += costOf(state, it.hc);
  if (cost > p.mana) throw new Error('费用不足：需要 ' + cost + '，剩余 ' + p.mana);

  const consumed = picked.map((it) => it.hc.cardId);
  picked.sort((a, b) => b.idx - a.idx);
  for (const it of picked) p.hand.splice(it.idx, 1);
  p.mana -= cost;
  returnRawMaterials(state, side, consumed);

  const token = comboTokenFor(consumed);
  M.log(state, { type: 'brew', side, cost, consumed: consumed.slice(), token: token || null });
  if (!token) return { cost, consumed, token: null };

  const card = { iid: state.nextIid++, cardId: token };
  p.hand.push(card);
  M.log(state, { type: 'brew-token', side, cardId: token });
  const tdef = state.cardLib[token];
  if (tdef && tdef.autoUseOnAdd) driveGenerator(state, autoUseTokenGen(state, side, card, tdef));
  return { cost, consumed, token };
}

/**
 * 「这张牌加入手中时：自动使用，然后结束当前出牌回合」（令牌「事故」U444）。
 * 顺序照抄 playCard 的锦囊分支，最后推进阶段结束当前出牌回合。
 */
function* autoUseTokenGen(state, side, handCard, def) {
  const p = state.players[side];
  const idx = p.hand.findIndex((c) => c.iid === handCard.iid);
  if (idx >= 0) p.hand.splice(idx, 1);
  const ctx = {
    state,
    controller: side,
    card: def,
    source: null,
    chosenLane: null,
    chosenTargetUid: null,
    chosenTargetIsKing: false,
    api: apiFor(state),
  };
  if ((def.keywords || []).length > 0) {
    ctx.source = {
      uid: -(state.nextUid++),
      cardId: def.id,
      name: def.name,
      side,
      lane: null,
      row: 'front',
      atk: 0, hp: 0, maxHp: 0,
      keywords: def.keywords.map(parseKeyword),
      effects: [],
      marks: [],
      removed: false,
      virtual: true,
    };
  }
  M.log(state, { type: 'cast', cardId: def.id, name: def.name, side, lane: null, auto: true });
  notifyEnemyCastSpell(state, def, side);
  p.currentSpell = def.id;
  yield* runSpellWithWatchers(state, ctx, def);
  p.lastSpell = def.id;
  p.currentSpell = null;
  flushTriggers(state);
  if (def.type !== CARD_TYPE.UNIT) state.discard.push(def.id);
  M.checkAllNimble(state);
  flushTriggers(state);
  syncStatAuras(state);
  checkGameOver(state);
  if (!state.pending && !isOver(state)) advance(state);
}
