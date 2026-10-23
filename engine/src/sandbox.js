/**
 * 靶场（作者 2026-10-22）：给「开始游戏 → 靶场」用的沙盒操作。
 *
 * 靶场存在的理由是**试卡**：作者改一张牌之后要马上看到它在场上的样子，
 * 而不是先凑费用、先等抽牌、先攒到国王掉血触发超能力。
 * 所以这里的东西全部**不守规矩**：
 *   · 卡牌不花费用、不看阶段、不看归属（出牌那一步的放行在 play.js 的 playCard 里）
 *   · 双方阵营可以随时换，换了立刻把手牌补齐（本阵营全部超能力各一张）
 *   · 场地可以一键清空，方便重摆一个「两牌对撞」的局面
 *
 * ⚠ 这个模块只做「改数据」，不跑出牌流程 —— 出牌仍然走 playCard，
 *   这样靶场里看到的效果和真对局是同一套代码，不会出现「靶场能过、实战不行」。
 * ⚠ 靶场对局一律不结算金币、不入回放（见 app/js/game-flow.js 的 settleIfNeeded）。
 */

import { LANES, ROWS } from './constants.js';
import { log } from './board.js';

/** 这张卡能不能进靶场的加牌面板（白板测试卡不进，作者 2026-10-18 清过场） */
function pickable(def) {
  return !!def && !def.legacy;
}

/** 开启靶场模式（建局之后立刻调一次） */
export function sandboxEnable(state) {
  state.sandbox = true;
  return state;
}

/** 本阵营**全部**超能力（非令牌，且不是白板卡），按 id 排序保证确定 */
export function sandboxFactionCards(state, faction) {
  return Object.keys(state.cardLib || {})
    .filter((id) => {
      const c = state.cardLib[id];
      return pickable(c) && c.faction === faction && !c.token;
    })
    .sort();
}

/**
 * 把本阵营的全部超能力塞进这一方手牌（作者：「开局讲阵营超能力所有技能全发」）。
 *
 * 已经发过的牌不重复发（按 cardId 判），所以换阵营回来不会把手牌刷成两倍。
 */
export function sandboxGrantFaction(state, side) {
  const p = state.players[side];
  if (!p || !p.faction) return [];
  const ids = sandboxFactionCards(state, p.faction);
  const added = [];
  for (const id of ids) {
    if ((p.superpowers || []).includes(id)) continue;
    p.superpowers.push(id);
    p.hand.push({ iid: state.nextIid++, cardId: id });
    added.push(id);
  }
  if (added.length) {
    log(state, { type: 'sandbox-grant', side, count: added.length, faction: p.faction });
  }
  return added;
}

/**
 * 换阵营：记下来 + 立刻补发该阵营的全部超能力。
 *
 * 作者 2026-10-23 第 2 条：换阵营时要把**上一个阵营的牌**从手里收走。
 * 靶场的手牌本来就是「本阵营全发」，旧的那一手留着只会和新阵营混在一起
 * （换个阵营还得自己一张张丢）。收走以后，手里永远是当前阵营的一整套。
 * 场上已经摆出去的牌不动 —— 那是摆好的局面，不是手牌。
 *
 * 返回 { added, removed }：界面要拿它说「发了 N 张、收走 M 张」。
 */
export function sandboxSetFaction(state, side, key) {
  const p = state.players[side];
  if (!p) return { added: [], removed: [] };
  const old = p.faction;
  p.faction = key || null;
  p.superpowers = [];
  p.spThresholds = {};
  const removed = (old && old !== p.faction) ? dropFactionHand(state, side, old) : [];
  const added = sandboxGrantFaction(state, side);
  return { added, removed };
}

/** 把某一阵营的牌从手牌里抽走（换阵营时用） */
function dropFactionHand(state, side, faction) {
  const p = state.players[side];
  const removed = [];
  for (let i = p.hand.length - 1; i >= 0; i--) {
    const def = state.cardLib[p.hand[i].cardId];
    if (def && def.faction === faction) {
      removed.unshift(p.hand[i].cardId);
      p.hand.splice(i, 1);
    }
  }
  if (removed.length) log(state, { type: 'sandbox-drop', side, faction, count: removed.length });
  return removed;
}

/** 加一张牌进手牌（靶场的「加牌」面板用） */
export function sandboxAddCard(state, side, cardId) {
  const p = state.players[side];
  const def = state.cardLib[cardId];
  if (!p || !pickable(def)) return null;
  const hc = { iid: state.nextIid++, cardId };
  p.hand.push(hc);
  log(state, { type: 'sandbox-add', side, cardId });
  return hc;
}

/**
 * 靶场里手牌不设上限、也不花费用，所以费用条只是装饰。
 * 这里给一个足够大的值，界面上靶场会把它画成「∞」。
 */
export function sandboxRefillMana(state, side) {
  const p = state.players[side];
  if (!p) return;
  p.mana = 99;
  p.manaCap = 99;
  p.manaPenalty = 0;
}

/**
 * 把一张陷阱牌埋伏到**指定的线路**陷阱格里（靶场专用，作者 2026-10-23 第 3 条）。
 *
 * 真对局的 placeTrap 是「自己找第一条空线路」—— 靶场里点了哪一格就该落在哪一格，
 * 所以这里直接写那一格；那一格已经有陷阱就顶掉（顶错了按「清空场地」重来）。
 * 返回落地的线路，写不进去返回 null。
 */
export function sandboxPlantTrap(state, side, lane, cardId) {
  const p = state.players[side];
  const def = state.cardLib[cardId];
  const traps = state.board[lane] && state.board[lane].traps;
  if (!p || !def || !traps) return null;
  traps[side] = {
    cardId,
    owner: side,
    paid: 0,
    placedTurn: state.turn,
    // 打出时是单位回合还是锦囊回合  回手要按「同类型阶段」算
    phaseKind: state.phase && state.phase.startsWith('DEPLOY') ? 'deploy' : 'spell',
    revealed: false,
    expiresTurn: null,
  };
  log(state, { type: 'trap-placed', side, lane, cardId, sandbox: true });
  return lane;
}

/** 清空场地（双方所有格子 + 陷阱格），手牌和国王血量不动 */
export function sandboxClearBoard(state) {
  for (const lane of LANES) {
    for (const side of [0, 1]) {
      for (const row of ROWS) state.board[lane].units[side][row] = null;
      if (Array.isArray(state.board[lane].traps)) state.board[lane].traps[side] = null;
    }
  }
  log(state, { type: 'sandbox-clear' });
}
