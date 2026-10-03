/**
 * 阵营与「超能力」（作者 2026-10-03 规则补充）。
 *
 * 规则（原文见 data/_transcribe/超能力-规则与待确认.md）：
 *   对局开始前选一个阵营，本局只能获得该阵营的超能力。
 *   对局开始时抽 1 张；自己的国王血量 < 15 / < 9 / < 3 时各再抽 1 张；
 *   同一个阈值只生效一次，抽过的卡不会重复抽到。
 *   带「令」字的令牌不进抽取池；普通牌永远是中立的（没有 faction 字段）。
 *
 * 依赖方向：只用到 board.js 的 log 与 rng.js 的 nextInt（都是函数声明，环安全）。
 * 抽牌走 state.rng，所以同种子同阵营的抽取顺序是确定的（回放/联机可用）。
 */

import { log } from './board.js';
import { nextInt } from './rng.js';

/** 已知阵营：key 存在卡牌定义的 faction 字段里，name 是界面上显示的名字 */
export const FACTIONS = {
  demon: { key: 'demon', name: '恶魔' },
};

/** 抽超能力的国王血量阈值（从高到低，顺序固定 = 抽取顺序确定） */
export const SUPERPOWER_THRESHOLDS = [15, 9, 3];

/**
 * 某方还没抽到的超能力（同阵营、非令牌、没抽过）。
 * 排序保证顺序确定：池子一样大、种子一样，抽到的牌就一样。
 */
export function superpowerPool(state, side) {
  const p = state.players[side];
  if (!p || !p.faction) return [];
  const drawn = p.superpowers || [];
  return Object.keys(state.cardLib || {})
    .filter((id) => {
      const c = state.cardLib[id];
      return c && c.faction === p.faction && !c.token && drawn.indexOf(id) < 0;
    })
    .sort();
}

/**
 * 抽一张超能力进手牌；池子空了返回 null（不会重复抽）。
 * 与 stats.js 的 drawCards 走同一条「进手牌」写法（iid + nextIid）。
 */
export function drawSuperpower(state, side, opts) {
  const p = state.players[side];
  if (!p || !p.faction) return null;
  const pool = superpowerPool(state, side);
  if (!pool.length) return null;
  const cardId = pool[nextInt(state.rng, pool.length)];
  p.superpowers.push(cardId);
  p.hand.push({ iid: state.nextIid++, cardId });
  // starting 标记开局那一次抽取：界面把它写进提示行（不占横幅），
  // 之后的阈值抽取才用横幅提示（横幅会挤掉同时刻的「敌方使用锦囊」提示）。
  log(state, { type: 'superpower-draw', side, cardId, left: pool.length - 1, starting: !!(opts && opts.starting) });
  return cardId;
}

/** 对局开始时双方各抽一张（turns.js 的 startGame 调用） */
export function giveStartingSuperpowers(state) {
  const got = [];
  for (const p of state.players) {
    if (!p.faction) continue;
    const id = drawSuperpower(state, p.side, { starting: true });
    got.push(id);
  }
  return got;
}

/**
 * 国王掉血后检查阈值（damage.js 的王伤分支调用）。
 * 一次掉血跨过好几个阈值就一次抽好几张（作者口径：<15 / <9 / <3 各一张）。
 */
export function checkSuperpowerThresholds(state, side) {
  const p = state.players[side];
  if (!p || !p.faction) return [];
  const got = [];
  for (const t of SUPERPOWER_THRESHOLDS) {
    if (p.kingHp < t && !p.spThresholds[t]) {
      p.spThresholds[t] = true;
      got.push(drawSuperpower(state, side));
    }
  }
  return got;
}

/**
 * 「下个大回合开始时召唤」：只排队，不召唤。
 * 真正的召唤在 turns.js 的 onTurnStart（大回合开始的唯一时刻），保证只结算一次。
 */
export function queueDelayedSummon(state, side, cardId, delay) {
  if (!Array.isArray(state.delayedSummons)) state.delayedSummons = [];
  const d = Math.max(1, delay || 1);
  state.delayedSummons.push({ side, cardId, atTurn: state.turn + d });
  log(state, { type: 'delayed-summon', side, cardId, atTurn: state.turn + d });
}
