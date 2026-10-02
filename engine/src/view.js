/**
 * 视图与调试：某一方视角的状态摘要、单位行、可读战场图。
 *
 * 从 engine.js 拆出（纯搬移，行为不变）：viewFor / describeUnit / renderBoard
 *
 * 依赖方向：mechanics/auras ← setup/turns ← view
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
import { getActor } from './turns.js';

// ══════════════════════════════════════════════════════════
// 视图与调试
// ══════════════════════════════════════════════════════════

/** 生成某一方视角的状态摘要（隐藏对手手牌） */
export function viewFor(state, side) {
  const me = state.players[side];
  const foe = state.players[1 - side];
  return {
    turn: state.turn,
    phase: state.phase,
    actor: getActor(state),
    deckLeft: state.deck.length,
    me: { kingHp: me.kingHp, mana: me.mana, manaCap: me.manaCap, hand: me.hand.map((c) => c.cardId) },
    foe: { kingHp: foe.kingHp, mana: foe.mana, manaCap: foe.manaCap, handCount: foe.hand.length },
    board: Object.fromEntries(LANES.map((lane) => [
      lane,
      {
        mine: ROWS.map((row) => describeUnit(state, state.board[lane].units[side][row])),
        foe: ROWS.map((row) => describeUnit(state, state.board[lane].units[1 - side][row])),
      },
    ])),
    pending: state.pending ? { type: state.pending.request.type, prompt: state.pending.request.prompt } : null,
    winner: state.winner,
  };
}

export function describeUnit(state, u) {
  if (!u) return null;
  const kws = u.keywords.map((k) => (k.x ? `${k.id}:${k.x}` : k.id));
  // 光环授予的「扎根」（拷问官）不在 keywords 里，要单独标出来给界面用
  if (hasRooted(state, u) && !kws.includes('rooted')) kws.push('rooted:aura');
  return {
    uid: u.uid, name: u.name,
    // 界面显示的是**有效**攻击力（含光环），否则玩家看到的和实际打出的伤害对不上
    atk: effectiveAtk(state, u), baseAtk: u.atk,
    hp: u.hp, maxHp: u.maxHp,
    keywords: kws,
    marks: u.marks.map((m) => m.type),
  };
}

/** 打印一张可读的战场图（调试用） */
export function renderBoard(state) {
  const cell = (u, w = 14) => {
    if (!u) return '·'.padEnd(w, ' ');
    const kws = u.keywords.map((k) => (k.x ? `${k.id}${k.x}` : k.id)).slice(0, 2).join(',');
    const s = `${effectiveAtk(state, u)}/${u.hp} ${kws}`;
    return s.length > w ? s.slice(0, w) : s.padEnd(w, ' ');
  };
  const lines = [];
  lines.push(`回合 ${state.turn} · 阶段 ${state.phase} · 牌库 ${state.deck.length} · 先手=${SIDE_NAME[state.firstPlayer]}`);
  lines.push(`先手国王 ${state.players[0].kingHp}  费用 ${state.players[0].mana}/${state.players[0].manaCap}   手牌 ${state.players[0].hand.length}`);
  lines.push(`后手国王 ${state.players[1].kingHp}  费用 ${state.players[1].mana}/${state.players[1].manaCap}   手牌 ${state.players[1].hand.length}`);
  lines.push('');
  lines.push('          ' + LANES.map((l) => LANE_NAME[l].padEnd(15, ' ')).join(''));
  const rowLabel = { front: '前排', back: '后排' };
  for (const row of ['back', 'front']) {
    lines.push(`敌${rowLabel[row]}  ` + LANES.map((l) => cell(state.board[l].units[1][row]) + ' ').join(''));
  }
  lines.push('陷阱格    ' + LANES.map(() => '·'.padEnd(14, ' ') + ' ').join(''));
  for (const row of ['front', 'back']) {
    lines.push(`我${rowLabel[row]}  ` + LANES.map((l) => cell(state.board[l].units[0][row]) + ' ').join(''));
  }
  return lines.join('\n');
}
