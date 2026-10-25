/**
 * 出牌与合法性：费用、可打的牌、落点判定，以及打出/召唤的结算入口。
 *
 * 从 engine.js 拆出（纯搬移，行为不变）：
 *   costOf / getLegalPlays / legalPlacements / canPlaceUnit / playCard /
 *   notifyAllyPlayed / notifyEnemyCastSpell / resolveHunt
 *
 * 依赖方向：mechanics ← setup ← play ← choices/combat
 */

import { LANES, ROWS, LANE_NAME, PHASE_ALLOWED_CARD_TYPE, CARD_TYPE, roleName } from './constants.js';
import { parseKeyword, hasKw, canPlaceInLane } from './keywords.js';
import * as M from './mechanics.js';
import { hasRooted, hasKeyword, syncStatAuras } from './auras.js';
import { execActions } from './effects.js';
import { instantiateUnit, probeFromDef, enhanceFor } from './setup.js';
import { isTrapCard, placeTrap, TRAP_MAX } from './board.js';
import { sandboxPlantTrap } from './sandbox.js';
import { isOver, getActor, checkGameOver, triggerInHandEffects, applyHandStatDelta, advance } from './turns.js';
import { apiFor } from './combat.js';
import { flushTriggers, driveGenerator } from './choices.js';
import { isRawMaterial, comboTokenFor, returnRawMaterials, alchemyUnlock, alchemyTideOn, checkFlameLotus } from './factions.js';

// ══════════════════════════════════════════════════════════
// 合法性
// ══════════════════════════════════════════════════════════

/**
 * 只挑出**融合后效果**（`when: 'fused'` 的那几条）。
 *
 * 融合时把这张牌的「融合后效果」交给留场的那个单位结算（裁决 D78），
 * 但它自己的「打出:」不该跟着一起过去 —— 那张牌是被消灭，不是被打出。
 * 所以这里按 when 过滤一次，再把 `when` 摘掉（那一条本来就只有融合时才该发动）。
 */
function fusedOnly(def) {
  return ((def && def.effects) || [])
    .filter((e) => e.trigger === 'onPlay' && e.when === 'fused')
    .map((e) => Object.assign({}, e, { when: undefined }));
}

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
  // 强化工坊的「精通」减费（锦囊）：按这边自己的强化表算 —— 双方牌库共享，
  // 同一张锦囊在两人手里可以是不同费用。
  const enhanceCost = owner ? enhanceFor(state, owner.side, def.id).cost : 0;
  // 「协作」（精通技能）：费用减少等同于**场上队友数**（作者 2026-10-24）
  let perAlly = 0;
  if (owner) {
    const enh = enhanceFor(state, owner.side, def.id);
    const flag = enh.flags && enh.flags.costPerAlly;
    if (flag) {
      const allies = M.allUnits(state).filter((u) => !u.removed && u.side === owner.side).length;
      perAlly = -Math.min(allies, Math.max(0, def.cost)) * flag;
    }
  }
  return Math.max(0, def.cost + enhanceCost + perAlly + (handCard.costDelta || 0) + handDelta + perUse);
}

/**
 * 某方当前可以打出的所有牌及合法位置。
 * 返回 [{ iid, cardId, cost, places:[{lane,row}|null] }]
 */
/**
 * 这一方本回合是否被「无法使用锦囊牌」锁住（炎帝「天火三玄变」）。
 * 记的是 `spellLockTurn = 打出时的回合 + 1`，所以只锁那一方自己的下一个回合。
 */
export function spellLocked(state, side) {
  const p = state.players && state.players[side];
  return !!(p && p.spellLockTurn === state.turn);
}
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
    // 「敌方下回合无法使用锦囊牌」：被锁的那一方本回合的锦囊一律不合法（陷阱也不行，
    // 因为陷阱也是锦囊牌，只是埋伏打出）。
    if (def.type === CARD_TYPE.SPELL && spellLocked(state, side)) continue;
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
 * opts.allowFuse = true（这张牌自己带「融合」）：格子上有己方单位也算合法 ——
 *   那名队友留在场上，这张牌自己被消灭（裁决 D78）。
 *
 * 反方向（作者 2026-10-25：卡面有融合的友方单位在场时，可以把友方单位打到它身上）
 * 不需要任何选项：格子里站着的是**带融合的己方单位**时永远合法，
 * 那个带融合的单位被消灭，新打出的牌留下。所以这里直接判。
 */
export function canPlaceUnit(state, side, probe, lane, row, opts = {}) {
  // 地形封锁（卡牌「氢弹：令平地不可放置单位一回合」）
  // 判定口径：被封锁的线路在 `state.turn <= untilTurn` 期间不能放置任何单位。
  const lock = (state.laneLocks || {})[lane];
  if (lock !== undefined && state.turn <= lock) return false;

  const slot = state.board[lane].units[side];
  if (slot[row]) {
    if (opts.allowFuse === true) return true;
    // 「打到带融合的队友身上」：被消灭的是它，不是新牌
    return hasKeyword(state, slot[row], 'fuse');
  }
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
 * @param {object} opts               { lane, row, targetUid }
 */
export function playCard(state, side, iid, opts = {}) {
  /**
   * 靶场（作者 2026-10-22）：试卡的地方，**不守对局规矩**。
   *
   * 放行的只有「什么时候能出」这一层：阶段、费用、归属、锦囊锁全部跳过 ——
   * 卡牌本身的效果仍然走同一条结算链（execActions / 触发队列 / 伤害管线），
   * 所以靶场里看到的效果就是实战效果，不会出现「靶场能过、实战不行」。
   * 另外多一个 opts.placeSide：靶场允许把牌放到**对面**的格子上。
   */
  const sandbox = state.sandbox === true;
  if (!sandbox) {
    if (isOver(state)) throw new Error('对局已结束');
  if (state.pending) throw new Error('存在待处理的交互请求，请先 resolveChoice');

    const actor = getActor(state);
    if (actor !== side) throw new Error(`现在是「${state.phase}」阶段，应由${roleName(state, actor)}行动`);
  }

  const allowedType = PHASE_ALLOWED_CARD_TYPE[state.phase];
  const p = state.players[side];
  const idx = p.hand.findIndex((c) => c.iid === iid);
  // 炼金：原料只能通过炼药消耗，当普通锦囊打出会立刻退回去（作者 2026-10-07 规格）
  if (!sandbox && idx >= 0 && isRawMaterial(state.cardLib[p.hand[idx].cardId])) throw new Error('原料牌只能用炼药消耗，不能直接打出');
  // 解禁：国王挂着许可时，超能力锦囊可以在自己的单位回合打出（只对超能力锦囊放宽）
  const unlockedSpell = idx >= 0 && alchemyUnlock(state, side) && (state.cardLib[p.hand[idx].cardId] || {}).faction === 'alchemy';
  if (idx < 0) throw new Error(`手牌中没有 iid=${iid}`);

  const handCard = p.hand[idx];
  const def = state.cardLib[handCard.cardId];
  if (!def) throw new Error(`卡牌库缺少卡牌定义: ${handCard.cardId}`);
  // 陷阱是例外：作者口径「单位回合或锦囊回合都能打出」，所以不受阶段类型限制
  if (!sandbox && def.type !== allowedType && !isTrapCard(def) && !unlockedSpell) throw new Error(`本阶段只能打出「${allowedType}」，不能打出「${def.type}」`);
  // 「无法使用锦囊牌」的硬拦截（与 getLegalPlays 同步：界面不会给按钮，直接调 API 也拦住）
  if (!sandbox && def.type === CARD_TYPE.SPELL && spellLocked(state, side)) throw new Error('本回合无法使用锦囊牌');
  // 靶场不收费（作者要的是「点一下就看到效果」，不是「先攒够费用」）
  const cost = sandbox ? 0 : costOf(state, handCard);
  if (!sandbox && cost > p.mana) throw new Error(`费用不足：需要 ${cost}，剩余 ${p.mana}`);

  //  陷阱（作者 2026-10 口径）：陷阱不是「打出卡牌」，而是**埋伏**进陷阱格里。
  //    所以这里要在 `cardsPlayed++` 与「在手牌中」被动之前拦下来：
  //       不计入打出张数（人间大炮的「有队友被打出时」不会响）
  //       不触发「在手牌中」的被动
  //       不广播「敌方打出锦囊」
  //    费用照付；效果等触发条件达成时再由 damage.js / 后续牌结算。
  if (isTrapCard(def)) {
    /**
     * 靶场：点**哪一格陷阱格**就埋伏在哪一条线路（作者 2026-10-23 第 3 条）。
     * 真对局照旧交给 placeTrap 自己找第一条空线路。
     */
    const lane = (sandbox && opts.lane)
      ? sandboxPlantTrap(state, side, opts.lane, handCard.cardId)
      : placeTrap(state, side, handCard.cardId, cost);
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

  const ctx = {
    state,
    controller: side,
    card: def,
    source: null,
    chosenLane: opts.lane ?? null,
    chosenTargetUid: opts.targetUid ?? null,
    // 目标指定为「国王」（用于"敌方单位或国王"这类复合选择器）
    chosenTargetIsKing: opts.targetKing === true,
    // 靶场允许指定「哪一边的国王」（真对局里不传，行为不变）
    chosenTargetKingSide: opts.targetKingSide === undefined ? undefined : (Number(opts.targetKingSide) ? 1 : 0),
    api: apiFor(state),
  };

  if (def.type === CARD_TYPE.UNIT) {
    const { lane, row } = opts;
    if (!lane || !row) throw new Error('放置单位必须指定 lane 与 row');

    /**
     * 靶场：落点归**点的那一方**（opts.placeSide），并且不看地形 / 占位规则 ——
     * 作者要的是「点哪个格子就放到哪个格子」，别的限制都由「清空」按钮解决。
     * 真对局里 placeSide 永远等于 side（playCard 的调用方不会传）。
     */
    const placeSide = sandbox && opts.placeSide !== undefined ? (Number(opts.placeSide) ? 1 : 0) : side;
    const probe = probeFromDef(def);
    // 地形限制（水生 / 两栖 / 轻灵）与占位限制都要过
    const legalTerrain = sandbox || canPlaceInLane(probe, lane);
    const fuse = hasKw(probe, 'fuse');
    const occupant = state.board[lane].units[placeSide][row];
    /**
     * 靶场：**任意格子都能放**（作者 2026-10-23 第 3 条）。
     *
     * 以前靶场还剩一条规矩「这一格有人了就拦一下」，理由是怕顶掉一张牌；
     * 试卡时真正碍事的就是它 —— 想在同一个坑位上换一张牌，得先清空整块场地。
     * 现在格子里有人就直接顶掉：顶掉和「融合进化」一样不触发任何被消灭效果，
     * 靶场里那只是换一张牌摆着看。
     * 唯一还拦的是「行」必须是前排/后排：陷阱格上选着单位牌时不能凭空造出一个
     * 挂在 undefined 上的单位（那会让棋盘和渲染一起错位）。
     */
    const legalRow = row === 'front' || row === 'back';
    const legalSlot = sandbox
      ? legalRow
      : (legalTerrain && canPlaceUnit(state, side, probe, lane, row, { allowFuse: fuse }));
    if (!legalSlot) {
      // 回滚，避免出现「付了费但没落地」的坏状态
      p.hand.splice(idx, 0, handCard);
      p.mana += cost;
      state.stats.cardsPlayed--;
      throw new Error(sandbox
        ? `这一格放不下单位：位置只能是前排或后排`
        : (legalTerrain
          ? `无法将「${def.name}」放置在 ${LANE_NAME[lane]}-${row}（该位置已被占用或线路已满）`
          : `无法将「${def.name}」放置在 ${LANE_NAME[lane]}（地形限制）`));
    }
    /**
     * 「融合」（作者 2026-10-25 重做口径，裁决 D78）：**带融合的那张牌算作被消灭，
     * 另一边留在场上**，融合后的效果一律结算在**留在场上的那一个**身上。
     *
     * 两个方向都成立：
     *   A. 把带融合的牌打在队友身上 → 队友留在场上，融合牌被消灭，效果给队友
     *   B. 把普通牌打在带融合的队友身上 → 新牌留在场上，融合牌被消灭，效果给新牌
     *
     * 与旧口径的区别（旧的见 D34，已作废）：
     *   旧：队友「消失」（不触发任何被消灭效果），新牌顶替它的位置。
     *   新：被消灭的是**带融合的那张**，而且走的是真正的「被消灭」
     *       （触发它自己的「被消灭:」与国王的「友方单位被消灭时」被动）。
     */
    const fusingPlayed = !!(fuse && occupant && !occupant.removed);
    const fusingOcc = !fusingPlayed && !!occupant && !occupant.removed
      && placeSide === side && hasKeyword(state, occupant, 'fuse');
    // 靶场顶掉：格子里原本那张牌「消失」，不触发被打死 / 被消灭的任何效果
    const replaced = sandbox && !!occupant && !occupant.removed && !fusingPlayed && !fusingOcc;
    if (replaced) {
      M.vanishUnit(state, occupant, 'sandbox-replace');
    }

    if (fusingPlayed) {
      // A：打出的这张带融合 —— 它不落地，队友原地不动
      ctx.source = occupant;
      M.log(state, {
        type: 'fuse', side: placeSide, cardId: def.id, name: def.name,
        into: occupant.cardId, intoUid: occupant.uid, direction: 'card-into-ally',
      });
      /**
       * 融合牌自己「算作被消灭」：它从没上过场，所以要造一个实例走一遍
       * destroyUnit —— 这样「被消灭:」异能、消灭计数、国王的被动都会照常触发。
       * 实例的 lane/row 与队友相同，但 uid 不同，removeUnitFromBoard 不会误清队友。
       */
      const gone = instantiateUnit(state, def, placeSide, lane, row);
      M.destroyUnit(state, gone, `fuse-by-${def.id}`);
      // 融合后的效果以**留在场上的队友**为来源（作者 2026-10-25：永远不落在融合牌上）
      M.queueTrigger(state, occupant, 'onPlay', { fused: true, lane },
        { effects: fusedOnly(def), cardId: def.id });
    } else if (fusingOcc) {
      // B：打出的这张是普通牌 —— 它落地，带融合的队友被消灭
      const fuseDef = state.cardLib[occupant.cardId] || {};
      const unit = instantiateUnit(state, def, placeSide, lane, row);
      applyHandStatDelta(state, unit, handCard);
      unit.paidCostDelta = handCard.costDelta || 0;
      state.board[lane].units[placeSide][row] = unit;
      ctx.source = unit;
      M.log(state, {
        type: 'deploy', uid: unit.uid, cardId: def.id, name: def.name, side: placeSide, lane, row, fused: true,
      });
      M.log(state, {
        type: 'fuse', side: placeSide, cardId: fuseDef.id || occupant.cardId, name: fuseDef.name || '',
        into: unit.cardId, intoUid: unit.uid, direction: 'ally-into-card',
      });
      M.destroyUnit(state, occupant, `fuse-into-${def.id}`);
      // 新落的这张牌自己照常触发「打出:」
      M.queueTrigger(state, unit, 'onPlay', { fused: false, lane });
      M.queueTrigger(state, unit, 'onEnterLane', { from: null, lane });
      // 被消灭的融合牌只把「融合后效果」交给它
      M.queueTrigger(state, unit, 'onPlay', { fused: true, lane },
        { effects: fusedOnly(fuseDef), cardId: fuseDef.id || occupant.cardId });
      notifyAllyPlayed(state, unit, side);
      resolveHunt(state, unit);
    } else {
      const unit = instantiateUnit(state, def, placeSide, lane, row);
      applyHandStatDelta(state, unit, handCard);
      // 这张牌打出来时，手牌上挂着多少**费用修正**。僵尸换代时要继承它再加 1
      // （见 amounts.js 的 `{ sourceCostDelta: true, plus: 1 }`）。
      unit.paidCostDelta = handCard.costDelta || 0;
      state.board[lane].units[placeSide][row] = unit;
      ctx.source = unit;
      M.log(state, { type: 'deploy', uid: unit.uid, cardId: def.id, name: def.name, side: placeSide, lane, row, fused: false });
      M.queueTrigger(state, unit, 'onPlay', { fused: false, lane });
      // 「进入一条线:」异能 —— 打出也算「进入」这条线路（与移动同一个触发）
      M.queueTrigger(state, unit, 'onEnterLane', { from: null, lane });
      // 「有队友被打出时:」（卡牌「人间大炮」）—— 播给同侧的其他单位
      notifyAllyPlayed(state, unit, side);
      // 「捕猎」：敌方有单位被打出时，捕猎单位移动过去
      resolveHunt(state, unit);
    }
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
    // 「本回合友方打出过几张锦囊」（精通技能「连击」要读它，作者 2026-10-24）
    p.spellsThisTurn = (p.spellsThisTurn || 0) + 1;
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
  /**
   * 「打出异火之后检查佛怒火莲能否入手」（炎帝，作者 2026-10-12 裁定②）：
   * 只在打出**异火**这一刻检查，所以佛怒火莲不会因为别的原因反复入手；
   * 入手过一次后要等「佛怒火莲」把异火堆重置才会再次武装。
   */
  if (def.flame === true) checkFlameLotus(state, side);
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
function notifyAllyPlayed(state, played, side) {
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

function notifyEnemyCastSpell(state, def, casterSide) {
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
