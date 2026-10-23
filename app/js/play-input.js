/**
 * 玩家输入：手牌选中与合法性、锦囊目标分析、出牌提交、
 * 点格子/点单位/点国王的点击处理，以及 data-act 路由（handleAction）。
 *
 * 与 app/js 其它模块共享同一个打包作用域（见 tools/build-web.mjs）：
 * screen/state/view/session/recording/rpUI 等共享状态直接按裸名字读写，
 * 以及 doAction/refresh/tick/... 等同作用域函数，都不需要 import。
 *
 * ⚠ 下面 `NO_CHOICE_TARGET_KINDS` → `analyzeSpell` → `isPlayable` 三个的相邻顺序
 *   不能变：tools/check-bundle.mjs 有一段源码级断言按 indexOf 切片解析它们。
 */

import * as G from '../../engine/src/engine.js';
import * as M from '../../engine/src/mechanics.js';
import { LANES, LANE_NAME, ROWS } from '../../engine/src/constants.js';
import { matchesTargetFilter } from '../../engine/src/keywords.js';
import { filterCtx } from '../../engine/src/auras.js';
import * as RP from './replay.js';
import * as Net from './multiplayer.js';
import * as Enh from './enhance.js';
import * as Eco from './economy.js';
import * as Store from './store.js';
import * as Cloud from './cloud.js';
import { TEST_CARD_LIB } from '../../engine/cards/test-cards.js';

/** 账户页 / 管理页的输入框读取：DOM 桩里没有这些节点时安静返回空串 */
function inputValue(id) {
  try {
    const el = document.getElementById(id);
    return el && el.value !== undefined ? String(el.value) : '';
  } catch {
    return '';
  }
}

/**
 * 不需要玩家选择的目标选择器 —— 引擎自己就能确定目标。
 * 一张锦囊只要**没有**需要点选的选择器，选中后就应该直接打出。
 */
const NO_CHOICE_TARGET_KINDS = new Set([
  'self', 'ownKing', 'enemyKing', 'allOwnUnits', 'allEnemyUnits', 'allUnits', 'triggerVictim',
  // 「全部线路的所有敌方单位」（溅射那类）也不需要玩家点选
  'allLanesEnemyUnitsInLane',
  // 触发语境下用「来源所在线路」的选择器，自己会取 unit.lane
  'allUnitsInLane',
  // 「生命最低的敌方单位」由引擎自己挑（鲸鲨），不需要点选
  'lowestHpEnemyUnit',
  // 极寒 / 罪恶新增的批量与择优选择器（引擎自己挑，不需要点选）
  'allFrozenEnemyUnits',
  'highestAtkEnemyUnit',
  // 选线由 chooseLanes 动作在前一步问过，这里不再点选
  'chosenLanesEnemyUnits',
  // ?????????compound op??????????????????
  'compoundTarget',
  // ??????????payloadUnit???????????????????? payload
  'payloadUnit',
]);

/** 分析一张锦囊需要什么目标，返回 { unitTargets:[uid], lanes:[lane], kingTargets:[side], needsChoice } */
function analyzeSpell(def) {
  const unitTargets = new Set();
  const lanes = new Set();
  const kingTargets = new Set();
  let needsChoice = false;

  for (const spec of (def.actions || []).map((a) => a.target).filter(Boolean)) {
    // 「自己的国王」「敌方所有单位」这类不需要点选，引擎自己会确定
    if (NO_CHOICE_TARGET_KINDS.has(spec.kind)) continue;
    needsChoice = true;

    if (spec.kind === 'chosenEnemyUnit' || spec.kind === 'chosenEnemyFront' || spec.kind === 'chosenEnemyTarget') {
      for (const lane of LANES) {
        for (const row of ROWS) {
          const u = state.board[lane].units[foe()][row];
          if (!u) continue;
          if (spec.kind === 'chosenEnemyFront' && row !== 'front') continue;
          // 与引擎共用同一个过滤器，保证界面高亮的目标一定能打出
          if (!matchesTargetFilter(u, spec.filter, filterCtx(state))) continue;
          unitTargets.add(u.uid);
        }
      }
      // 「造成X点伤害」这类牌还可以选敌方国王（作者裁决）
      if (spec.kind === 'chosenEnemyTarget' && spec.allowKing !== false) {
        kingTargets.add(foe());
      }
    } else if (spec.kind === 'chosenAnyUnit') {
      // 卡面写「一个单位」没说敌我（第3补给营）：两侧都亮，玩家点谁算谁
      for (const side of [me(), foe()]) {
        for (const lane of LANES) {
          for (const row of ROWS) {
            const u = state.board[lane].units[side][row];
            if (!u) continue;
            if (!matchesTargetFilter(u, spec.filter, filterCtx(state))) continue;
            unitTargets.add(u.uid);
          }
        }
      }
    } else if (spec.kind === 'chosenOwnUnit') {
      for (const lane of LANES) {
        for (const row of ROWS) {
          const u = state.board[lane].units[me()][row];
          if (!u) continue;
          if (!matchesTargetFilter(u, spec.filter, filterCtx(state))) continue;
          unitTargets.add(u.uid);
        }
      }
    } else if (spec.kind === 'allEnemyUnitsInLane' || spec.kind === 'adjacentEnemyUnits') {
      for (const lane of LANES) lanes.add(lane);
    }
  }
  return {
    unitTargets: [...unitTargets],
    lanes: [...lanes],
    kingTargets: [...kingTargets],
    needsChoice,
  };
}

/** 这张牌现在能不能出（用于把不能出的手牌置灰） */
function isPlayable(def, places) {
  if (def.type === 'unit') return places.length > 0;
  const { unitTargets, lanes, kingTargets, needsChoice } = analyzeSpell(def);
  if (!needsChoice) return true;                       // 无需点选，直接可出
  return unitTargets.length > 0 || lanes.length > 0 || kingTargets.length > 0;
}

function computePlayable() {
  view.playableIids = [];
  // 刚启动、还没打过任何一局时 state 是 null（例如直接从首页进回放）。
  // 这里必须兜住：以前回放分支也调这个函数，冷启动点「回放」会直接抛
  // TypeError，refresh() 中断在中间 —— 界面停在回放列表，看着就是「点了没反应」。
  if (!state) return;
  // 召唤落点：挂起问位置时把合法格交给界面高亮（见 engine/src/actions.js 的 askSummonCell）
  const rq = state.pending && state.pending.request;
  view.legalSummonCells = rq && rq.type === 'summonCell'
    ? (rq.options || []).filter((o) => o.lane && o.row)
    : [];
  if (state.winner !== null) return;
  /**
   * 靶场（作者 2026-10-22）：手里的**每一张**都能出。
   * 引擎那边 playCard 也不再校验阶段 / 费用 / 落点，所以这里不做任何过滤 ——
   * 少画一个高亮就会让人以为「这张牌不能试」。
   */
  if (state.sandbox === true) {
    for (const hc of state.players[me()].hand) view.playableIids.push(hc.iid);
    return;
  }
  if (G.getActor(state) !== me()) return;
  for (const play of G.getLegalPlays(state, me())) {
    const def = state.cardLib[play.cardId];
    if (def && isPlayable(def, play.places)) view.playableIids.push(play.iid);
  }
}

function clearSelection() {
  view.selectedIid = null;
  view.sacMode = false;
  view.brewIids = [];
  view.legalSlots = [];
  view.legalUnitTargets = [];
  view.legalLanes = [];
  view.legalKingTargets = [];
  view.legalSummonCells = [];
  view.infoUid = null;
  view.hint = '';
  // 两步放置与长按拖动的中间态（作者 2026-10）：
  // pickedSlot 是「点过一次、还没确认」的落点；dragIid 是正被拖着走的牌。
  view.pickedSlot = null;
  view.dragIid = null;
  view.dragOver = null;
  view.dragSeen = null;
}

/**
 * 炼金「炼药」多选（作者 2026-10-07）：点一张原料选中、再点同一张取消。
 * 不足两张只看张数，够两张就把「花费 + 会出哪张令牌」写进提示行。
 */
function toggleBrewPick(iid) {
  if (!Array.isArray(view.brewIids)) view.brewIids = [];
  view.selectedIid = null;
  view.sacMode = false;
  const at = view.brewIids.indexOf(iid);
  if (at >= 0) view.brewIids.splice(at, 1);
  else view.brewIids.push(iid);
  const p = state.players[me()];
  const ids = [];
  let cost = 0;
  for (const each of view.brewIids) {
    const hc = p.hand.find((c) => c.iid === each);
    if (!hc) continue;
    ids.push(hc.cardId);
    cost += G.costOf(state, hc);
  }
  if (ids.length < 2) {
    view.hint = '炼药：已选 ' + ids.length + ' 张原料，再选一张才能炼';
  } else {
    const token = G.comboTokenFor(ids);
    view.hint = '炼药：已选 ' + ids.length + ' 张，花费 ' + cost + '，'
      + (token ? ((state.cardLib[token] || {}).name || token) : '这个组合出不了令牌');
  }
  refresh();
}

/** 观战者（只读连接）点棋盘 / 手牌一律无效 —— 出牌只有两端能做 */
function isWatching() {
  return !!(session && session.isWatcher);
}

function selectCard(iid) {
  if (isWatching()) return;
  if (view.busy || state.winner !== null) return;
  // 靶场：不看「现在轮到谁」—— 自动阶段（回合开始 / 开战）里也想试牌
  if (state.sandbox !== true && G.getActor(state) !== me()) return;
  clearTimeout(autoAdvanceTimer);

  if (view.selectedIid === iid) {
    clearSelection();
    refresh();
    return;
  }

  const hc = state.players[me()].hand.find((c) => c.iid === iid);
  if (!hc) return;
  const def = state.cardLib[hc.cardId];
  const p = state.players[me()];

  /**
   * 靶场（作者 2026-10-22）：不校验费用 / 落点 / 阶段。
   *   · 单位牌 —— 两家所有空格都点得动，点哪边就放到哪边
   *   · 锦囊牌 —— 任何单位 / 国王 / 线路都能指定
   */
  if (state.sandbox === true) {
    view.selectedIid = iid;
    view.pickedSlot = null;
    view.legalSummonCells = [];
    view.legalUnitTargets = [];
    view.legalLanes = [];
    view.legalKingTargets = [];
    view.pickOpen = false;
    if (def.type === 'unit') {
      /**
       * 落点**包括已经有单位的格子**（作者 2026-10-23 第 3 条）：放上去就把旧的顶掉。
       * 以前这里只收空格，想在同一个坑位换一张牌必须先「清空场地」。
       */
      const slots = [];
      for (const lane of LANES) {
        for (const side of [0, 1]) {
          for (const row of ROWS) slots.push({ lane, row, side });
        }
      }
      view.legalSlots = slots;
      view.hint = `点任意格子放下「${def.name}」（点对面那一侧＝放到对面，格子里有牌就顶掉）`;
    } else {
      view.legalSlots = [];
      for (const lane of LANES) {
        for (const side of [0, 1]) {
          for (const row of ROWS) {
            const u = state.board[lane].units[side][row];
            if (u) view.legalUnitTargets.push(u.uid);
          }
        }
      }
      view.legalLanes = LANES.slice();
      view.legalKingTargets = [0, 1];
      view.hint = `点任意格子 / 单位 / 国王，把「${def.name}」打过去`;
    }
    refresh();
    return;
  }

  // 炼金原料不能直接打出（引擎会拒绝），点它就是「选中/取消选中，准备炼药」。
  if (G.isRawMaterial(def)) {
    toggleBrewPick(iid);
    return;
  }

  // 费用校验必须读**手牌实例**上的费用（「-1 花费」那种修正写在实例上），
  // 读卡面 def.cost 会出现「看着付不起、其实付得起」的误判。
  const cost = G.costOf(state, hc);
  if (cost > p.mana) {
    clearSelection();
    view.hint = `费用不足：需要 ${cost}，剩余 ${p.mana}`;
    refresh();
    return;
  }

  const places = def.type === 'unit' ? G.legalPlacements(state, me(), def) : [];
  if (!isPlayable(def, places)) {
    clearSelection();
    view.hint = def.type === 'unit' ? '没有合法位置可以放置' : '当前没有合法目标';
    refresh();
    return;
  }

  view.selectedIid = iid;
  view.legalSlots = [];
  view.legalUnitTargets = [];
  view.legalLanes = [];
  view.legalKingTargets = [];
  view.legalSummonCells = [];
  view.pickedSlot = null;

  if (def.type === 'unit') {
    view.legalSlots = places;
    view.hint = '点一下高亮格子选中，再点一次放下去（也可以长按牌拖到格子上）';
    refresh();
    return;
  }

  // 锦囊：无需点选的目标 → 直接打出
  const analysis = analyzeSpell(def);
  if (!analysis.needsChoice) {
    commitPlay(iid, {});
    return;
  }

  view.legalUnitTargets = analysis.unitTargets;
  view.legalLanes = analysis.lanes;
  view.legalKingTargets = analysis.kingTargets;

  const { unitTargets, lanes, kingTargets } = analysis;

  const tips = [];
  if (unitTargets.length) tips.push('高亮的敌方单位');
  if (kingTargets.length) tips.push(`${foeName()}的国王（血条）`);
  if (lanes.length) tips.push('一条线路');

  if (tips.length) {
    // 带上卡名，让玩家一眼看出这条提示是「为哪张牌」出现的
    view.hint = `已选「${def.name}」→ 点击 ${tips.join(' 或 ')}`;
  } else {
    view.hint = `「${def.name}」当前没有合法目标`;
  }
  refresh();
}

/**
 * 回答一次「打到一半反问玩家」的请求。
 *
 * 现在有两类请求走这里：
 *   · 「抉择」（卡牌「歼-10」）——选项自带 index
 *   · 「拟定目标攻击」（卡牌「强化士兵」）——选项是 {uid} 或 {king, side}
 *
 * 所以**不能**固定回传 `{ index }`：把 `label` 剥掉，剩下的就是引擎要的答案。
 * （选项就是答案本身，这是让两边口径永远一致的最省事做法。）
 *
 * 引擎的挂起协议：`resolveChoice` 会恢复被挂起的效果，**并且可能再次挂起**
 * （一局里可能有多只强化士兵，还要一只一只问）。所以要循环看 `state.pending`：
 * 只有整条链走完，才把 `autoResolveChoices` 恢复成 true（否则后面的
 * 自动阶段 / 对手的回合会被卡住）。
 */
function resolvePlayerChoice(idx) {
  if (!state || !state.pending) {
    if (globalThis.__dbg) console.log(`[resolvePlayerChoice] 没有挂起请求 idx=${idx}`);
    return;
  }
  const rq = state.pending.request;
  /**
   * 联机：提问归谁，只有那一侧能答。
   *   对手打出的牌在中途要选效果时，两边都会挂起，但只有对手那台设备该点。
   *   本地这里只是「等」，答案会随锁步的 { k:'c' } 操作传过来。
   */
  if (!canAnswerChoice(rq)) {
    view.hint = '等待对手选择';
    refresh();
    return;
  }
  const opt = (rq.options || [])[idx];
  if (!opt) {
    if (globalThis.__dbg) console.log(`[resolvePlayerChoice] idx=${idx} 超出选项范围 n=${(rq.options || []).length}`);
    return;
  }
  const answer = { ...opt };
  delete answer.label;
  // 弃置的飞行动画要在牌离开手牌**之前**抓源卡：答完这一问，它就没了。
  // 只有真人自己的手牌才在界面上有卡槽（对手的牌是暗的，从屏幕上方飞）。
  if (rq.type === 'chooseHandCard' && answer.iid != null && rq.side === view.humanSide) {
    const hand = ((state.players[view.humanSide] || {}).hand) || [];
    const hc = hand.find((c) => c.iid === answer.iid) || null;
    captureDiscardSource(answer.iid, hc ? hc.cardId : null);
  }
  if (globalThis.__dbg) console.log(`[resolvePlayerChoice] ${rq.type} idx=${idx} answer=${JSON.stringify(answer)}`);
  try {
    // 走统一入口：单机直接应用并记回放；联机交给会话广播给对方
    //（两端必须把**同一个选项**喂回引擎，否则状态就分叉了）
    doAction({ k: 'c', v: answer });
  } catch (err) {
    view.hint = err.message;
    if (globalThis.__dbg) console.log(`[resolvePlayerChoice] doAction 抛错: ${err.message}`);
  }
  // 只有单机才恢复「自动代答」；联机要保持挂起状态直到玩家点完
  if (!session && !state.pending) state.autoResolveChoices = true;
  refresh();
  /**
   * 回答完只在**自动阶段**才把回合循环接回去（作者 2026-10 报的 bug）。
   *
   * 开战阶段的挂起，是 `tick()` 推进自动阶段时**推到一半停下来问人**造成的；
   * 玩家点完之后如果没人再调一次 `tick()`，这一局就**停在 COMBAT 阶段不动了**
   * —— 表现就是「强化士兵选定攻击目标之后卡死」。
   *
   * ⚠️ 必须**限定自动阶段**（`G.getActor(state) === null`）：玩家自己的行动
   *   阶段本来就停在界面上等玩家操作，不该在这里替他跑一次 tick() ——
   *   tick() 在玩家阶段有一条「没有任何合法出牌 → 900ms 后自动结束阶段」的兜底，
   *   于是「致命打击」打完 3 费、再答完第二段选择（此时费用已经花光）会被这条
   *   兜底**立刻结束回合**（作者 2026-10 报的「错误自动结束这个回合」）。
   *   玩家想结束阶段时按「结束回合」，走 handleAction('end') 那条路。
   */
    // 注意这里**不能**判 state.winner === null：答完最后一道提问就打死对面国王是很
    // 常见的一条路，那也要走 tick() 里统一的终局分支去结算（否则这一局的金币/回放
    // 要靠别的定时器顺手触发，运气不好就丢了）。
    if (!session && !state.pending && G.getActor(state) === null) tick();
}

function commitPlay(iid, opts) {
  // 出牌前先抓下卡牌定义（打出后这张牌就离开手牌了），出牌成功后要用它做放大展示
  const hcBefore = state.players[me()].hand.find((c) => c.iid === iid);
  const defBefore = hcBefore ? state.cardLib[hcBefore.cardId] : null;
  if (session) {
    // 联机：交给会话（本地应用 + 广播）
    if (!session.submit({ k: 'p', s: me(), i: iid, o: opts || {} })) {
      view.hint = session.lastError || '这一步无法执行';
      refresh();
      return false;
    }
    clearSelection();
    refresh();
    return true;
  }

  try {
    // 玩家出牌时允许引擎「打到一半反问玩家」（卡牌「歼-10」的「抉择」）：
    // autoResolveChoices=false → 引擎会把 {request, gen} 挂进 state.pending，
    // 我们渲染出来让玩家点，点完由 resolvePlayerChoice 恢复。
    state.autoResolveChoices = false;
    G.playCard(state, me(), iid, opts);
    if (!state.pending) state.autoResolveChoices = true;
    if (globalThis.__dbg) console.log(`[commitPlay] iid=${iid} pend=${state.pending ? state.pending.request.type : '-'} auto=${state.autoResolveChoices} idx=${recording ? recording.actions.length : '-'} log=${recording && recording.choiceLog ? recording.choiceLog.length : '-'}`);
  } catch (err) {
    state.autoResolveChoices = true;
    view.hint = err.message;
    refresh();
    return false;
  }
  // 只有真的打出去了才记进回放（上面 catch 掉的不算）
  RP.recAction(recording, { k: 'p', s: me(), i: iid, o: opts || {} });
  pumpCombatFx();
  // 「所有锦囊被使用时放大展示给双方，持续 2 秒」（作者 2026-10）
  //  原来这句只在 applyLocalAction（AI 出的牌）里调过，玩家自己出牌这条路漏了，
  //   所以「锦囊的放大展示」看起来像没做。
  flashPlayPresentation(defBefore, { k: 'p', s: me(), i: iid });
  clearSelection();
  refresh();
  return true;
}

function handleSlotClick(slotEl) {
  if (isWatching()) return;
  if (view.busy || state.winner !== null) return;

  /**
   * 召唤落点（作者 2026-10-04：召唤时直接在场上选择一个位置放下）。
   * 挂起期间棋盘不禁点，玩家点自己那侧的格子就是选落点。
   * 选项本身就是引擎要的答案（见 resolvePlayerChoice 的注释），所以这里只找下标。
   */
  const rq = state.pending && state.pending.request;
  if (rq && rq.type === 'summonCell') {
    if (Number(slotEl.dataset.side) !== me()) return;
    if (!canAnswerChoice(rq)) { view.hint = '等待对手选择'; refresh(); return; }
    const idx = (rq.options || []).findIndex((o) => o.lane === slotEl.dataset.lane && o.row === slotEl.dataset.row);
    if (idx < 0) { view.hint = '这里不能召唤'; refresh(); return; }
    resolvePlayerChoice(idx);
    return;
  }

  if (view.selectedIid === null) return;

  /**
   * 靶场（作者 2026-10-22）：**点哪个格子就作用在哪个格子**。
   *   · 单位牌 → 放到那一格（点对面那一侧＝放到对面，placeSide 走引擎的 sandbox 分支）
   *   · 锦囊牌 → 那一格有单位就打它，没有就按线路指定
   * 不做「再点一次确认」：靶场是试卡，误放的代价只是按一下「清空场地」。
   */
  if (state.sandbox === true) {
    const lane = slotEl.dataset.lane;
    const row = slotEl.dataset.row;
    const side = Number(slotEl.dataset.side);
    const hc = state.players[me()].hand.find((c) => c.iid === view.selectedIid);
    const def = hc && state.cardLib[hc.cardId];
    if (!def) { clearSelection(); refresh(); return; }
    /**
     * 陷阱格（作者 2026-10-23 第 3 条）：中间那行格子没有 data-row / data-side
     * —— 点它就是「埋伏在**这一条线路**」。
     * 以前没有这一支：格子里的 dataset.row 是 undefined，单位牌会被塞进
     * `units[0][undefined]`，场上凭空多出一个点不到、画不出来的单位。
     */
    if (!row) {
      if (G.isTrapCard(def)) {
        commitPlay(view.selectedIid, { lane });
        return;
      }
      view.hint = '陷阱格只放陷阱牌：单位放前排 / 后排的格子';
      refresh();
      return;
    }
    if (def.type === 'unit') {
      commitPlay(view.selectedIid, { lane, row, placeSide: side });
      return;
    }
    const occupant = state.board[lane].units[side][row];
    commitPlay(view.selectedIid, occupant ? { targetUid: occupant.uid, lane } : { lane });
    return;
  }

  if (Number(slotEl.dataset.side) !== me()) return;

  const lane = slotEl.dataset.lane;
  const row = slotEl.dataset.row;
  const hc = state.players[me()].hand.find((c) => c.iid === view.selectedIid);
  if (!hc) { clearSelection(); refresh(); return; }
  const def = state.cardLib[hc.cardId];

  if (def.type === 'unit') {
    if (!view.legalSlots.some((s) => s.lane === lane && s.row === row)) {
      view.hint = '这里不能放置';
      view.pickedSlot = null;
      refresh();
      return;
    }

    /**
     * 两步放置（作者 2026-10）：第一次点格子只是「选中这个落点」，
     * 再点同一个格子才真的放下去。理由是手指点格子很容易误触，
     * 以前一步就把牌打出去了，站位错了只能认输。
     * 点另一个合法格子＝改选落点，不会放牌。
     */
    const picked = view.pickedSlot;
    if (picked && picked.lane === lane && picked.row === row) {
      view.pickedSlot = null;
      commitPlay(view.selectedIid, { lane, row });
      return;
    }
    view.pickedSlot = { lane, row };
    view.hint = `已选中 ${laneNameOf(lane)}·${row === 'front' ? '前排' : '后排'}，再点一次确认放置`;
    refresh();
    return;
  }

  if (view.legalLanes.includes(lane)) {
    commitPlay(view.selectedIid, { lane });
  }
}

/** 线路 id → 显示名（两步放置的提示行要用）。 */
function laneNameOf(lane) {
  const i = LANES.indexOf(lane);
  return i >= 0 ? LANE_NAME[LANES[i]] : lane;
}

/* ══════════════════════════════════════════════════════════════════════
   长按拖动放置（作者 2026-10）

   和上面「点两次」是同一个目的的另一种手法：手指按住手牌不放，牌跟着手
   指走；拖到某个高亮格子上松手就直接放下去；松在别处就飞回手牌。

   分工：这一层只算「拖的是哪张牌、手指现在压在哪个格子、能不能放」，
   真正画克隆卡和飞回动画的是 render.js（它才有 #fx-layer 和补间工具）。
   main.js 只负责把 pointer 事件转成这里的调用。
   ══════════════════════════════════════════════════════════════════════ */

/** 能不能把这张牌拖起来（费用、阶段、有没有合法落点都在 selectCard 里判过）。 */
function canDragCard(iid) {
  if (!state || !view) return false;
  if (view.busy || state.winner !== null) return false;
  // 靶场：和点牌一样不看阶段（自动阶段里也要能拖）
  if (state.sandbox !== true && G.getActor(state) !== me()) return false;
  const hc = state.players[me()].hand.find((c) => c.iid === iid);
  if (!hc) return false;
  const def = state.cardLib[hc.cardId];
  if (!def || def.type !== 'unit') return false;
  if (G.isRawMaterial(def)) return false;
  // 靶场不花费用（引擎里 cost 直接按 0 算，见 play.js）
  if (state.sandbox === true) return true;
  return G.costOf(state, hc) <= state.players[me()].mana;
}

/** 手指按住一张单位牌：进入拖动预览，顺手把可放区点亮。 */
function beginCardDrag(iid) {
  if (!canDragCard(iid)) return false;
  // 拖动等价于「选中这张牌」，所以直接走一遍 selectCard 拿到 legalSlots / 费用校验。
  if (view.selectedIid !== iid) selectCard(iid);
  if (view.selectedIid !== iid) return false;
  view.dragIid = iid;
  view.pickedSlot = null;
  view.hint = '拖到高亮格子上松手（松在别处会飞回手牌）';
  return true;
}

/**
 * 手指移动到 (x, y)：算出压在哪个格子上。
 * 用 document.elementFromPoint 而不是几何遍历 —— 格子数量少、层级也稳，
 * 指针坐标是视口坐标，正好是 elementFromPoint 要的那套。
 */
function updateCardDrag(x, y) {
  if (view.dragIid === null) return;
  let hit = null;
  try {
    if (typeof document.elementFromPoint === 'function') {
      const el = document.elementFromPoint(x, y);
      const slot = el && el.closest ? el.closest('.slot') : null;
      if (slot && slot.dataset && slot.dataset.lane && slot.dataset.row
          && LANES.indexOf(slot.dataset.lane) >= 0) {
        hit = { side: Number(slot.dataset.side), lane: slot.dataset.lane, row: slot.dataset.row };
      }
    }
  } catch (e) { hit = null; }
  applyDragHit(hit);
}

/**
 * 手指压在某个格子上（或者没压在格子上）：算出合法与否、记下现场、必要时重绘。
 *
 * 为什么要记「压到的那个格子」而不只记「合法的那个」：放手时的提示得说清楚
 * 到底错在哪 —— 压在敌方那侧、压在已经有单位的自己的格子、还是压根没压到格子，
 * 三种情况的提示不该是同一句（作者 2026-10 报的「拖到错误的地方提示也是错的」）。
 *
 * hit = { side, lane, row } | null
 */
function applyDragHit(hit) {
  if (view.dragIid === null) return;
  let seen = null;
  if (hit && hit.lane && LANES.indexOf(hit.lane) >= 0 && hit.row) {
    /**
     * 靶场（作者 2026-10-23 第 3 条）：拖到**对面**那一侧也算合法（点格子同理），
     * 所以这里按「点了哪一侧」判，而不是「是不是我这一侧」。
     */
    const hitSide = Number(hit.side);
    const match = view.legalSlots.some((s) => s.lane === hit.lane && s.row === hit.row
      && (state.sandbox !== true || s.side === undefined || s.side === hitSide));
    seen = {
      side: hitSide,
      lane: hit.lane,
      row: hit.row,
      legal: state.sandbox === true ? match : (hitSide === me() && match),
    };
  }
  // dragOver 带上 side：松手时靶场要靠它决定「放到哪一侧」
  const next = seen && seen.legal ? { side: seen.side, lane: seen.lane, row: seen.row } : null;
  const prev = view.dragOver;
  const changed = (!!prev !== !!next)
    || (prev && next && (prev.lane !== next.lane || prev.row !== next.row));
  view.dragSeen = seen;
  view.dragOver = next;
  if (changed) refresh();
}

/** 放手位置不对时，按「到底错在哪」说人话 */
function dragFailHint() {
  const seen = view.dragSeen;
  if (!seen) return '没拖到格子上，牌已飞回手牌';
  // 靶场两边都能放，所以失败只会是「压到了陷阱格 / 没压到前排后排」
  if (state.sandbox === true) return '这一格放不了单位：拖到前排 / 后排的格子上';
  if (seen.side !== me()) return '只能放在自己这一侧的格子';
  return '这个格子放不下（已经有单位了）';
}

/** 松手：拖在合法格子上就放下去，否则算失败（render 那边负责飞回手牌）。 */
function endCardDrag() {
  const iid = view.dragIid;
  const over = view.dragOver;
  view.dragIid = null;
  view.dragOver = null;
  if (iid === null) return { placed: false, iid: null };
  if (over && view.selectedIid === iid) {
    view.pickedSlot = null;
    view.dragSeen = null;
    const opts = { lane: over.lane, row: over.row };
    // 靶场：拖到对面那一侧＝放到对面（和点格子一条规则，见 play.js 的 placeSide）
    if (state.sandbox === true && over.side !== undefined) opts.placeSide = over.side;
    const ok = commitPlay(iid, opts);
    return { placed: !!ok, iid };
  }
  // 没落在合法格子：保留选中状态，让玩家可以直接再点格子，或者重新拖。
  // 提示要说清楚到底错在哪（敌方那侧 / 自己的格子放不下 / 根本没压到格子）。
  view.hint = dragFailHint();
  view.dragSeen = null;
  refresh();
  return { placed: false, iid };
}

/** 手指抬起但不算拖动（原地轻点）：把拖动标记清掉，交给 click 处理选中。 */
function cancelCardDrag() {
  view.dragIid = null;
  view.dragOver = null;
  view.dragSeen = null;
}

/**
 * 手势被系统抢走了（pointercancel：滚动抢手势、来电、切后台…）。
 *
 * 这**不是放手放下去了**，所以绝不能走 commitPlay —— 以前 pointercancel 和
 * pointerup 走同一条路，只要被取消那一刻手指正好压在高亮格子上，牌就被放了下去，
 * 表现是「刚开始动，牌自己就落位了」（作者 2026-10 报的）。
 * 同理也不该留下「没放到格子上」这种提示：玩家什么都没做错。
 */
function abortCardDrag() {
  const iid = view.dragIid;
  view.dragIid = null;
  view.dragOver = null;
  view.dragSeen = null;
  view.hint = '';
  return { placed: false, iid, cancelled: true };
}

function handleUnitClick(uid) {
  // 观战者可以点开单位详情看效果（那是只读的），但不能出牌
  if (view.busy || state.winner !== null) return;

  const clicked = M.findUnit(state, uid);

  /**
   * 靶场（作者 2026-10-22）：选着牌点一个单位
   *   · 锦囊 → 直接把它当目标打过去（敌我都行，试验牌就是这么用的）
   *   · 单位牌 → 这一格已经有人了，提示先清空（不静默吞掉这一下）
   */
  if (state.sandbox === true && view.selectedIid !== null && clicked) {
    const hc = state.players[me()].hand.find((c) => c.iid === view.selectedIid);
    const def = hc && state.cardLib[hc.cardId];
    if (!def) { clearSelection(); refresh(); return; }
    if (def.type === 'unit') {
      /**
       * 靶场里点一个有人的格子＝把旧的顶掉（作者 2026-10-23 第 3 条「任意格子都能放」）。
       * 以前这里只提示「先清空场地」，试卡时换个坑位要清掉整块棋盘。
       */
      const old = clicked.name || (state.cardLib[clicked.cardId] || {}).name || '这张牌';
      commitPlay(view.selectedIid, { lane: clicked.lane, row: clicked.row, placeSide: clicked.side });
      view.hint = `「${old}」被顶下来了（靶场里任意格子都能放）`;
      refresh();
      return;
    }
    commitPlay(view.selectedIid, { targetUid: clicked.uid, lane: clicked.lane });
    return;
  }

  /** 献祭模式（恶魔阵营）：点谁谁被献祭  只认自己的单位 */
  if (view.sacMode) {
    if (!clicked || clicked.side !== me()) {
      view.hint = '只能献祭自己的单位';
      refresh();
      return;
    }
    view.sacMode = false;
    doAction({ k: 'x', s: me(), u: uid });
    tick();
    return;
  }

  // 「融合进化」：这类牌是打在**队友现在的位置**上的（队友消失、新牌顶替）。
  // 所以点了场上的队友时，必须先判断这是不是一个合法的融合落点 ——
  // 否则那一下会被当成「查看卡牌详情」，玩家永远也融合不出去。
  // （点击分发里 `.unit` 比 `.slot` 先匹配，所以永远不会走到 handleSlotClick。）
  if (view.selectedIid !== null && clicked && clicked.side === me()
      && view.legalSlots.some((s) => s.lane === clicked.lane && s.row === clicked.row)) {
    commitPlay(view.selectedIid, { lane: clicked.lane, row: clicked.row });
    return;
  }

  // 手上没选牌 → 点场上单位就是「查看这张在场卡牌」：
  // 攻击力（含光环）、生命、词条全文、卡面效果文字、这一击打向谁。
  // 以前这里直接 return，点了没反应，场上卡牌的效果等于看不见。
  if (view.selectedIid === null) {
    view.infoUid = view.infoUid === uid ? null : uid;
    refresh();
    return;
  }

  if (!view.legalUnitTargets.includes(uid)) {
    view.hint = '这个单位不能作为目标';
    refresh();
    return;
  }
  commitPlay(view.selectedIid, { targetUid: uid });
}

/** 点击顶部/底部血条上的国王，把国王作为目标打出（「造成X点伤害」类卡片） */
function handleKingClick(side) {
  if (isWatching()) return;
  if (view.busy || state.winner !== null) return;
  if (view.selectedIid === null) return;
  // 靶场：两边的国王都能被指定（比如「对一个敌方目标造成伤害」想打谁的国王都行）
  if (state.sandbox === true) {
    commitPlay(view.selectedIid, { targetKing: true, targetKingSide: side });
    return;
  }
  if (!view.legalKingTargets.includes(side)) {
    view.hint = '这张牌不能指定国王';
    refresh();
    return;
  }
  commitPlay(view.selectedIid, { targetKing: true });
}

// ══════════════════════════════════════════════════════════
// 强化工坊：强化 / 精通 / 洗掉 / 星尘合成
// ══════════════════════════════════════════════════════════

/**
 * 把一份新档案写回存档并重绘。
 * 工坊里每个动作都会产出**新的** profile 对象（enhance.js 不改入参），
 * 所以这里统一做「替换 + 存档 + 刷屏」，避免各分支各写一遍忘了存。
 */
function commitForge(nextProfile, hint) {
  profile = nextProfile;
  view.forgeHint = hint || '';
  Store.saveProfile(profile);
  refresh();
}

function forgeAction(act, cardId) {
  const def = cardId ? TEST_CARD_LIB[cardId] : null;
  if (!def) return;

  if (act === 'forge-enhance') {
    const r = Enh.applyEnhance(profile, def, cardId);
    if (!r.ok) { view.forgeHint = r.reason; refresh(); return; }
    const last = r.lvl >= Enh.ENHANCE_MAX;
    commitForge(r.profile, `${def.name} 强化第 ${r.lvl} 次（−${r.cost} 金币）${last ? ' · 已练满，可以精通了' : ''}`);
    return;
  }

  if (act === 'forge-master') {
    const gate = Enh.canMaster(profile, def, cardId);
    if (!gate.ok) { view.forgeHint = gate.reason; refresh(); return; }
    // 锦囊没有三选一：直接减费
    if (def.type === 'spell') {
      const r = Enh.applyMastery(profile, def, cardId, null);
      if (!r.ok) { view.forgeHint = r.reason; refresh(); return; }
      commitForge(r.profile, `${def.name} 精通：费用降低（−${r.cost} 星尘）`);
      return;
    }
    // 单位：抽三个技能给他选，选完才真正扣星尘
    view.forgePick = { cardId, name: def.name, options: Enh.drawSkills() };
    view.forgeHint = '';
    refresh();
    return;
  }

  if (act === 'forge-wash') {
    const r = Enh.applyWash(profile, def, cardId);
    if (!r.ok) { view.forgeHint = r.reason; refresh(); return; }
    commitForge(r.profile, `${def.name} 洗掉了一次精通（星尘不退），要重新强化 ${Enh.ENHANCE_MAX} 次才能再精通`);
  }
}

/** 三选一里点了某个技能 */
function forgePickSkill(skillId) {
  const pick = view.forgePick;
  if (!pick) return;
  const def = TEST_CARD_LIB[pick.cardId];
  const r = Enh.applyMastery(profile, def, pick.cardId, skillId);
  if (!r.ok) { view.forgeHint = r.reason; view.forgePick = null; refresh(); return; }
  const skill = Enh.SKILL_BY_ID[skillId];
  view.forgePick = null;
  commitForge(r.profile, `${pick.name} 精通：获得「${skill ? skill.name : skillId}」（−${r.cost} 星尘）`);
}

/**
 * 靶场：轮到下一个阵营并立刻补发它的全部超能力（作者 2026-10-22「可以切换阵营」）。
 * 换过去的旧牌**留在手里** —— 试卡时经常要「拿两家的牌对撞」，收走反而碍事。
 */
function sandboxCycleFaction(side) {
  const keys = Object.keys(G.FACTIONS);
  const p = state.players[side];
  const at = keys.indexOf(p.faction);
  const next = keys[(at + 1) % keys.length];
  const r = G.sandboxSetFaction(state, side, next);
  G.sandboxRefillMana(state, side);
  const name = (G.FACTIONS[next] || {}).name || next;
  const removed = (r && r.removed ? r.removed.length : 0);
  const added = (r && r.added ? r.added.length : 0);
  view.hint = `${side === me() ? '我方' : '对方'}阵营换成「${name}」`
    + `：发 ${added} 张` + (removed ? `，收走上一个阵营的 ${removed} 张` : '');
  refresh();
}

function handleAction(act, el) {
  const id = el && el.dataset ? el.dataset.id : undefined;

  // 「抉择」面板上的一选一（卡牌「歼-10」）。要在最前面 —— 它不属于任何一屏。
  if (act === 'choose-option') { resolvePlayerChoice(Number(el.dataset.idx)); return; }

  // ── 屏幕导航
  // 选难度**留在难度页**（只改选中项），真正开局由「开始对战」按钮负责。
  // 以前这里写的是 `screen = 'play'`，于是「开始游戏 → AI 对决 → 选难度」
  // 又绕回二级菜单，而且全流程根本没有任何一个按钮会调 startNewGame() ——
  // AI 对决因此永远进不去。
  // 普通模式与强化模式是**两套独立入口**（作者 2026-10-17：分开）：
  // 从哪个菜单进来就定下 playMode，整局（含「再来一局」）都跟着它走。
  if (act === 'start-game') { playMode = 'normal'; screen = 'play'; refresh(); return; }
  if (act === 'start-forge') { playMode = 'forge'; screen = 'forgeMenu'; refresh(); return; }
  if (act === 'choose-ai') { screen = 'difficulty'; refresh(); return; }
  if (act === 'set-difficulty') { setDifficulty(el.dataset.key); return; }
  if (act === 'set-faction') {
    setFaction(el.dataset.key);
    // 点阵营这一下同时把它的介绍摊开（作者 2026-10-22 第 4 条）
    showFactionInfo(el.dataset.key);
    // 联机大厅里换阵营要告诉对手：主机开局按两边各自的阵营建局（作者 2026-10-05）
    if (session) {
      try { session.transport.send({ t: 'faction', key: myFaction }); } catch { /* 断线时忽略，重连后 hello 会再报一次 */ }
    }
    return;
  }
  if (act === 'start-ai') { startNewGame(); return; }
  // ── 靶场（作者 2026-10-22）：试卡的沙盒，进来就是一局随便摆的对局
  /**
   * 靶场入口有两个：普通模式菜单和**强化模式菜单**（作者 2026-10-23 第 1 条）。
   * 从哪个菜单进来就决定这一局读不读强化 / 精通 —— 和「强化 AI 对决」同一个口径。
   */
  if (act === 'start-sandbox') {
    playMode = screen === 'forgeMenu' ? 'forge' : 'normal';
    startSandboxGame();
    return;
  }
  // 阵营行右边的「介绍」：展开这一段说明（再点一次收起）
  if (act === 'faction-info') { toggleFactionInfo(el.dataset.key); return; }
  if (act === 'sb-side') {
    // 切换控制方：只换视角与输入归属，两边仍是同一局
    setSandboxSide(1 - me());
    if (view) view.humanSide = me();
    if (state) state.humanSide = me();
    clearSelection();
    view.hint = `现在是${me() === 0 ? '玩家1' : '玩家2'}在打：点手牌，再点场上任意格子`;
    refresh();
    return;
  }
  if (act === 'sb-faction-mine') { sandboxCycleFaction(me()); return; }
  if (act === 'sb-faction-foe') { sandboxCycleFaction(foe()); return; }
  if (act === 'sb-difficulty') {
    // 难度只影响「AI 行动」打开时对面那一侧的水平
    const keys = DIFFICULTIES.map((d) => d.key);
    const at = keys.indexOf(difficulty);
    setDifficulty(keys[(at + 1) % keys.length]);
    view.hint = '人机难度：' + difficultyByKey(difficulty).name + '（打开「AI 行动」后才生效）';
    refresh();
    return;
  }
  if (act === 'sb-ai') {
    view.sandboxAI = !view.sandboxAI;
    view.hint = view.sandboxAI ? 'AI 行动：轮到对面时它会自己出牌' : 'AI 待机：对面上什么都不做';
    refresh();
    if (view.sandboxAI) tick();
    return;
  }
  if (act === 'sb-add') {
    view.pickOpen = !view.pickOpen;
    clearSelection();
    refresh();
    return;
  }
  if (act === 'sb-pick-close') { view.pickOpen = false; refresh(); return; }
  if (act === 'sb-give') {
    G.sandboxAddCard(state, me(), el.dataset.id);
    refresh();
    return;
  }
  if (act === 'sb-refill') {
    const got = G.sandboxGrantFaction(state, me());
    G.sandboxRefillMana(state, me());
    G.sandboxRefillMana(state, foe());
    view.hint = got.length ? `补发了 ${got.length} 张本阵营超能力` : '本阵营的超能力已经全在手里了';
    refresh();
    return;
  }
  if (act === 'sb-clear') {
    G.sandboxClearBoard(state);
    resetCombatFx();
    clearSelection();
    view.deadUnits = [];
    view.hint = '场地已清空';
    refresh();
    return;
  }
  if (act === 'sb-reset') { newSandboxGame(); refresh(); return; }
  if (act === 'open-replays') { goReplays(); return; }
  if (act === 'open-settings') { goSettings(); return; }

  // ── 云存档 / 账号
  if (act === 'open-account') { screen = 'account'; refresh(); return; }
  if (act === 'cloud-login') { Cloud.login(inputValue('cloud-user'), inputValue('cloud-pass')); return; }
  if (act === 'cloud-register') { Cloud.register(inputValue('cloud-user'), inputValue('cloud-pass')); return; }
  if (act === 'cloud-logout') { Cloud.logout(); return; }
  if (act === 'cloud-push') { Cloud.pushLocal(); return; }
  if (act === 'cloud-pull') { Cloud.pullRemote(); return; }
  if (act === 'cloud-use-local') { Cloud.useLocal(); return; }
  if (act === 'cloud-use-cloud') { Cloud.useCloud(); return; }
  if (act === 'cloud-change-password') {
    Cloud.changePassword(inputValue('cloud-oldpass'), inputValue('cloud-newpass'));
    return;
  }
  if (act === 'cloud-admin-open') {
    screen = 'admin';
    Cloud.loadAdminUsers();
    refresh();
    return;
  }
  if (act === 'cloud-admin-refresh') { Cloud.loadAdminUsers(); return; }
  if (act === 'cloud-admin-back') { screen = 'account'; refresh(); return; }
  if (act === 'cloud-admin-delete') { Cloud.setConfirmDelete(el.dataset.user || ''); return; }
  if (act === 'cloud-admin-delete-cancel') { Cloud.setConfirmDelete(''); return; }
  if (act === 'cloud-admin-delete-confirm') { Cloud.deleteUser(el.dataset.user || ''); return; }
  if (act === 'cloud-admin-reset') {
    Cloud.resetPassword(el.dataset.user || '', inputValue('cloud-admin-pass'));
    return;
  }
  if (act === 'back-home') {
    // 强化模式是独立的二级树：从难度页 / 联机页返回时回「强化模式」菜单，
    // 而不是一路跳回首页（否则每次都要重新点一遍强化模式）。
    if (playMode === 'forge' && (screen === 'difficulty' || screen === 'lan' || screen === 'lanScan')) {
      screen = 'forgeMenu';
      refresh();
      return;
    }
    goHome();
    return;
  }
  if (act === 'set-theme') { setTheme(el.dataset.theme); return; }

  // ── 局域网
  if (act === 'lan-menu') { screen = 'lan'; refresh(); return; }
  // ── 观战（作者 2026-10-23）
  if (act === 'watch-join') { lanManualError = ''; screen = 'watchJoin'; refresh(); return; }
  if (act === 'watch-enter') { watchByInput(); return; }
  if (act === 'watch-exit') { quitRoom(); return; }
  /**
   * 观战切换视角（作者 2026-10-23 第 5 条）。
   *
   * 只翻界面：把哪一方摆到下面。观战者没有座位，切视角不动引擎状态、
   * 不动回合推进 —— 它仍然只是照抄收到的操作。
   */
  if (act === 'watch-side') {
    if (!view) return;
    setWatchSide(1 - watchSideOf());
    // 直接读 watchSide，不走 me()：me() 只在 session 是观战时才看 watchSide，
    // 而自检里（__watchView）根本没有 session —— 那会让视角切不动。
    view.humanSide = watchSideOf();
    view.hint = `现在按「${(view.playerNames || [])[view.humanSide] || '玩家'}」的视角看`;
    clearSelection();
    refresh();
    return;
  }
  if (act === 'lan-host') { createRoom(); return; }
  if (act === 'lan-scan') { scanLanRooms(); return; }
  if (act === 'lan-join') { Net.navigateTo(el.dataset.url); return; }
  if (act === 'lan-join-manual') { joinByManualAddress(); return; }
  if (act === 'lan-start') { hostStartMatch(); return; }
  if (act === 'lan-quit') { quitRoom(); return; }

  // ── 强化工坊（开始游戏 → 强化工坊）
  if (act === 'open-forge') {
    screen = 'forge';
    view.forgeGroup = view.forgeGroup === 'type' ? 'type' : 'initial';
    view.forgePick = null;
    view.forgeHint = '';
    refresh();
    return;
  }
  if (act === 'back-play') {
    // 工坊是从强化模式进来的，返回就回强化模式菜单（不是普通模式的开始游戏）
    screen = playMode === 'forge' ? 'forgeMenu' : 'play';
    view.forgePick = null;
    refresh();
    return;
  }
  if (act === 'forge-group') {
    view.forgeGroup = el.dataset.key === 'type' ? 'type' : 'initial';
    refresh();
    return;
  }
  if (act === 'forge-enhance' || act === 'forge-master' || act === 'forge-wash') {
    forgeAction(act, id);
    return;
  }
  if (act === 'forge-pick') { forgePickSkill(el.dataset.skill); return; }
  if (act === 'forge-pick-cancel') { view.forgePick = null; refresh(); return; }
  if (act === 'forge-buy-dust') {
    const r = Eco.buyDust(profile, 1);
    if (!r.ok) { view.forgeHint = r.reason; refresh(); return; }
    commitForge(r.profile, `用 ${Eco.DUST_PER_GOLD} 金币合成了 ${r.gained} 星尘`);
    return;
  }

  // ── 回放列表
  if (act === 'replay-open') { openReplay(id); return; }
  if (act === 'replay-note') { rpUI.editingNoteId = id; rpUI.confirmDelId = null; refresh(); return; }
  if (act === 'replay-note-cancel') { rpUI.editingNoteId = null; refresh(); return; }
  if (act === 'replay-note-save') {
    const input = document.getElementById('note-input');
    const value = input && input.value ? String(input.value).slice(0, 40).trim() : '';
    updateReplay(id, { note: value });
    rpUI.editingNoteId = null;
    refresh();
    return;
  }
  if (act === 'replay-del') { rpUI.confirmDelId = id; rpUI.editingNoteId = null; refresh(); return; }
  if (act === 'replay-del-cancel') { rpUI.confirmDelId = null; refresh(); return; }
  if (act === 'replay-del-confirm') { deleteReplay(id); rpUI.confirmDelId = null; refresh(); return; }

  // ── 回放播放器
  if (act === 'replay-exit') { goHome(); return; }
  if (act === 'replay-toggle') { toggleReplayPlay(); return; }
  if (act === 'replay-next') { stepReplay(1); return; }
  if (act === 'replay-prev') { stepReplay(-1); return; }
  if (act === 'replay-speed') { cycleReplaySpeed(); return; }

  // ── 对局内
  // 联机时不能再「重开一局」—— 那会让两端跑不同的对局，直接退出房间更安全
  // 回放是只读的：重开会把 screen 拉回对局、把正在看的这条回放踢掉（作者 2026-10-05）
  if (act === 'restart') {
    if (screen === 'replay') return;
    // 靶场：重置靶场（不回首页、不结算）
    if (state && state.sandbox === true) { newSandboxGame(); refresh(); return; }
    /**
     * 联机（作者 2026-10-22 第 2 条）：以前这里直接退房间，因为「两端各开各的」会跑飞。
     * 现在重开也走开局那条路：房主重新算一份开局参数广播出去，两边一起重建对局，
     * 所以重开是安全的，而且对手那侧也会一起重开。客人只能「请求重开」，由房主执行。
     */
    if (session) { requestLanRestart(); return; }
    startNewGame();
    return;
  }
  if (act === 'menu') { toggleMenu(); return; }
  if (act === 'close-menu') { toggleMenu(false); return; }
  if (act === 'close-info') { view.infoUid = null; refresh(); return; }

  /**
   * 恶魔阵营的「献祭」（作者 2026-10-03）：先进入献祭模式，再点一名自己的单位。
   * 献祭**算作被消灭**、会触发被消灭效果，所以必须走引擎的 sacrificeUnit，
   * 不能在界面上把单位抹掉。
   */
  if (act === 'sac') {
    if (view.busy || state.winner !== null) return;
    if (G.getActor(state) !== me()) return;
    clearTimeout(autoAdvanceTimer);
    clearSelection();
    view.sacMode = true;
    view.hint = '点一名自己的单位献祭（算作被消灭）';
    refresh();
    return;
  }

  if (act === 'brew') {
    if (view.busy || state.winner !== null) return;
    if (G.getActor(state) !== me()) return;
    const p = state.players[me()];
    const iids = Array.isArray(view.brewIids) ? view.brewIids.slice() : [];
    if (iids.length < 2) {
      view.hint = '炼药至少要选两张原料';
      refresh();
      return;
    }
    let cost = 0;
    for (const each of iids) {
      const hc = p.hand.find((c) => c.iid === each);
      if (hc) cost += G.costOf(state, hc);
    }
    if (cost > p.mana) {
      view.hint = `费用不足：需要 ${cost}，剩余 ${p.mana}`;
      refresh();
      return;
    }
    clearTimeout(autoAdvanceTimer);
    doAction({ k: 'b', s: me(), i: iids });
    clearSelection();
    refresh();
    tick();
    return;
  }

  if (act === 'end') {
    if (view.busy || state.winner !== null) return;
    if (G.getActor(state) !== me()) return;
    clearTimeout(autoAdvanceTimer);
    clearSelection();
    advanceGame();
    tick();
    return;
  }

  if (act === 'surrender') {
    if (screen === 'replay') return;
    if (!state || state.winner !== null) return;
    /**
     * 认输也是一条**操作**（作者 2026-10-05：联机时一方认输，另一方看不到终局）。
     *
     * 以前这里直接改 state.winner  单机没问题，联机下那只是本地改本地：
     * 两端只同步操作，对手那一侧永远收不到，于是它既不结束也不判胜。
     * 走 doAction 才会广播给对手、并记进回放。
     */
    toggleMenu(false);
    doAction({ k: 's', s: me() });
    tick(); // 走统一路径：结算金币 + 存档回放
  }
}

export {
  NO_CHOICE_TARGET_KINDS, analyzeSpell, isPlayable, computePlayable, clearSelection,
  selectCard, resolvePlayerChoice, commitPlay,
  handleSlotClick, handleUnitClick, handleKingClick, handleAction, toggleBrewPick,
  canDragCard, beginCardDrag, updateCardDrag, endCardDrag, cancelCardDrag, abortCardDrag, applyDragHit,
};
