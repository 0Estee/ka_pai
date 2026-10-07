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
import { LANES, ROWS, LANE_NAME } from '../../engine/src/constants.js';
import { matchesTargetFilter } from '../../engine/src/keywords.js';
import { filterCtx } from '../../engine/src/auras.js';
import * as RP from './replay.js';
import * as Net from './multiplayer.js';

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

function selectCard(iid) {
  if (view.busy || state.winner !== null) return;
  if (G.getActor(state) !== me()) return;
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

  if (def.type === 'unit') {
    view.legalSlots = places;
    view.hint = '点击高亮格子放置';
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
  if (Number(slotEl.dataset.side) !== me()) return;

  const lane = slotEl.dataset.lane;
  const row = slotEl.dataset.row;
  const hc = state.players[me()].hand.find((c) => c.iid === view.selectedIid);
  if (!hc) { clearSelection(); refresh(); return; }
  const def = state.cardLib[hc.cardId];

  if (def.type === 'unit') {
    if (!view.legalSlots.some((s) => s.lane === lane && s.row === row)) {
      view.hint = '这里不能放置';
      refresh();
      return;
    }
    commitPlay(view.selectedIid, { lane, row });
    return;
  }

  if (view.legalLanes.includes(lane)) {
    commitPlay(view.selectedIid, { lane });
  }
}

function handleUnitClick(uid) {
  if (view.busy || state.winner !== null) return;

  const clicked = M.findUnit(state, uid);

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
  if (view.busy || state.winner !== null) return;
  if (view.selectedIid === null) return;
  if (!view.legalKingTargets.includes(side)) {
    view.hint = '这张牌不能指定国王';
    refresh();
    return;
  }
  commitPlay(view.selectedIid, { targetKing: true });
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
  if (act === 'start-game') { screen = 'play'; refresh(); return; }
  if (act === 'choose-ai') { screen = 'difficulty'; refresh(); return; }
  if (act === 'set-difficulty') { setDifficulty(el.dataset.key); return; }
  if (act === 'set-faction') {
    setFaction(el.dataset.key);
    // 联机大厅里换阵营要告诉对手：主机开局按两边各自的阵营建局（作者 2026-10-05）
    if (session) {
      try { session.transport.send({ t: 'faction', key: myFaction }); } catch { /* 断线时忽略，重连后 hello 会再报一次 */ }
    }
    return;
  }
  if (act === 'start-ai') { startNewGame(); return; }
  if (act === 'open-replays') { goReplays(); return; }
  if (act === 'open-settings') { goSettings(); return; }
  if (act === 'back-home') { goHome(); return; }
  if (act === 'set-theme') { setTheme(el.dataset.theme); return; }

  // ── 局域网
  if (act === 'lan-menu') { screen = 'lan'; refresh(); return; }
  if (act === 'lan-host') { createRoom(); return; }
  if (act === 'lan-scan') { scanLanRooms(); return; }
  if (act === 'lan-join') { Net.navigateTo(el.dataset.url); return; }
  if (act === 'lan-join-manual') { joinByManualAddress(); return; }
  if (act === 'lan-start') { hostStartMatch(); return; }
  if (act === 'lan-quit') { quitRoom(); return; }

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
  if (act === 'restart') { if (screen === 'replay') return; if (session) { quitRoom(); return; } startNewGame(); return; }
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
};
