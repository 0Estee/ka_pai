/**
 * 交互挂起（generator 驱动）与触发队列。
 *
 * 从 engine.js 拆出（纯搬移，行为不变）：
 *   takeChoice / driveGenerator / resolveChoice / whenMet / flushTriggers
 *   （另含队列的执行体 runTriggeredEffects / runKingTriggeredEffects）
 *
 * 依赖方向：mechanics ← setup ← choices ← play/combat
 * ⚠ choices ←→ combat 是一个函数声明的环（flushTriggers ←→ apiFor/applyAttackBatch），
 *   ESM 与打包器都能靠函数提升正常工作；见 combat.js 顶部说明。
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
import { PENDING } from './setup.js';
import { apiFor } from './combat.js';

// ══════════════════════════════════════════════════════════
// 交互挂起（generator 驱动）
// ══════════════════════════════════════════════════════════

export function takeChoice(state, request) {
  const qi = state.choiceQueue.findIndex((c) => c.type === request.type);
  if (qi >= 0) return state.choiceQueue.splice(qi, 1)[0];
  /**
   * 录音模式（`state.choiceLog` 是数组时）：把**每一问的裁定**按顺序记下来。
   *
   * 记的是「这一问怎么了」，不只是「答案是什么」：
   *   · 引擎自己答掉的 → `{ type, v: <答案> }`
   *   · 挂起等真人的 → `{ type, hang: true }`
   *
   * ⚠ 为什么连「挂起」也必须记：实战里**同一问**挂不挂起，取决于调用方
   * 当时把 `state.autoResolveChoices` 开成什么（真人出牌前会关掉它，见
   * `app/js/play-input.js` 的 `commitPlay`）。回放播放器是另一套调用方，
   * 它无从知道当时那个开关的状态 —— 于是同一问在回放里会被静默代答，
   * 而实战里挂着等真人：两边从这里开始整体错开（少抽一张牌、`nextIid` 差 1、
   * 最后报「有挂起的交互请求，但没法回答」）。
   * 只记答案不记挂起，这个信息就永远丢了，回放只能靠猜。
   *
   * 所以这份流水就是**完整的裁定流**：回放按同一条顺序逐问装回，
   * 遇到 `hang` 就原样挂起、由录制流里紧随其后的 `{k:'c'}` 喂回来
   *（见 `app/js/replay.js` 的 `replayChooser`）。
   */
  const hold = (answer) => {
    if (Array.isArray(state.choiceLog)) state.choiceLog.push({ type: request.type, v: answer });
    if (Array.isArray(state.qTrace)) state.qTrace.push(`A@${state.stats ? state.stats.cardsPlayed : '?'}:${request.type}${request.noAuto ? '!' : ''}`);
    if (typeof globalThis !== 'undefined' && globalThis.__dbg) {
      // eslint-disable-next-line no-console
      console.log(`[hold] type=${request.type} side=${request.side} noAuto=${!!request.noAuto} histLen=${Array.isArray(state.choiceLog) ? state.choiceLog.length : '-'}`);
    }
    return answer;
  };
  /** 记一条「挂起等真人」的裁定（必须与 `hold` 写同一条流水、同一套顺序） */
  const holdHang = () => {
    if (Array.isArray(state.choiceLog)) state.choiceLog.push({ type: request.type, hang: true });
    if (Array.isArray(state.qTrace)) state.qTrace.push(`H@${state.stats ? state.stats.cardsPlayed : '?'}:${request.type}${request.noAuto ? '!' : ''}`);
    if (typeof globalThis !== 'undefined' && globalThis.__dbg) {
      // eslint-disable-next-line no-console
      console.log(`[holdHang] type=${request.type} side=${request.side} noAuto=${!!request.noAuto} histLen=${Array.isArray(state.choiceLog) ? state.choiceLog.length : '-'}`);
    }
    return PENDING;
  };
  /**
   * `state.chooser`：外部驱动器想**先插一手**时挂上的函数
   * （回放播放器用它把录制里的答案喂回来，见 app/js/replay.js 的 replayChooser）。
   *
   * ⚠ 它必须排在**最前面** —— `noAuto` 与 `autoResolveChoices` 之前。
   * 两条理由，都是踩过才明白的：
   *
   *    ① 「抉择」这类 `chooseOption` 请求**没有 `noAuto`**，于是
   *      `autoResolveChoices === true` 时会在到达这个口子之前就被
   *      「取第一个选项」静默答掉；真人当时选的是第 2 项，那条录下来的 `{k:'c'}`
   *      就成了孤儿，回放到它直接报 `当前没有待处理的交互请求`。
   *      而「出牌带选择的卡牌回放会错」正是这个成因。
   *
   *    ② **`noAuto` 也必须先经过它**（2026-10 补）。`choiceLog` 是一份**完整的
   *      有序流水**：**每一问**都独占一条（引擎答的记答案、挂起等人的记 `hang`）。
   *      回放侧靠一个游标从头逐条装回，所以**每一问都必须消耗掉一条**。
   *      而 `noAuto` 若抢在前面 `return holdHang()`：
   *         · 它绕过 chooser → **不消耗流水**，游标从此与真实提问错位；
   *         · 之后每一问都读到**别人的**条目，把本该由引擎代答的请求误判成
   *          「挂起等人」，最后报「有挂起的交互请求，但没法回答」；
   *         · `holdHang` 还会往 `state.choiceLog` **追加**一条，把回放手里那份
   *          录制流水本身写脏。
   *      确定性复现（种子 111）：`noAuto` 的 combatTarget 后面紧跟着一个
   *      引擎代答的 chooseHandCard，错位正好把那一问吃掉，卡在第 43 步。
   *
   * 记录里有答案 → 用记录的（真人的选择必须原样重现）；
   * 记录里没有答案（引擎自己答掉的请求不进记录）→ 落回下面的自动代答。
   * 没有 chooser（正常对局）时行为完全不变：`noAuto` 照样在下面挂起等人。
   */
  if (typeof state.chooser === 'function') {
    const viaChooser = state.chooser(request);
    if (globalThis.__dbg || (typeof window !== 'undefined' && window.__dbg)) {
      // eslint-disable-next-line no-console
      console.log(`[takeChoice] ${request.type} noAuto=${!!request.noAuto} chooser→${viaChooser === PENDING ? 'PENDING' : (viaChooser === undefined ? 'undefined' : JSON.stringify(viaChooser))}`);
    }
    if (viaChooser !== undefined) return viaChooser;
  }
  /**
   * ⚠ `noAuto: true` 的请求**必须由真人回答，自动代答一律不碰**。
   *
   * 为什么需要这个开关：「拟定目标攻击」（强化士兵）在开战结算中途问「打谁」，
   * 而玩家侧必须真的选（作者裁决：不选就不出手）。可是自动代答的口径是
   * 「取第一个选项」，选项又按棋盘顺序排 —— 一旦 autoResolveChoices 是 true，
   * 那条 yield 会被**静默代答**：玩家永远看不到面板，AI 也跟着棋盘顺序乱打。
   * 这个开关把「这一问必须有人答」变成请求自身的属性，
   * 而不是依赖调用方记得先把 autoResolveChoices 关掉（那个约定已经被踩过一次）。
   *
   * ⚠ 顺序：它排在 `state.chooser` **之后** —— 回放驱动器做的是「照录制把
   * 每一问装回去」，不是「自动代答」，所以不算违反上面这条规则（见 ②）。
   */
  if (request.noAuto) return holdHang();
  if (globalThis.__dbg || (typeof window !== 'undefined' && window.__dbg)) {
    if (!state.autoResolveChoices) {
      // eslint-disable-next-line no-console
      console.log(`[takeChoice] ${request.type} 没有 chooser 命中且 autoResolveChoices=false → PENDING`);
    }
  }
  if (state.autoResolveChoices) {
    /**
     * 有些请求不是「随便挑一个就行」的，自动结算时要算一下（AI 侧）：
     * 「拟定目标攻击」的 combatTarget 要按「能一击杀死就打、否则打国王」挑，
     * 而默认的「取第一个选项」会按棋盘顺序乱打。
     *
     * `request.choose` 由引擎在**提问处**挂上（见 combat.js 的 pickCombatTarget）。
     * 这里只认它返回的选项对象；没给 choose 或返回空就退回「取第一个」。
     */
    if (typeof request.choose === 'function') {
      const picked = request.choose();
      if (picked) return hold(picked);
    }
    return hold(request.options[0] ?? {});
  }
  return holdHang();
}

export function driveGenerator(state, gen, input) {
  let res = gen.next(input);
  while (!res.done) {
    const answer = takeChoice(state, res.value);
    if (answer === PENDING) {
      state.pending = { request: res.value, gen };
      return PENDING;
    }
    res = gen.next(answer);
  }
  return res.value;
}

/** 回答引擎抛出的选择请求，恢复被挂起的效果 */
export function resolveChoice(state, choice) {
  if (!state.pending) throw new Error('当前没有待处理的交互请求');
  const { gen } = state.pending;
  state.pending = null;
  const r = driveGenerator(state, gen, choice);
  if (r !== PENDING) {
    M.checkAllNimble(state);
    flushTriggers(state);
  }
  return state.pending;
}

// ══════════════════════════════════════════════════════════
// 触发队列
// ══════════════════════════════════════════════════════════

export function* runTriggeredEffects(state, unit, triggerName, payload = {}) {
  // 被封印的单位异能不生效（卡牌「禁军」「大封印碑」「卫兵」）。
  // 一次性的 sealUnit 与「在场」式的大封印碑都要算。
  if (M.isSealed(unit) || isSealedByAura(state, unit)) return;

  const list = (unit.effects || []).filter((e) => e.trigger === triggerName);
  for (const effect of list) {
    /**
     * effect.when 是**附加条件**，不满足就跳过这条异能：
     *   'fused'              只有「用融合进化打出」时才发动（卡牌「霸王龙」）
     *   { lane: 'mountain' } 只在指定地形落点时发动（卡牌「登山员：在高山上打出」）
     *   { deathsAtLeast: 4 } 全场累计被消灭数达到 N 时才发动（卡牌「卫兵」）
     */
    if (!whenMet(state, effect.when, payload)) continue;

    const ctx = {
      state,
      source: unit,
      controller: unit.side,
      card: state.cardLib[unit.cardId],
      chosenLane: unit.lane,
      chosenTargetUid: null,
      payload,
      api: apiFor(state),
      // ── 防自触发死循环：
      // 「造成伤害:」异能自身造成的伤害不再触发任何「造成伤害时」的词条，
      // 否则「造成伤害: 对敌方单位造成1点伤害」会无限递归（原文未限制，属规则漏洞）。
      noKeywordsForDamage: triggerName === 'onDealDamage',
      // 同理，「有敌人受到伤害时」的观察者自己造成的伤害不再惊动其他观察者，
      // 否则两个「怨魂」会无限互相触发。
      noWatchersForDamage: triggerName === 'onEnemyDamaged',
      // 「受到伤害:」异能自己造成的伤害不再触发别人（也不回头触发自己）的「受到伤害:」
      noDamagedTriggerForDamage: triggerName === 'onDamaged',
    };
    // 「每扣除1♥，便…」—— 一次掉 N 血就触发 N 次（卡牌「红火蚁」）
    const times = effect.repeat === 'damageAmount' ? Math.max(1, Number(payload.amount) || 1) : 1;
    for (let i = 0; i < times; i++) {
      yield* execActions(state, ctx, effect.actions || []);
    }
  }
}

/** effect.when 的判定。undefined 视为「总是发动」。 */
export function whenMet(state, when, payload) {
  if (when === undefined || when === null) return true;
  if (when === 'fused') return !!payload.fused;
  if (typeof when === 'object') {
    if (when.lane !== undefined && payload.lane !== when.lane) return false;
    if (when.deathsAtLeast !== undefined && (state.stats.unitsDestroyed || 0) < when.deathsAtLeast) return false;
    return true;
  }
  throw new Error(`未知的 effect.when: ${JSON.stringify(when)}`);
}

/**
 * 国王附着的异能（「战略纵深」）。
 * 与单位异能分开，因为来源不是棋盘上的单位，而是玩家编号。
 */
export function* runKingTriggeredEffects(state, side, triggerName, payload = {}) {
  const list = (state.players[side].kingEffects || []).filter((e) => e.trigger === triggerName);
  for (const effect of list) {
    const ctx = {
      state,
      source: null,
      controller: side,
      card: null,
      chosenLane: null,
      chosenTargetUid: null,
      payload,
      api: apiFor(state),
    };
    yield* execActions(state, ctx, effect.actions || []);
  }
}

/**
 * 触发队列的 generator 版：每个触发异能都用 `yield*` 嵌进**调用方**的 generator 链。
 *
 * 开战结算（combat.js 的 runCombat）必须用这一版：狙击手改成
 * 「开战时:造成2点伤害（选择一个目标）」之后，这一问会挂起等人。
 * 若用同步版 flushTriggers，「挂起」被消耗在它内部（它返回 PENDING 而 runCombat 不理会），
 * 结果是**这一条线路先结算完、打完人之后才把面板弹给玩家**（顺序语义全错）。
 * 用这一版时 PENDING 一路传播到最外层，state.pending.gen 指向整条开战链，
 * 玩家答完由 resolveChoice 接着把后面的结算跑完。
 */
export function* flushTriggersGen(state) {
  let guard = 0;
  while (state.triggerQueue.length > 0) {
    if (++guard > 1000) throw new Error('触发链超过 1000 步，可能存在无限循环');
    const t = state.triggerQueue.shift();
    const gen = t.kingSide !== undefined
      ? runKingTriggeredEffects(state, t.kingSide, t.triggerName, t.payload)
      : runTriggeredEffects(state, t.unit, t.triggerName, t.payload);
    yield* gen;
  }
}

/**
 * 清空触发队列（同步版）。等价于把 generator 版驱动到底：
 * 挂起时 state.pending.gen 指向的也是 generator 版（剩下的队列还在链上），
 * 但**调用方自己**的后半段不在链上（调用方是普通函数），所以
 * 「触发异能里要问人」的阶段请改用 flushTriggersGen。
 */
export function flushTriggers(state) {
  return driveGenerator(state, flushTriggersGen(state));
}
