/**
 * 门面：状态机与公开 API 的对外出入口。
 *
 * ⚠ 本文件只做转发，不再放实现 —— 实现已按职责拆到：
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

import { createGame } from './setup.js';
import {
  startGame, getActor, isOver, enterPhase, advance, checkGameOver,
  triggerInHandEffects, applyHandStatDelta, onTurnStart, onTurnEnd,
  resolveByDeckOut, resolveMarks, resolveByTurnLimit,
} from './turns.js';
import {
  costOf, getLegalPlays, legalPlacements, canPlaceUnit, playCard,
  notifyAllyPlayed, notifyEnemyCastSpell, resolveHunt,
} from './play.js';
import {
  takeChoice, driveGenerator, resolveChoice, whenMet, flushTriggers,
  runTriggeredEffects, runKingTriggeredEffects,
} from './choices.js';
import {
  runCombat, queueCombatStartTriggers, resolveLane, applyAttackBatch, collectAttackEvents,
  apiFor, findSummonSpot, applySummonModify, notifyAllyExtraAttack,
  pickCombatTarget, askCombatTargets, combatPlanPrimary, combatTargetPicker,
} from './combat.js';
import { viewFor, describeUnit, renderBoard } from './view.js';
import { instantiateUnit, attackPower, probeFromDef, PENDING } from './setup.js';

export {
  createGame,
  startGame,
  getActor,
  isOver,
  enterPhase,
  advance,
  checkGameOver,
  costOf,
  getLegalPlays,
  legalPlacements,
  canPlaceUnit,
  playCard,
  resolveChoice,
  /**
   * 挂起哨兵。回放播放器要**主动**让某一问挂起等人喂答案时，必须把它原样
   * 交回去（`state.chooser` 返回它 = 「这一问我不答，请挂起」）。
   * 从 setup.js 转出来，免得界面只能靠 `import { PENDING } from setup.js`
   * 这种绕过门面的写法。
   */
  PENDING,
  flushTriggers,
  runCombat,
  // 「拟定目标攻击」（强化士兵）：开战时轮到它出手才问目标，所以要能单独取到
  pickCombatTarget,
  askCombatTargets,
  combatPlanPrimary,
  combatTargetPicker,
  viewFor,
  renderBoard,
};
