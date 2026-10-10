/**
 * 开战结算（规则书 §8）与召唤接口。
 *
 * 从 engine.js 拆出（纯搬移，行为不变）：
 *   runCombat / queueCombatStartTriggers / resolveLane / applyAttackBatch /
 *   collectAttackEvents / apiFor / attackPower（改用 setup.js 的那份）/
 *   probeFromDef（改用 setup.js 的那份）/ findSummonSpot / applySummonModify /
 *   notifyAllyExtraAttack
 *
 * 依赖方向：mechanics ← setup ← combat ← play/choices
 * ⚠ combat ←→ choices 是函数声明的环：combat 需要 flushTriggers，
 *   choices 需要 apiFor。两侧都只有 function 声明（会提升），
 *   且没有任何加载期就要取值的顶层 const，所以 ESM 与拍平后都成立。
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
import { instantiateUnit, attackPower, probeFromDef } from './setup.js';
import { isOver, getActor, checkGameOver } from './turns.js';
import { flushTriggers, flushTriggersGen } from './choices.js';
import { resolveHunt, canPlaceUnit, legalPlacements } from './play.js';

// ══════════════════════════════════════════════════════════
// 开战结算（规则书 §8）
// ══════════════════════════════════════════════════════════

export function* runCombat(state) {
  M.log(state, { type: 'combat-start', turn: state.turn });
  for (const lane of LANES) {
    if (isOver(state)) return;
    // 「战斗开始前:」异能（卡牌「狙击手」）—— 在该线路结算之前触发
    yield* queueCombatStartTriggers(state, lane);
    yield* flushTriggersGen(state);
    if (isOver(state)) return;
    yield* resolveLane(state, lane);
    checkGameOver(state);
  }
  M.log(state, { type: 'combat-end' });
  // 开战期间可能有单位被打死（光环来源离场）或新单位落地，光环物化的数值要重新对账
  syncStatAuras(state);
}

/** 「战斗开始前 / 开战回合」的触发（逐线路） */
export function* queueCombatStartTriggers(state, lane) {
  for (const u of M.laneUnits(state, lane, 0).concat(M.laneUnits(state, lane, 1))) {
    if (u.removed) continue;
    if ((u.effects || []).some((e) => e.trigger === 'onCombatStart')) {
      M.queueTrigger(state, u, 'onCombatStart', { lane });
    }
  }
}

/**
 * 这只「拟定目标攻击」的单位现在要不要问玩家 / 问 AI。
 *
 * 只在**轮到它出手的那一刻**问（作者裁决），而且同一个单位一个回合只问一次 ——
 * 「先制」和「双重打击 / 狂热」的追击都复用同一个目标，
 * 否则同一个单位会在一次开战里被问两遍。
 */
export function* pickCombatTarget(state, unit) {
  if (!unit || unit.removed || !unit.choosesTarget) return;
  // 已经定过目标就不再问：一回合只问一次（先制 + 追击共用同一个答案），
  // 也允许外部**预先**把目标放进 combatPlans（测试与自检钩子用这个口子）。
  if ((state.combatPlans || {})[unit.uid]) return;
  if (!state.combatTargetAsked) state.combatTargetAsked = {};
  if (state.combatTargetAsked[unit.uid]) return;
  state.combatTargetAsked[unit.uid] = true;

  const foe = 1 - unit.side;
  const options = [];
  for (const u of M.allUnits(state)) {
    if (u.removed || u.side !== foe) continue;
    options.push({
      uid: u.uid, side: u.side,
      // hp / atk 直接带上：AI 的挑目标策略要用（unit 引用是活的，数字不好当依据）
      hp: u.hp, atk: attackPower(state, u),
      label: `${u.name}（${attackPower(state, u)}/${u.hp}）· ${LANE_NAME[u.lane]}${u.row === 'front' ? '前排' : '后排'}`,
    });
  }
  // 打脸永远是一个合法选项 —— 作者裁决「不选就不出手」，
  // 所以选项列表不许为空（对面空场时只剩「国王」这一项）。
  options.push({ king: true, side: foe, label: `敌方国王（${state.players[foe].kingHp} 血）` });

  // ── 答案从哪来（作者裁决：玩家侧必须选、不选就不出手；AI 侧自己挑）
  //
  //   真人那一侧 → 挂起（PENDING），等界面把选项喂回来才继续出手
  //   其余（AI / 没有真人）→ 直接用策略挑（state.targetPicker，默认 combatTargetPicker）
  //
  // ⚠ 判据是 `humanSide`，**不是** `autoResolveChoices`。踩过的坑：
  //   一开始按 autoResolveChoices 判，于是「有没有人在旁边点」这个全局标志
  //   决定了某一只具体单位挂不挂起 —— 回放里那个标志和原局不一样，
  //   录下来的 {k:'c'} 就找不到挂起请求，重放直接报错；锁步也一样会分叉。
  //   现在挂起只取决于「这一方是不是真人」，所以真人那一侧的选择**必然**
  //   是一条被录下来的动作，回放与锁步都按同一串动作走，天然一致。
  //   自动化脚本没有真人，把 humanSide 设成 -1（见 tools/balance-check.mjs）。
  //   默认值是 0：没特意声明的场合（规则测试）就是「0 号是真人」。
  const isHumanSide = unit.side === (state.humanSide === undefined ? 0 : state.humanSide);
  const request = {
    type: 'combatTarget',
    side: unit.side,
    uid: unit.uid,
    prompt: `${unit.name} 要打谁？`,
    options,
    // 真人这一侧必须真的选（作者裁决：不选就不出手）。
    // noAuto 让这条请求**拒绝被自动代答**；AI 那侧不设它，
    // 于是由 choices.js 的 takeChoice 走「用 choose 算一个」那条路。
    noAuto: isHumanSide,
    // 自动结算（AI 侧）时怎么挑：state.targetPicker 优先，否则引擎自带口径
    choose: () => autoCombatTarget(state, { unit, foe, options }),
  };
  // 一律 yield，让挂起协议统一决定「挂起等人」还是「自动算一个」——
  // 判定集中在 takeChoice 一处，这里不再自己分叉（曾经分叉过一次，出了 bug）。
  const answer = yield request;

  if (!state.combatPlans) state.combatPlans = {};
  if (answer && answer.king) {
    state.combatPlans[unit.uid] = { king: true, side: foe };
    M.log(state, { type: 'combat-target', uid: unit.uid, name: unit.name, king: true, side: foe });
  } else if (answer && answer.uid != null) {
    state.combatPlans[unit.uid] = { uid: answer.uid };
    const picked = M.findUnit(state, answer.uid);
    M.log(state, {
      type: 'combat-target', uid: unit.uid, name: unit.name,
      targetUid: answer.uid, targetName: picked ? picked.name : `#${answer.uid}`,
    });
  }
}

/**
 * 自动结算（AI 侧 / 没有界面）时挑一个目标。
 *
 * 走 `state.targetPicker`（界面注入的 AI 策略），没注入就用引擎自带口径
 * （combatTargetPicker）。挑不出来（选项为空）就返回 null，
 * 调用方会把「没指定」当成「按常规优先级打」—— 属于兜底，正常不会发生。
 */
export function autoCombatTarget(state, info) {
  const picker = typeof state.targetPicker === 'function' ? state.targetPicker : combatTargetPicker;
  try {
    return picker(state, info) || null;
  } catch {
    return combatTargetPicker(state, info);
  }
}

/**
 * 开战结算时这只单位实际打谁。
 *
 * 平时按规则书的交战优先级（前排 → 后排 → 国王）。
 * 「拟定目标攻击」的单位优先用场上**当场指定**的目标：
 *   指定国王 → 返回 null（走打脸分支）
 *   指定单位 → 返回那个单位（可以跨线路）
 * 返回 undefined 表示「没指定过」，调用方沿用默认优先级。
 */
export function combatPlanPrimary(state, lane, unit) {
  if (!unit.choosesTarget) return undefined;
  const plan = (state.combatPlans || {})[unit.uid];
  if (!plan) return undefined;
  if (plan.king) return null;
  const picked = M.findUnit(state, plan.uid);
  if (picked && !picked.removed && picked.side !== unit.side) return picked;
  return undefined;
}

/**
 * 逐只问「拟定目标攻击」的单位打谁。
 *
 * 顺序固定为传入顺序（M.laneUnits 的稳定顺序：前排 → 后排），
 * 所以同样的局面问出来的顺序永远一致 —— 回放与联机锁步靠这个。
 */
export function* askCombatTargets(state, attackers) {
  for (const u of attackers) {
    if (u.removed) continue;
    yield* pickCombatTarget(state, u);
  }
}

export function* resolveLane(state, lane) {
  // 「本来会出手」的单位：攻击力 > 0 且还在场
  const wouldAttack = [
    ...M.laneUnits(state, lane, 0),
    ...M.laneUnits(state, lane, 1),
  ].filter((u) => attackPower(state, u) > 0 && !u.removed && !hasKeyword(state, u, 'cannotAttack'));

  if (wouldAttack.length === 0) return;

  /**
   * 「冻结」：被冻结的单位这一次不进行攻击，然后解除冻结（作者补充规则）。
   * 在这里消费是因为此刻已经确定它「本来要攻击」——
   * 攻击力 0 的单位永远不攻击，冻它没意义，标记会一直留着。
   */
  const attackers = M.consumeFreeze(state, wouldAttack);
  if (attackers.length === 0) return;

  M.log(state, {
    type: 'lane-combat', lane, name: LANE_NAME[lane],
    attackers: attackers.map((u) => u.uid),
  });

  /**
   * 「先制」（卡牌「侯王」：这张牌在开战时优先攻击）。
   *
   * 正常规则是同线路**同时结算** —— 就算被打死，本回合的攻击照样生效。
   * 先制打破了这一点：拥有先制的单位先单独结算一批，
   * 这批的死亡在批次结束时就落地，所以**被它打死的敌人来不及反击**。
   *
   * 先制单位自己每回合仍然只攻击一次（不在第二批里重复出手），
   * 这也正是它和「双重打击」的区别。
   */
  const firstStrikers = attackers.filter((u) => hasKeyword(state, u, 'firstStrike'));
  const normalAttackers = attackers.filter((u) => !hasKeyword(state, u, 'firstStrike'));

  // 「拟定目标攻击」：在**这一批真正出手之前**逐只问（作者裁决：轮到它才问）。
  // 必须是 generator —— 玩家侧会在 yield 处挂起，答完由 resolveChoice 继续。
  yield* askCombatTargets(state, firstStrikers);
  yield* askCombatTargets(state, normalAttackers.filter((u) => !u.removed));

  const kills = [];
  if (firstStrikers.length > 0) {
    M.log(state, { type: 'first-strike', lane, uids: firstStrikers.map((u) => u.uid) });
    kills.push(...applyAttackBatch(state, lane, firstStrikers));
  }
  const survivors = normalAttackers.filter((u) => !u.removed);
  if (survivors.length > 0) kills.push(...applyAttackBatch(state, lane, survivors));

  // ── 额外攻击（裁决 B10：每个单位每回合最多一次）
  const killedBy = new Set(kills.map((k) => k.killerUid));
  for (const u of attackers) {
    if (u.removed || isOver(state)) continue;
    if (state.extraAttackUsed[u.uid]) continue;

    const doubleStrike = hasKeyword(state, u, 'doubleStrike');
    const frenzy = hasKeyword(state, u, 'frenzy');
    const didKill = killedBy.has(u.uid);
    if (!doubleStrike && !(frenzy && didKill)) continue;

    if (doubleStrike && frenzy && didKill) {
      M.log(state, {
        type: 'extra-attack-capped', uid: u.uid,
        note: '双重打击+狂热同时满足，仍只额外攻击一次（裁决 B10）',
      });
    }
    state.extraAttackUsed[u.uid] = true;
    M.log(state, { type: 'extra-attack', uid: u.uid, lane });
    // ⚠ 追击**不再问一次**目标：上面 askCombatTargets 已经问过，combatPlans 里
    //   存着答案，collectAttackEvents 会继续用它。这里如果 try 再问一次，
    //   会踩到一个真实的坑 —— 卡牌效果触发的额外攻击（咖啡豆 / 狂犬病 / 黑龙）
    //   走的是 api.extraAttack，它的调用点只 `yield` 本身、不把嵌套的 yield
    //   往上传（只 `yield* execActions`），挂起请求会被丢掉。
    applyAttackBatch(state, lane, [u]);
    // 「有队友额外攻击时:」（派对客）—— 双重打击/狂热的追击也算额外攻击，
    // 同样要广播；否则队友靠追击出手时派对客不会抽牌。
    notifyAllyExtraAttack(state, u);
  }
}

/**
 * 执行一批攻击：先收集全部伤害事件，再「同时」结算。
 * 同线路内同时造成的伤害 = 即使某单位被打死，它本回合的攻击仍然生效。
 */
export function applyAttackBatch(state, lane, attackers) {
  const events = [];
  for (const u of attackers) collectAttackEvents(state, lane, u, events);

  // 「攻击时:」（罪恶「色欲」）：这次真的出手了才广播。
  // 排在收伤害之前入队，实际执行仍在批末的 flushTriggers（伤害与触发一起结算）。
  for (const u of attackers) M.queueTrigger(state, u, 'onAttack', { lane });

  for (const ev of events) {
    if (ev.target.kind === 'unit' && ev.target.unit.removed) continue;
    M.dealDamage(state, ev.source, ev.target, ev.amount, {
      deferDeath: true,
      // 「必中」的伤害不可被免疫（连无敌也挡不住）
      unpreventable: !!ev.unpreventable,
    });
  }

  // 统一处理死亡
  const pending = state._pendingDeaths.splice(0);
  const kills = [];
  for (const unit of pending) {
    if (unit.removed || unit.hp > 0) continue;
    kills.push({ unit, killerUid: unit.lastDamageSource });
    // unitsDestroyed 的计数在 destroyUnit 里统一加，避免两条路径各加一次
    M.destroyUnit(state, unit, 'combat');
  }

  // 「消灭敌人时:」（卡牌「无双剑豪」）—— 击杀者身上广播一次
  for (const k of kills) {
    const killer = k.killerUid != null ? M.findUnit(state, k.killerUid) : null;
    if (killer && !killer.removed) M.queueTrigger(state, killer, 'onKill', { victim: k.unit });
  }

  // 轻灵的状态检查（生命变动后可能淹死）
  for (const unit of M.allUnits(state)) M.checkNimble(state, unit);

  flushTriggers(state);
  return kills;
}

/**
 * 收集一次攻击产生的全部伤害事件：
 *   本体攻击 → 溅射（相邻线路，含后排） → 穿透（本线路额外目标，含后排，不足则溢出打国王）
 */
export function collectAttackEvents(state, lane, unit, events) {
  const foe = 1 - unit.side;
  // 伤害基数：平时是有效攻击力（含光环修正，如拷问官的 -3），ttackWithHp 的单位用当前生命
  const atk = attackPower(state, unit);

  /**
   * 「同时攻击所有敌人和敌方国王」（炼狱「活火山」的卡级旗标 sweepAllEnemies）。
   *
   * 出手时把攻击力打到**全场**敌方单位（所有线路、前后排）与敌方国王各一次，
   * 覆盖常规的交战目标 / 溅射 / 穿透分支（与「必中」同族的整体改写）。
   */
  const sweepDef = state.cardLib && state.cardLib[unit.cardId];
  if (sweepDef && sweepDef.sweepAllEnemies) {
    for (const enemy of M.allUnits(state)) {
      if (enemy.side !== foe) continue;
      events.push({ source: unit, target: { kind: 'unit', unit: enemy }, amount: atk, tag: 'sweep' });
    }
    events.push({ source: unit, target: { kind: 'king', side: foe }, amount: atk, tag: 'sweep' });
    return;
  }

  /**
   * 「必中」：攻击时忽略敌方单位的阻挡，**仅攻击国王**，且伤害不可被免疫
   * （作者补充规则）。
   *
   * 因此这条分支下：
   *   · 不看交战目标（前排/后排全部无视）
   *   · 不再结算 溅射 / 穿透 —— 它们描述的都是「打敌方单位」，
   *     而必中的原文是「仅攻击国王」。两者同时出现时以必中为准。
   *   · 伤害带 unpreventable，连「无敌」也挡不住（见 keywords 的 computeFinalDamage）
   */
  if (hasKeyword(state, unit, 'trueStrike')) {
    events.push({
      source: unit, target: { kind: 'king', side: foe }, amount: atk,
      tag: 'true-strike', unpreventable: true,
    });
    return;
  }

  // 交战目标优先级：前排 → 后排 → 国王
  let primary = M.enemyCombatTarget(state, lane, unit.side);

  /**
   * 「拟定目标攻击」（卡牌「强化士兵」）。
   *
   * 作者 2026-09 裁决（两次澄清后的最终口径）：
   *   · **开战回合轮到这张牌攻击的时候**才由玩家指定目标（不是开战前一次性问完）
   *   · 不选就不出手 → 问询是挂起式的，必须答完才继续
   *   · AI 的这张牌由 AI 自己挑，并记进战报
   *
   * 目标已经在 pickCombatTarget 里当场问出来，存在 state.combatPlans[uid] 上。
   * 指定国王 → primary 置空，走下面的打脸分支；指定单位 → 直接打它（可跨线路）。
   */
  const planned = combatPlanPrimary(state, lane, unit);
  if (planned !== undefined) primary = planned;

  if (primary) {
    events.push({ source: unit, target: { kind: 'unit', unit: primary }, amount: atk, tag: 'attack' });
  } else {
    // 前后排都没有敌方单位 → 打国王
    events.push({ source: unit, target: { kind: 'king', side: foe }, amount: atk, tag: 'attack' });
  }

  const splash = getKeyword(state, unit, 'splash');
  if (splash && splash.x > 0) {
    for (const adj of ADJACENT_LANES[lane]) {
      for (const enemy of M.laneUnits(state, adj, foe)) {
        events.push({ source: unit, target: { kind: 'unit', unit: enemy }, amount: splash.x, tag: 'splash' });
      }
    }
  }

  /**
   * 穿透 X：在**主要目标之外**额外命中 X 个本线路敌方单位（含后排）；
   * 目标不够 X 个时，缺口溢出打国王（无论缺几个，只造成一次攻击力伤害）。
   *
   * 例：只有 1 个前排单位、穿透1 → 本体打前排，穿透的 1 个额外目标找不到，
   *     缺口溢出 → 国王吃一次攻击力伤害。（作者报的 bug：早期版本这里打不到国王）
   *
   * 例外：本线路一个敌方单位都没有时，本体攻击已经打了国王，穿透不再重复加伤 ——
   *       否则空线路上「穿透1」会变成两倍打脸。这条如需调整，改这里即可。
   */
  const pierce = getKeyword(state, unit, 'pierce');
  if (pierce && pierce.x > 0 && primary) {
    const rest = M.laneUnits(state, lane, foe).filter((e) => e !== primary);
    const extraTargets = rest.slice(0, pierce.x);
    for (const e of extraTargets) {
      events.push({ source: unit, target: { kind: 'unit', unit: e }, amount: atk, tag: 'pierce' });
    }
    const shortfall = pierce.x - extraTargets.length;
    if (shortfall > 0) {
      events.push({ source: unit, target: { kind: 'king', side: foe }, amount: atk, tag: 'pierce-overflow' });
    }
  }
}

export function apiFor(state) {
  return {
    /**
     * 召唤落点的合法格（作者 2026-10-04：召唤时由玩家在场上选一个位置放下）。
     * 界面高亮格子与引擎生成选项列表共用这一份口径。
     */
    legalSummonCells(st, side, cardId) {
      const def = st.cardLib[cardId];
      if (!def) return [];
      // 与普通放置共用同一份合法性（含地形「两栖 / 轻灵」判定），见 play.js 的 legalPlacements
      return legalPlacements(st, side, def).map((p) => ({
        lane: p.lane,
        row: p.row,
        label: `${LANE_NAME[p.lane]}-${p.row === 'front' ? '前排' : '后排'}`,
      }));
    },

    summonToken(st, { cardId, side, lane, row, modify }) {
      const def = st.cardLib[cardId];
      if (!def) throw new Error(`召唤失败：卡牌库缺少 ${cardId}`);
      const probe = probeFromDef(def);
      // ⚠ 以前目标格被占就直接抛错，整条效果链跟着炸。
      //   实际会出现这种局面：死在另一排、而这条线路的两个身位都被组合队友占了；
      //   或者效果里写死的落点正好被占。召唤类效果不该因此崩掉 ——
      //   改为**就近找合法格**，实在没地方就静默跳过（写进日志便于排查）。
      const spot = findSummonSpot(st, side, probe, lane, row);
      if (!spot) {
        M.log(st, { type: 'summon-failed', cardId, side, lane, row, reason: 'no-legal-cell' });
        return null;
      }
      const unit = instantiateUnit(st, def, side, spot.lane, spot.row);
      applySummonModify(st, unit, modify);
      st.board[spot.lane].units[side][spot.row] = unit;
      M.log(st, { type: 'summon', uid: unit.uid, cardId, side, lane: spot.lane, row: spot.row });
      // 「免费打出」→ 打出效果照常触发
      M.queueTrigger(st, unit, 'onPlay', {});
      M.queueTrigger(st, unit, 'onEnterLane', { from: null, lane: spot.lane });
      resolveHunt(st, unit);
      syncStatAuras(st);
      return unit;
    },

    /**
     * 造一张手牌实例（下划线「召唤」＝加入手牌）。
     * 只进手牌，不落地 —— 落地是下个放置阶段玩家自己的选择。
     * modify 可以带 costDelta（「花费-1」）。
     */
    giveCardToHand(st, { cardId, side, modify }) {
      const def = st.cardLib[cardId];
      if (!def) throw new Error(`召唤失败：卡牌库缺少 ${cardId}`);
      const hc = { iid: st.nextIid++, cardId };
      if (modify && modify.costDelta) hc.costDelta = modify.costDelta;
      st.players[side].hand.push(hc);
      M.log(st, { type: 'summon-to-hand', cardId, side, costDelta: hc.costDelta || 0 });
    },

    /**
     * 「额外攻击一次」——立刻用这个单位打一次（卡牌「咖啡豆」「狂犬病」「黑龙」）。
     * 走开战结算的同一套原语（applyAttackBatch），所以伤害修正、溅射、穿透、
     * 死亡结算、触发队列全都和正常交战一致。
     * 每单位每回合最多一次（裁决 B10）。
     */
    /**
     * 「额外攻击一次」——立刻用这个单位打一次（卡牌「咖啡豆」「狂犬病」「黑龙」）。
     * 走开战结算的同一套原语（applyAttackBatch），所以伤害修正、溅射、穿透、
     * 死亡结算、触发队列全都和正常交战一致。
     * 每单位每回合最多一次（裁决 B10）。
     *
     * ⚠ 是 generator：开战结算原语现在是 generator 链（见文件头说明）。
     *   调用点 actions.js 用 `yield* ctx.api.extraAttack(...)`，
     *   所以将来这里若要问目标（挂起）也能正确往上传。
     */
    *extraAttack(st, unit) {
      if (!unit || unit.removed) return false;
      if (st.extraAttackUsed[unit.uid]) return false;
      st.extraAttackUsed[unit.uid] = true;
      M.log(st, { type: 'extra-attack', uid: unit.uid, lane: unit.lane, source: 'effect' });
      applyAttackBatch(st, unit.lane, [unit]);
      notifyAllyExtraAttack(st, unit);
      checkGameOver(st);
      return true;
    },
  };
}

/**
 * 「拟定目标攻击」在**自动结算**（AI 侧）下怎么挑目标。
 *
 * 这是引擎态的默认口径，`state.targetPicker` 可以覆盖它（界面注入自己的版本，
 * 见 app/js/ai.js 的 `aiTargetPicker`）。
 *
 * 口径（作者裁决：AI 自己挑最划算的）：
 *   1. 能**一击打死**的敌方单位 → 打它（白赚一个，还少吃一次反击）
 *   2. 打不死的就不浪费在单位上 → 直接打国王
 *      （攻击力打谁都是这么多，打国王是确定收益，打一个大块头等于帮对手挡刀）
 *
 * ⚠ 必须是**纯函数**、不许碰 `state.rng` —— 回放与联机锁步都靠它可复现。
 */
export function combatTargetPicker(state, info) {
  if (!state || !info || !info.options) return null;
  const atk = attackPower(state, info.unit);
  let best = null;
  for (const o of info.options) {
    if (o.king || o.uid == null) continue;
    const u = M.findUnit(state, o.uid);
    if (!u || u.removed) continue;
    const hp = o.hp === undefined ? u.hp : o.hp;
    if (atk >= hp && (!best || hp > best.hp)) best = { uid: o.uid, hp };
  }
  if (best) return info.options.find((o) => o.uid === best.uid) || null;
  return info.options.find((o) => o.king) || null;
}

/** 召唤出来的单位带数值修正（卡牌「僵尸：其将获得-2⚔-2♥和花费-1」） */
/**
 * 给召唤物找一个合法落点：优先请求的位置，然后同线路的另一个身位，
 * 最后按山地→平地左→平地右→水池的顺序找。找不到返回 null（调用方静默跳过）。
 */
export function findSummonSpot(state, side, probe, lane, row) {
  const rows = row === 'front' ? ['front', 'back'] : ['back', 'front'];
  const first = LANES.indexOf(lane) >= 0 ? lane : null;
  if (first) {
    for (const r of rows) {
      if (canPlaceUnit(state, side, probe, first, r)) return { lane: first, row: r };
    }
  }
  for (const l of LANES) {
    if (l === first) continue;
    for (const r of ['front', 'back']) {
      if (canPlaceUnit(state, side, probe, l, r)) return { lane: l, row: r };
    }
  }
  return null;
}

export function applySummonModify(state, unit, modify) {
  if (!modify) return;
  if (modify.atk) M.buffAtk(state, unit, modify.atk);
  if (modify.maxHp) {
    if (modify.maxHp > 0) M.buffMaxHp(state, unit, modify.maxHp);
    else M.debuffMaxHp(state, unit, -modify.maxHp);
  }
  for (const kw of modify.keywords || []) M.grantKeyword(state, unit, kw);
}

/** 「有队友额外攻击时:」的观察者（卡牌「派对客」） */
export function notifyAllyExtraAttack(state, attacker) {
  for (const u of M.allUnits(state)) {
    if (u.removed || u.side !== attacker.side) continue;
    if (!(u.effects || []).some((e) => e.trigger === 'onAllyExtraAttack')) continue;
    M.queueTrigger(state, u, 'onAllyExtraAttack', { attacker });
  }
}
