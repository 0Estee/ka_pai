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
  god: { key: 'god', name: '上帝' },
  // 作者 2026-10-04 给的第二批四大阵营（各 4 张非令牌超能力，卡 id U408~U425）
  sword: { key: 'sword', name: '剑道' },
  music: { key: 'music', name: '音乐' },
  science: { key: 'science', name: '科学' },
  divine: { key: 'divine', name: '神佑' },
  // 作者 2026-10-07：炼金阵营（原料堆 + 炼药 + 令牌）
  alchemy: { key: 'alchemy', name: '炼金' },
  // 作者 2026-10-10：超能力第三批三阵营（炼狱 / 极寒 / 罪恶，卡 id U445~U461）
  inferno: { key: 'inferno', name: '炼狱' },
  frost: { key: 'frost', name: '极寒' },
  sin: { key: 'sin', name: '罪恶' },
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
export function queueDelayedSummon(state, side, cardId, delay, spot) {
  if (!Array.isArray(state.delayedSummons)) state.delayedSummons = [];
  const d = Math.max(1, delay || 1);
  // spot 是打出时就选好的落点（作者 2026-10-04：召唤时在场上选一个位置）。
  // 到点时若那格被占，summonToken 会就近找合法格（findSummonSpot）。
  const lane = spot && spot.lane ? spot.lane : undefined;
  const row = spot && spot.row ? spot.row : 'front';
  state.delayedSummons.push({ side, cardId, atTurn: state.turn + d, lane, row });
  log(state, { type: 'delayed-summon', side, cardId, atTurn: state.turn + d, lane, row });
}

/**
 * 炼金阵营（作者 2026-10-07 规格，见 data/_transcribe/炼金阵营-规格.md）。
 *
 * 炼药：打出原料时再选手里其它原料，按「这一次消耗掉的原料」的组合把令牌加进手里。
 * 费用 = 消耗掉的原料各自费用的和（作者 Q2.A）；组合对不上就不给令牌。
 * 每抽一张牌就抽一张原料（起手不算）；原料堆 14 张，抽干不补（作者 Q3）。
 */

/** 四种原料的卡 id（金沙 / 厄毒之尘 / 陨铁 / 硫磺） */
export const RAW_MATERIAL_IDS = ['U426', 'U427', 'U428', 'U429'];

/** 原料堆构成：金沙 x3、厄毒之尘 x3、陨铁 x4、硫磺 x4（共 14 张） */
export const RAW_PILE_MAKEUP = [
  { cardId: 'U426', count: 3 },
  { cardId: 'U427', count: 3 },
  { cardId: 'U428', count: 4 },
  { cardId: 'U429', count: 4 },
];

/**
 * 组合表：键 = 消耗掉的原料卡 id 排序后加号连接，值 = 产出的令牌卡 id。
 * 组合只看这一次消耗掉的原料（打出的那张 + 被选中的那些）。
 */
export const RAW_COMBOS = {
  'U426+U426': 'U435',
  'U427+U427': 'U437',
  'U428+U428': 'U434',
  'U429+U429': 'U439',
  'U426+U427': 'U442',
  'U426+U428': 'U441',
  'U426+U429': 'U440',
  'U427+U428': 'U438',
  'U427+U429': 'U443',
  'U428+U429': 'U444',
  'U426+U427+U428+U429': 'U436',
};

/** 原料牌（进原料堆、不进牌库；只能通过炼药打出） */
export function isRawMaterial(def) {
  return !!(def && def.rawMaterial);
}

/** 一副新的原料堆 */
export function makeRawPile() {
  const pile = [];
  for (const m of RAW_PILE_MAKEUP) for (let i = 0; i < m.count; i++) pile.push(m.cardId);
  return pile;
}

/** 原料堆（缺了就补一副，保证老存档/测试里的 state 也能用） */
export function ensureRawPile(state, side) {
  const p = state.players && state.players[side];
  if (!p) return [];
  // 只有炼金阵营有原料堆：别的阵营不该因为界面要读一眼就被塞一副
  if (p.faction !== 'alchemy') return [];
  if (!Array.isArray(p.rawPile)) p.rawPile = makeRawPile();
  return p.rawPile;
}

/** 只读原料堆（界面用，不写 state） */
export function rawPileOf(state, side) {
  const p = state.players && state.players[side];
  if (!p || !Array.isArray(p.rawPile)) return [];
  return p.rawPile;
}

/** 抽一张原料进手牌；堆空了返回 null */
export function drawRawMaterial(state, side) {
  const p = state.players[side];
  if (!p || p.faction !== 'alchemy') return null;
  const pile = ensureRawPile(state, side);
  if (!pile.length) {
    log(state, { type: 'raw-material-empty', side });
    return null;
  }
  const idx = nextInt(state.rng, pile.length);
  const cardId = pile.splice(idx, 1)[0];
  p.hand.push({ iid: state.nextIid++, cardId });
  log(state, { type: 'raw-material', side, cardId, left: pile.length });
  return cardId;
}

/** 按类型从原料堆里指名取一张（未收录粉尘用），free 时花费压到 0 */
export function takeRawMaterial(state, side, cardId, opts) {
  const p = state.players[side];
  if (!p) return null;
  const pile = ensureRawPile(state, side);
  const idx = pile.indexOf(cardId);
  if (idx < 0) return null;
  pile.splice(idx, 1);
  const hc = { iid: state.nextIid++, cardId };
  if (opts && opts.free) {
    const def = state.cardLib[cardId];
    hc.costDelta = -(def ? (def.cost || 0) : 0);
  }
  p.hand.push(hc);
  log(state, { type: 'raw-material', side, cardId, left: pile.length });
  return hc;
}

/** 把原料退回原料堆（炼药消耗掉的那些） */
export function returnRawMaterials(state, side, cardIds) {
  const pile = ensureRawPile(state, side);
  for (const id of cardIds || []) pile.push(id);
  return pile;
}

/** 每抽一张牌就抽一张原料（stats.js 的 drawCards 末尾调用） */
export function alchemyOnDraw(state, side, n) {
  const p = state.players[side];
  if (!p || p.faction !== 'alchemy') return [];
  const got = [];
  for (let i = 0; i < n; i++) {
    const id = drawRawMaterial(state, side);
    if (!id) break;
    got.push(id);
  }
  return got;
}

/** 这一次消耗掉的原料能凑出哪张令牌；凑不出返回 null */
export function comboTokenFor(cardIds) {
  const key = (cardIds || []).slice().sort().join('+');
  return RAW_COMBOS[key] || null;
}

/** 解禁：国王身上挂着「可在自己的单位回合打出超能力锦囊牌」（整局有效） */
export function alchemyUnlock(state, side) {
  const p = state.players[side];
  if (!p) return false;
  if (p.alchemyUnlock === true) return true;
  if (!Array.isArray(p.kingEffects)) return false;
  return p.kingEffects.some((e) => e && e.kind === 'alchemyUnlock');
}

/** 炼金潮：本回合友方打出非原料锦囊时抽一张牌 */
export function alchemyTideOn(state, side) {
  const p = state.players[side];
  if (!p) return false;
  return p.alchemyTideTurn === state.turn;
}

/** 巫毒娃娃：每回合友方国王首次受到的伤害改为由敌方国王承受 */
export function findVoodooDoll(state, side) {
  const board = state.board || {};
  for (const lane of Object.keys(board)) {
    const units = board[lane] && board[lane].units;
    if (!units) continue;
    const row = units[side];
    if (!row) continue;
    for (const key of Object.keys(row)) {
      const u = row[key];
      if (u && u.voodooDoll) return u;
    }
  }
  return null;
}
