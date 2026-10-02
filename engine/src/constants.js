/**
 * 游戏常量定义
 * 对应《规则书 v0.2》§5 战场
 *
 * 本文件不含任何 Node 专有 API，可同时用于 Node 与浏览器。
 */

/** 四条线路，顺序即开战结算顺序：山地 → 平地(左) → 平地(右) → 水路 */
export const LANES = ['mountain', 'plainL', 'plainR', 'water'];

export const LANE_NAME = {
  mountain: '山地',
  plainL: '平地(左)',
  plainR: '平地(右)',
  water: '水路',
};

/** 相邻线路（用于「溅射」）。山地与平地(左)相邻，水路与平地(右)相邻。 */
export const ADJACENT_LANES = {
  mountain: ['plainL'],
  plainL: ['mountain', 'plainR'],
  plainR: ['plainL', 'water'],
  water: ['plainR'],
};

/** 两条排。front = 前排（可被普通交战命中），back = 后排（只受溅射/穿透影响） */
export const ROWS = ['front', 'back'];

/** 默认不可放置的线路（除非拥有 两栖 / 水生） */
export const DEFAULT_FORBIDDEN_LANES = ['water'];

/** 阵营 / 玩家编号。first = 先手，second = 后手。后手是固定的角色，不轮换。 */
export const SIDE = { FIRST: 0, SECOND: 1 };

/**
 * 玩家编号的中性名称。
 *
 * 注意：不要把玩家编号当成「先手/后手」—— 先后手是开局随机决定、
 * 之后固定不变的角色（规则书 §4），由 state.firstPlayer 决定。
 * 玩家 0 既可能是先手也可能是后手。需要角色名时用 roleName(state, side)。
 */
export const SIDE_NAME = { 0: '玩家0', 1: '玩家1' };

/** 某个玩家在这一局里扮演先手还是后手 */
export const roleName = (state, side) => (state.firstPlayer === side ? '先手' : '后手');

/** 一回合内的阶段顺序（对应规则书 §7） */
export const PHASES = [
  'TURN_START',   // 0. 上回合遗留效果结算（淬毒/疾病）+ 抽牌
  'DEPLOY_FIRST', // 1. 先手放置单位
  'DEPLOY_SECOND',// 2. 后手放置单位
  'SPELL_FIRST',  // 3. 先手打出锦囊
  'SPELL_SECOND', // 4. 后手打出锦囊
  'COMBAT',       // 5. 开战：山地 → 平地(左) → 平地(右) → 水路
  'TURN_END',     // 回合结束
];

/** 阶段 → 该阶段允许行动的玩家；null 表示非行动阶段 */
export const PHASE_ACTOR = {
  DEPLOY_FIRST: SIDE.FIRST,
  DEPLOY_SECOND: SIDE.SECOND,
  SPELL_FIRST: SIDE.FIRST,
  SPELL_SECOND: SIDE.SECOND,
};

/** 阶段 → 该阶段允许打出的卡牌类型 */
export const PHASE_ALLOWED_CARD_TYPE = {
  DEPLOY_FIRST: 'unit',
  DEPLOY_SECOND: 'unit',
  SPELL_FIRST: 'spell',
  SPELL_SECOND: 'spell',
};

/** 卡牌类型 */
export const CARD_TYPE = { UNIT: 'unit', SPELL: 'spell', TRAP: 'trap' };

/** 锦囊子类 */
export const SPELL_KIND = { ITEM: 'item', ATTACK: 'attack' };

/** 国王初始生命值 */
export const KING_MAX_HP = 20;

/**
 * 「复生」复活时回复到几点生命。
 *
 * 作者已裁决：**回满血**，且复活**不触发**「被消灭:」异能。
 * （不触发死亡异能是作者确认的；否则复生等于「免死 + 白嫖一次死亡异能」。）
 * 这个常量留着是为了以后想改成「1 血复活」时只动一处。
 */
export const REBIRTH_HP = Infinity;

/** 第 N 回合的费用上限 = N（规则书 §6） */
export const manaCapForTurn = (turn) => turn;

/**
 * 第 1 回合是否也执行「回合开始各抽 1 张」。
 *
 * 规则书原文：「每回合开始每人一张」→ 字面意思包含第 1 回合，
 * 于是起手会变成 先手 6 张 / 后手 5 张。
 *
 * 设为 false 则第 1 回合不抽，起手保持 先手 5 / 后手 4，
 * 这对后手更友好（先手已经先部署了）。改这一行即可切换。
 */
export const DRAW_ON_FIRST_TURN = true;

/** 回合上限：超过后按国王血量判胜负（裁决 A5） */
export const MAX_TURNS = 30;

/**
 * 「穿透 X」的最终口径（作者已裁决，原先的模式开关已移除）。
 *
 * 原文：「额外对这条线路上的X个敌方单位造成伤害，若这条线路上的敌方单位数小于X，
 *        则也会对敌方国王造成伤害」
 *
 * 实际规则（实现见 engine.js 的 collectAttackEvents）：
 *   1. 本体攻击先打「交战目标」（前排 → 后排 → 国王）
 *   2. 穿透在**主要目标之外**额外命中最多 X 个本线路敌方单位（含后排）
 *   3. 额外目标不足 X 个时，缺口溢出对国王造成**一次**攻击力伤害
 *      → 所以「穿透1」被 1 个前排挡住时，国王会吃到一次攻击力伤害
 *   4. 例外：本线路一个敌方单位都没有时，本体攻击已经打了国王，穿透不再重复加伤
 *
 * 另外注意：普通交战的优先级是 **前排 → 后排 → 国王**，
 * 也就是说前排清空后后排会被普通攻击命中（不再是"后排只能被溅射/穿透打到"）。
 */
