/**
 * 效果动作的执行：execActions / execAction（效果的 switch 主体）。
 *
 * 从 effects.js 拆出（纯搬移，行为不变）：
 *   execActions / execAction（另含条件求值 evalCondition）
 *
 * 依赖方向：mechanics/auras ← amounts/targets ← actions
 */

import { LANES, ADJACENT_LANES, LANE_NAME, SIDE_NAME } from './constants.js';
import { matchesTargetFilter } from './keywords.js';
import { filterCtx, hasRooted, getKeyword } from './auras.js';
import {
  dealDamage, destroyUnit, healUnit, healKing, buffAtk, buffMaxHp, debuffMaxHp,
  drawCards, gainMana, gainManaCap, laneUnits, allUnitsInLane, allUnits, log, freezeUnit,
  canMoveTo, moveUnitToLane, grantKeyword, vanishUnit, bounceUnit, setUnitStats,
  sealUnit, returnCardsToDeck, advanceStatStep, addDamageCap, revokeKeyword, transformUnit,
} from './mechanics.js';
import { resolveTargets } from './targets.js';
import { resolveAmount, resolveSide, asUnit, asKing } from './amounts.js';
import { queueDelayedSummon } from './factions.js';

/**
 * 执行一组效果动作。
 * ctx: { state, source, controller, card, chosenLane, chosenTargetUid, api }
 */
export function* execActions(state, ctx, actions) {
  for (const action of actions || []) {
    yield* execAction(state, ctx, action);
  }
}

/** 执行单个效果动作 */
export function* execAction(state, ctx, action) {
  const me = ctx.controller;
  const foe = 1 - me;

  switch (action.op) {
    /**
     * 「抉择」（卡牌「歼-10：打出:抉择:获-4花费和穿透1；或+4⚔+2♥和装甲1」）。
     * 效果打到一半**反问玩家**，选完再继续 —— 走的是引擎既有的挂起协议
     * （`state.autoResolveChoices = false` 时把 `{request, gen}` 存进 `state.pending`，
     * 界面渲染出来让玩家点，然后 `resolveChoice` 恢复）。
     * AI 侧因为 `autoResolveChoices` 恒为 true，会取第一个选项。
     */
    case 'choose': {
      const options = action.options || [];
      if (!options.length) break;
      const answer = yield {
        type: 'chooseOption',
        side: me,
        prompt: action.prompt || '选择一项',
        options: options.map((o, i) => ({ index: i, label: o.label || `选项${i + 1}` })),
      };
      const idx = answer && typeof answer.index === 'number' ? answer.index : 0;
      const picked = options[idx] || options[0];
      yield* execActions(state, ctx, picked.actions || []);
      break;
    }

    // ── 失效 / 状态
    /**
     * 「无法选中」状态（卡牌「神威：令一名队友无法选中一回合」）。
     * 挂一个带到期回合的标记，`matchesTargetFilter` 会拒绝它 —— 什么都不能选它。
     * 到期清理在 engine 的 onTurnEnd（和有时限词条一起）。
     */
    case 'untargetable': {
      const targets = yield* resolveTargets(state, ctx, action.target || { kind: 'chosenOwnUnit' });
      const turns = action.turns === undefined ? 1 : resolveAmount(state, ctx, action.turns);
      for (const t of targets) {
        if (t.kind !== 'unit' || t.unit.removed) continue;
        t.unit.marks.push({ type: 'untargetable', untilTurn: state.turn + turns - 1 });
        log(state, { type: 'untargetable', uid: t.unit.uid, untilTurn: state.turn + turns - 1 });
      }
      break;
    }

    /**
     * 撤掉一个词条。用于「卫兵」——作者裁定「在封印异能之后就可以攻击了」，
     * 所以封印的同时要把它身上的「无法攻击」摘掉。
     */
    case 'revokeKeyword': {
      const targets = yield* resolveTargets(state, ctx, action.target || { kind: 'self' });
      for (const t of targets) {
        if (t.kind !== 'unit' || t.unit.removed) continue;
        revokeKeyword(state, t.unit, action.keyword);
      }
      break;
    }

    /** 「依次变为」（卡牌「劫匪团队」）：每次触发往后走一格身材 */
    case 'cycleStats': {
      const targets = yield* resolveTargets(state, ctx, action.target || { kind: 'self' });
      for (const t of targets) {
        if (t.kind !== 'unit' || t.unit.removed) continue;
        advanceStatStep(state, t.unit, action.steps || []);
      }
      break;
    }

    /**
     * 「本回合，所有敌方卡牌造成的伤害至多为 X」（卡牌「反应装甲」）。
     * side 写的是**被限制的那一方**：'opponent' = 对手打出的伤害被封顶。
     */
    case 'capDamage': {
      const side = resolveSide(action.side === undefined ? 'opponent' : action.side, me);
      addDamageCap(state, side, resolveAmount(state, ctx, action.value), action.turns || 1);
      break;
    }

    /**
     * 条件分支（卡牌「四号坦克H型：若场上敌人数不大于队友数,获双重打击,否则,额外攻击一次」）。
     * `if` 目前支持 `{ compare: 'enemiesLEAllies' }` 与 `{ compare: 'enemiesLTAllies' }`。
     */
    case 'conditional': {
      const ok = evalCondition(state, ctx, action.if);
      yield* execActions(state, ctx, ok ? (action.then || []) : (action.else || []));
      break;
    }

    /**
     * 「偷取对方国王 1 币」（卡牌「盗贼」）。
     * **作者 2026-09 裁决**：改成局内效果 —— 对方**下回合少 1 点费用**。
     * 记在对方身上的 `manaPenalty` 上，由 engine 的回合开始费用重置去结清。
     */
    case 'taxMana': {
      const side = resolveSide(action.side === undefined ? 'opponent' : action.side, me);
      const amount = resolveAmount(state, ctx, action.amount === undefined ? 1 : action.amount);
      state.players[side].manaPenalty = (state.players[side].manaPenalty || 0) + amount;
      log(state, { type: 'mana-tax', side, amount, total: state.players[side].manaPenalty });
      break;
    }

    // ── 造成伤害
    case 'damage': {
      const targets = yield* resolveTargets(state, ctx, action.target);
      for (const t of targets) {
        if (t.kind === 'unit' && t.unit.removed) continue;
        dealDamage(state, ctx.source || null, t, resolveAmount(state, ctx, action.amount, t), {
          ignoreMechanisms: !!action.ignoreMechanisms,
          noKeywords: !!action.noKeywords || !!ctx.noKeywordsForDamage,
          // 「有敌人受到伤害时」的观察者自身造成的伤害不再惊动观察者，防无限连锁
          noWatchers: !!action.noWatchers || !!ctx.noWatchersForDamage,
          // 「受到伤害:」异能自己造成的伤害不再触发「受到伤害:」，防无限递归
          noDamagedTrigger: !!action.noDamagedTrigger || !!ctx.noDamagedTriggerForDamage,
        });
        // 「视为攻击」（卡牌「橄榄球」：锦囊带「溅射1」）——
        // 锦囊本身不进行攻击，所以溅射要靠这个开关显式打开：
        // 打完主目标之后，按来源（锦囊的虚拟来源）身上的溅射词条溅到相邻线路。
        if (action.asAttack && ctx.source && t.kind === 'unit' && !t.unit.removed) {
          const splash = getKeyword(state, ctx.source, 'splash');
          if (splash && splash.x > 0) {
            // 「敌方单位」是相对**来源**说的，不是相对主目标
            const foeSide = 1 - ctx.source.side;
            for (const adj of ADJACENT_LANES[t.unit.lane]) {
              for (const e of laneUnits(state, adj, foeSide)) {
                if (e.removed) continue;
                dealDamage(state, ctx.source, { kind: 'unit', unit: e }, splash.x, { noCap: true });
              }
            }
          }
        }
      }
      break;
    }

    // ── 消灭
    case 'destroy': {
      const targets = yield* resolveTargets(state, ctx, action.target);
      for (const t of targets) {
        if (t.kind === 'unit') destroyUnit(state, t.unit, action.reason || 'effect');
        else if (action.allowKing) state.players[t.side].kingHp = 0;
      }
      break;
    }

    // ── 献祭（裁决 B14：机制动作，不可献祭自身）
    case 'sacrifice': {
      let targets = yield* resolveTargets(state, ctx, action.target || { kind: 'chosenOwnUnit' });
      targets = targets.filter((t) => t.kind === 'unit' && t.unit !== ctx.source);
      for (const t of targets) {
        /**
         * 记下被献祭的单位：同一条效果链里后面还要用它
         * （鲜血祭典按它的攻击力回复、恶魔虚影按次数成长）。
         */
        ctx.sacrificed = {
          uid: t.unit.uid, cardId: t.unit.cardId, atk: t.unit.atk || 0, hp: t.unit.hp || 0, side: t.unit.side,
        };
        destroyUnit(state, t.unit, 'sacrifice');
      }
      break;
    }

    // ── 抽牌
    case 'draw': {
      const side = resolveSide(action.side, me);
      // 「其每具有一个词条，抽一张牌」这类需要看目标 —— 先解析目标再算数量
      let n;
      if (action.target) {
        const targets = yield* resolveTargets(state, ctx, action.target);
        n = resolveAmount(state, ctx, action.amount, targets[0]);
      } else {
        n = resolveAmount(state, ctx, action.amount);
      }
      drawCards(state, side, n);
      break;
    }

    // ── 费用 / 费用上限
    case 'gainMana': {
      gainMana(state, resolveSide(action.side, me), action.amount);
      break;
    }
    case 'gainManaCap': {
      gainManaCap(state, resolveSide(action.side, me), action.amount);
      break;
    }

    // ── 单位 / 国王数值操作
    case 'heal': {
      const targets = yield* resolveTargets(state, ctx, action.target);
      for (const t of targets) {
        if (t.kind === 'unit') healUnit(state, t.unit, resolveAmount(state, ctx, action.amount, t));
        else if (t.kind === 'king') {
          // mode:'halfLost' = 回复「已损失生命值的一半」（卡牌「紧急包扎」），向上取整
          let amount = resolveAmount(state, ctx, action.amount, t);
          if (action.mode === 'halfLost') {
            const p = state.players[t.side];
            amount = Math.ceil(Math.max(0, p.kingMaxHp - p.kingHp) / 2);
          }
          healKing(state, t.side, amount);
        }
      }
      break;
    }
    case 'buffAtk': {
      const targets = yield* resolveTargets(state, ctx, action.target);
      for (const t of targets) {
        if (t.kind === 'unit') buffAtk(state, t.unit, resolveAmount(state, ctx, action.amount, t));
      }
      break;
    }
    case 'buffMaxHp': {
      const targets = yield* resolveTargets(state, ctx, action.target);
      for (const t of targets) {
        if (t.kind === 'unit') buffMaxHp(state, t.unit, resolveAmount(state, ctx, action.amount, t));
      }
      break;
    }

    /**
     * 一次性 +/- 攻防（卡牌「骨折：一名敌人获得-2⚔-1♥」）。
     *
     * 为什么需要这个 op：攻击力和生命上限必须作用在**同一个**目标上，
     * 而每个动作各自解析目标 —— 拆成 buffAtk + debuffMaxHp 会让玩家选两次。
     * 正面数值走 buff*，负数走 debuff*（只有减上限需要处理被打死的情况）。
     */
    case 'modifyStats': {
      const targets = yield* resolveTargets(state, ctx, action.target);
      for (const t of targets) {
        if (t.kind !== 'unit' || t.unit.removed) continue;
        const atk = resolveAmount(state, ctx, action.atk, t);
        const maxHp = resolveAmount(state, ctx, action.maxHp, t);
        if (atk) buffAtk(state, t.unit, atk);
        if (maxHp > 0) buffMaxHp(state, t.unit, maxHp);
        else if (maxHp < 0) debuffMaxHp(state, t.unit, -maxHp);
      }
      break;
    }

    /**
     * 把数值**设为固定值**（卡牌「永恒秘典：回合开始:♥变为4」）。
     * 与 modifyStats 的区别：那是加减，这是设值。
     * `maxHp` 省略时只改当前生命、不动上限。
     */
    case 'setStats': {
      const targets = yield* resolveTargets(state, ctx, action.target);
      for (const t of targets) {
        if (t.kind !== 'unit' || t.unit.removed) continue;
        setUnitStats(state, t.unit, {
          hp: action.hp !== undefined ? resolveAmount(state, ctx, action.hp, t) : undefined,
          maxHp: action.maxHp !== undefined ? resolveAmount(state, ctx, action.maxHp, t) : undefined,
          atk: action.atk !== undefined ? resolveAmount(state, ctx, action.atk, t) : undefined,
        });
      }
      break;
    }

    /**
     * **变形**：把目标单位就地变成 action.cardId 那张牌（卡牌「魔术师：让一名敌人变为 令牌[兔子]」）。
     *
     * 与 setStats 的区别：setStats 只改数值，名字/词条/异能都留在原单位身上；
     * transform 是整只换掉（作者 2026-09 裁决：「应该将敌方场上的一个单位变为 令牌[兔子]，
     * 而不是只改变攻击力和生命」）。细节口径见 mechanics.js 的 transformUnit。
     */
    case 'transform': {
      const targets = yield* resolveTargets(state, ctx, action.target);
      for (const t of targets) {
        if (t.kind !== 'unit' || t.unit.removed) continue;
        transformUnit(state, t.unit, action.cardId);
      }
      break;
    }

    /**
     * 给国王附着一个永久被动（卡牌「战略纵深」）。
     * 可以叠加 —— 打两次就是每次友方单位被消灭抽两张牌。
     */
    case 'attachKingEffect': {
      const side = resolveSide(action.side, me);
      const p = state.players[side];
      if (!Array.isArray(p.kingEffects)) p.kingEffects = [];
      p.kingEffects.push(...(action.effects || []));
      log(state, { type: 'king-effect-attached', side, effects: (action.effects || []).map((e) => e.trigger) });
      break;
    }

    // ── 冻结（作者补充规则）：下一次攻击不进行，然后解除冻结
    case 'freeze': {
      const targets = yield* resolveTargets(state, ctx, action.target);
      for (const t of targets) {
        if (t.kind === 'unit' && !t.unit.removed) freezeUnit(state, t.unit);
      }
      break;
    }

    /**
     * 「额外攻击一次」——**立即**用目标单位打一次（卡牌「咖啡豆」「狂犬病」「黑龙」）。
     *
     * 与「双重打击」的区别：那是**交战之后**的追加，这里是当下立刻打。
     * 每单位每回合仍然最多额外攻击一次（裁决 B10），走 state.extraAttackUsed。
     * 实际的开战结算原语在 engine.js，通过 api 回调进来（避免 effects → engine 反向依赖）。
     */
    case 'extraAttack': {
      if (!ctx.api || !ctx.api.extraAttack) throw new Error('缺少 extraAttack api');
      const targets = yield* resolveTargets(state, ctx, action.target || { kind: 'chosenOwnUnit' });
      for (const t of targets) {
        if (t.kind !== 'unit' || t.unit.removed) continue;
        // yield*：额外攻击本身是 generator 链（开战结算原语），这里把可能的挂起往上传
        yield* ctx.api.extraAttack(state, t.unit);
      }
      break;
    }

    /**
     * 封印一个单位（卡牌「禁军」「大封印碑」「卫兵」）。
     * 作者裁决 D62：**除攻击力与生命之外的一切失效**（异能含遗言 / 词条 / 光环），
     * 永久到离场。见 `stats.js` 的 `sealUnit`。
     */
    case 'seal': {
      const targets = yield* resolveTargets(state, ctx, action.target || { kind: 'chosenEnemyUnit' });
      for (const t of targets) if (t.kind === 'unit') sealUnit(state, t.unit, action.reason || 'seal');
      break;
    }

    /**
     * 线路封锁（卡牌「氢弹：令平地不可放置单位一回合」）。
     * `turns: 1` 表示「施放当回合 + 下一个回合」—— 因为锦囊是在放置阶段之后打的，
     * 只锁当回合等于没锁，真正生效的是下一回合的放置阶段。
     */
    case 'lockLane': {
      const lanes = action.lanes || (action.lane ? [action.lane] : []);
      if (lanes.length === 0) throw new Error('lockLane 需要 lane 或 lanes');
      const turns = action.turns === undefined ? 1 : resolveAmount(state, ctx, action.turns);
      for (const l of lanes) {
        if (!LANES.includes(l)) throw new Error(`lockLane: 未知线路 ${l}`);
        state.laneLocks[l] = state.turn + turns;
      }
      log(state, { type: 'lane-lock', lanes, until: state.turn + turns });
      break;
    }

    /**
     * 弃掉「刚刚被抽到的那几张牌」（卡牌「希佩尔海军上将号：敌方抽牌时,将其弃置」）。
     * 牌从触发 payload 的 `cards` 里来 —— 由 mechanics.drawCards 广播。
     * 默认弃**抽牌方**的牌。
     */
    case 'discardDrawn': {
      const side = resolveSide(action.side === undefined ? 'opponent' : action.side, me);
      const cards = (ctx.payload && ctx.payload.cards) || [];
      const p = state.players[side];
      let n = 0;
      for (const cardId of cards) {
        const idx = p.hand.findIndex((c) => c.cardId === cardId);
        if (idx < 0) continue;
        const [gone] = p.hand.splice(idx, 1);
        state.discard.push(gone.cardId);
        n++;
      }
      log(state, { type: 'discard-drawn', side, count: n });
      break;
    }

    /**
     * 牌堆操作（卡牌「回收」把手牌洗回牌组、「利波尔德」把敌方锦囊返回牌堆顶）。
     * from: 'hand' | 'board'      to: 'top' | 'shuffle'
     * `count` 指定张数时会**让玩家挑**（不指定就是符合条件的一整批）。
     */
    case 'returnToDeck': {
      const side = resolveSide(action.side, me);
      const p = state.players[side];
      const from = action.from || 'hand';
      const to = action.to || 'top';
      const match = action.cardFilter
        ? (c) => {
          const d = state.cardLib[c.cardId] || {};
          if (action.cardFilter.type && d.type !== action.cardFilter.type) return false;
          if (action.cardFilter.spellKind && d.spellKind !== action.cardFilter.spellKind) return false;
          return true;
        }
        : () => true;

      if (from === 'hand') {
        const pool = p.hand.filter(match);
        const want = action.count === undefined
          ? pool.length
          : Math.max(0, Math.min(pool.length, resolveAmount(state, ctx, action.count)));
        const picked = [];
        while (picked.length < want && pool.length > 0) {
          if (pool.length === 1 || want === pool.length) { picked.push(pool.shift()); continue; }
          const answer = yield {
            type: 'chooseHandCard',
            side,
            prompt: action.prompt || '选择要放回牌组的牌',
            options: pool.map((c) => ({
              iid: c.iid,
              label: (state.cardLib[c.cardId] && state.cardLib[c.cardId].name) || c.cardId,
            })),
          };
          let idx = pool.findIndex((c) => c.iid === (answer && answer.iid));
          if (idx < 0) idx = 0;
          picked.push(pool.splice(idx, 1)[0]);
        }
        const ids = new Set(picked.map((c) => c.iid));
        p.hand = p.hand.filter((c) => !ids.has(c.iid));
        returnCardsToDeck(state, picked.map((c) => c.cardId), to);
      } else if (from === 'board') {
        const targets = yield* resolveTargets(state, ctx, action.target || { kind: 'chosenEnemyUnit' });
        for (const t of targets) {
          if (t.kind !== 'unit' || t.unit.removed) continue;
          const cardId = t.unit.cardId;
          vanishUnit(state, t.unit, 'return-to-deck');
          returnCardsToDeck(state, [cardId], to);
        }
      }
      break;
    }

    /**
     * 改手牌的**费用**（卡牌「神秘礼物」「僵尸」，作者裁定可以有「-1 花费」）。
     * 作用对象是发牌方手牌里符合 cardFilter 的那些；不写 cardFilter 就是全部手牌。
     */
    case 'modifyHandCost': {
      const side = resolveSide(action.side, me);
      const p = state.players[side];
      const delta = resolveAmount(state, ctx, action.amount);
      let n = 0;
      for (const c of p.hand) {
        const d = state.cardLib[c.cardId];
        if (!d) continue;
        if (action.cardFilter) {
          if (action.cardFilter.type && d.type !== action.cardFilter.type) continue;
          if (action.cardFilter.spellKind && d.spellKind !== action.cardFilter.spellKind) continue;
        }
        c.costDelta = (c.costDelta || 0) + delta;
        n++;
      }
      log(state, { type: 'hand-cost', side, delta, count: n });
      break;
    }

    // ── 召唤衍生物
    case 'summon': {
      if (!ctx.api || !ctx.api.summonToken) throw new Error('缺少 summonToken api');
      const lane = action.lane || ctx.chosenLane;
      const row = action.row || 'front';
      ctx.api.summonToken(state, {
        cardId: action.cardId, side: resolveSide(action.side, me), lane, row,
        modify: action.modify || null,
      });
      break;
    }

    /**
     * 「下个大回合开始时召唤」（阵营超能力「召唤仪式」）。
     * 这里只排队；真正的召唤在 turns.js 的 onTurnStart 里做
     * （那时才是「大回合开始」的唯一时刻，也才保证只结算一次）。
     */
    case 'delayedSummon': {
      const side = resolveSide(action.side, me);
      queueDelayedSummon(state, side, action.cardId, resolveAmount(state, ctx, action.delay === undefined ? 1 : action.delay));
      break;
    }

    /**
     * 召唤到**手牌**（作者补充规则：卡面里带下划线的「召唤」＝加入手牌）。
     * 与 summon 的区别：不落地，只造一张手牌实例。
     */
    case 'summonToHand': {
      if (!ctx.api || !ctx.api.giveCardToHand) throw new Error('缺少 giveCardToHand api');
      const side = resolveSide(action.side, me);
      const n = resolveAmount(state, ctx, action.count || 1);
      const modify = resolveSummonModify(state, ctx, action.modify);
      for (let i = 0; i < n; i++) {
        ctx.api.giveCardToHand(state, {
          cardId: action.cardId, side, modify,
        });
      }
      break;
    }

    /**
     * 「移动」——卡牌「转移：移动一名队友」。
     *
     * 两步选择：先选移谁（target 选择器），再选移到哪条线路。
     * 目的地已经写死（action.lane）或调用方直接指定（ctx.chosenLane）时不再问。
     * 「扎根」的单位移不动（canMoveTo 会挡掉）。
     */
    case 'move': {
      const targets = yield* resolveTargets(state, ctx, action.target || { kind: 'chosenOwnUnit' });
      for (const t of targets) {
        if (t.kind !== 'unit' || t.unit.removed) continue;
        const isRootedFn = (u) => hasRooted(state, u);

        if (action.lane) {
          moveUnitToLane(state, t.unit, action.lane, { isRooted: isRootedFn });
          continue;
        }
        const lanes = LANES.filter((l) => canMoveTo(state, t.unit, l, { isRooted: isRootedFn }));
        if (lanes.length === 0) continue;
        const answer = yield {
          type: 'chooseLane',
          side: me,
          prompt: action.prompt || `把「${t.unit.name}」移到哪条线路`,
          options: lanes.map((l) => ({ lane: l, label: LANE_NAME[l] })),
        };
        if (answer && answer.lane) moveUnitToLane(state, t.unit, answer.lane, { isRooted: isRootedFn });
      }
      break;
    }

    /**
     * 弃置手牌（卡牌「第5伞兵旅：回合开始:抽两张牌,弃置一张手牌」）。
     * 需要挑选时会向驱动器提问；autoResolveChoices 下取第一张。
     */
    case 'discard': {
      const side = resolveSide(action.side, me);
      const n = action.amount || 1;
      for (let i = 0; i < n; i++) {
        const p = state.players[side];
        if (!p.hand.length) break;
        let pickedIid = null;
        if (p.hand.length > 1) {
          const answer = yield {
            type: 'chooseHandCard',
            side,
            prompt: action.prompt || '选择要弃置的手牌',
            options: p.hand.map((c) => ({
              iid: c.iid,
              label: (state.cardLib[c.cardId] && state.cardLib[c.cardId].name) || c.cardId,
            })),
          };
          pickedIid = answer ? answer.iid : null;
        }
        let idx = p.hand.findIndex((c) => c.iid === pickedIid);
        if (idx < 0) idx = 0;
        const [gone] = p.hand.splice(idx, 1);
        state.discard.push(gone.cardId);
        log(state, { type: 'discard', side, cardId: gone.cardId });
      }
      break;
    }

    /**
     * 永久授予一个词条（卡牌「狂犬病：一名队友获得疾病」）。
     * 与光环不同：写进单位本身，来源离场也不会消失。
     */
    case 'grantKeyword': {
      const targets = yield* resolveTargets(state, ctx, action.target);
      for (const t of targets) {
        if (t.kind !== 'unit' || t.unit.removed) continue;
        grantKeyword(state, t.unit, action.keyword, action.x || 0,
          { untilTurn: action.untilTurnEnd ? state.turn : null });
      }
      break;
    }

    /**
     * 把一名敌方单位「置入你的手牌」（卡牌「战时盟国」）。
     *
     * 按「离场但不算被消灭」处理：不触发它的 onDeath，
     * 也不触发对方国王的「友方单位被消灭时」被动 —— 它只是换了个地方。
     */
    case 'stealToHand': {
      const targets = yield* resolveTargets(state, ctx, action.target || { kind: 'chosenEnemyUnit' });
      for (const t of targets) {
        if (t.kind !== 'unit' || t.unit.removed) continue;
        const stolen = t.unit;
        const cardId = stolen.cardId;
        vanishUnit(state, stolen, 'steal');
        state.players[me].hand.push({ iid: state.nextIid++, cardId });
        log(state, { type: 'steal-to-hand', cardId, side: me });
      }
      break;
    }

    /**
     * 「弹射」——作者裁决：把目标单位**退回其拥有者的手牌**。
     * 「扎根」的单位弹不动（扎根 = 无法被弹射）。
     */
    case 'bounce': {
      const targets = yield* resolveTargets(state, ctx, action.target || { kind: 'chosenEnemyUnit' });
      for (const t of targets) {
        if (t.kind !== 'unit' || t.unit.removed) continue;
        bounceUnit(state, t.unit, {
          isRooted: (u) => hasRooted(state, u),
          // 「回手后保留加成」（作者裁决，卡牌「扫地僧」）
          keepStats: !!action.preserveStats,
        });
      }
      break;
    }

    default:
      throw new Error(`未知的效果 op: ${action.op}`);
  }
}

/** `conditional` op 的条件求值 */
export function evalCondition(state, ctx, cond) {  if (!cond) return false;
  if (typeof cond === 'function') return !!cond(state, ctx);
  const me = ctx.controller;
  const own = allUnits(state).filter((u) => u.side === me).length;
  const foe = allUnits(state).filter((u) => u.side !== me).length;
  switch (cond.compare) {
    case 'enemiesLEAllies': return foe <= own;
    case 'enemiesLTAllies': return foe < own;
    case 'enemiesGEAllies': return foe >= own;
    case 'enemiesGTAllies': return foe > own;
    default: throw new Error(`未知的 conditional 条件: ${JSON.stringify(cond)}`);
  }
}

/**
 * 召唤物的数值修正里，**动态字段**在这里解析。
 *
 * 目前只有 `costDelta` 可能是表达式：僵尸「其花费增加1」要写成
 *   modify: { costDelta: { sourceCostDelta: true, plus: 1 } }
 * 意思是「这张牌上一代被加了多少费，再加 1」—— 于是 5→6→7→8 逐代累加
 * （作者 2026-09 裁决）。`summon`（到场上）不用这个，因为它没有费用。
 */
function resolveSummonModify(state, ctx, modify) {
  if (!modify) return null;
  if (modify.costDelta === undefined || modify.costDelta === null) return modify;
  if (typeof modify.costDelta === 'number') return modify;
  return { ...modify, costDelta: resolveAmount(state, ctx, modify.costDelta) };
}
