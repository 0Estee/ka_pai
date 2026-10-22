/**
 * 门面：状态机与公开 API 的对外出入口。
 *
 * ⚠ 本文件只有 `export … from`，不放任何实现 —— 实现已按职责拆到：
 *   setup.js    建局（createGame / makePlayer / makeBoard / instantiateUnit）
 *   turns.js    回合与阶段（startGame / getActor / enterPhase / advance / checkGameOver / …）
 *   play.js     出牌与合法性（costOf / getLegalPlays / playCard / …）
 *   choices.js  交互挂起与触发队列（takeChoice / resolveChoice / flushTriggers / …）
 *   combat.js   开战结算与召唤接口（runCombat / applyAttackBatch / apiFor / …）
 *   view.js     视图与调试（viewFor / renderBoard）
 *
 * 为什么保留这个文件：engine/test/smoke.mjs 与 app/js/*.js 都按
 * `import * as G from '../src/engine.js'` 取用，门面保证它们的 import 一行都不用改。
 * 导出名与拆分前**完全一致**，多出来的都是原来就没导出的内部函数。
 *
 * 对应《规则书 v0.2》§6 费用、§7 回合流程、§8 开战结算。
 *
 * 公开入口：
 *   createGame() → startGame() → 循环 { getLegalPlays / playCard / advance } → isOver()
 */

// 建局（createGame / 挂起哨兵 PENDING）

export { createGame } from './setup.js';

/**
 * 挂起哨兵。回放播放器要**主动**让某一问挂起等人喂答案时，必须把它原样
 * 交回去（`state.chooser` 返回它 = 「这一问我不答，请挂起」）。
 * 从 setup.js 转出来，免得界面只能靠 `import { PENDING } from setup.js`
 * 这种绕过门面的写法。
 */
export { PENDING } from './setup.js';

// 回合与阶段
export {
  startGame, getActor, isOver, enterPhase, advance, checkGameOver, sacrificeUnit, surrender,
} from './turns.js';

// 出牌与合法性
export {
  costOf, getLegalPlays, legalPlacements, canPlaceUnit, playCard, brew,
} from './play.js';

// 交互挂起与触发队列
export { resolveChoice, flushTriggers } from './choices.js';

// 开战结算与召唤接口
// 「拟定目标攻击」（强化士兵）：开战时轮到它出手才问目标，所以要能单独取到
export {
  runCombat, pickCombatTarget, askCombatTargets, combatPlanPrimary, combatTargetPicker,
} from './combat.js';

// 视图与调试
export { viewFor, renderBoard } from './view.js';

// 靶场（作者 2026-10-22）：试卡用的沙盒操作
export {
  sandboxEnable, sandboxFactionCards, sandboxGrantFaction, sandboxSetFaction,
  sandboxAddCard, sandboxRefillMana, sandboxClearBoard,
} from './sandbox.js';

// 阵营与超能力（作者 2026-10-03）
export { FACTIONS } from './factions.js';
// 炼金阵营（作者 2026-10-07）：炼药 + 原料堆
export {
  isRawMaterial, rawPileOf, RAW_MATERIAL_IDS, RAW_COMBOS, comboTokenFor, alchemyUnlock,
} from './factions.js';
// 炎帝阵营（作者 2026-10-12）：异火堆
export {
  isFlameCard, flamePileOf, FLAME_IDS, FLAME_PILE_MAKEUP, FLAME_LOTUS_ID,
  drawFlame, resetFlamePile, checkFlameLotus, noFlameAnywhere,
} from './factions.js';
