/**
 * 门面：效果 DSL 解释器的对外出入口。
 *
 * ⚠ 本文件只做转发，实现已按职责拆到：
 *   targets.js  目标选择器（describeTarget / resolveTargets）
 *   actions.js  动作执行（execActions / execAction）
 *   amounts.js  动态数值与阵营（resolveAmount / resolveSide / asUnit / asKing）
 *
 * 除此之外还继续导出 log（历史上 effects.js 末尾就有
 * `export { resolveSide, asUnit, asKing, log };`）—— 这四个名字仍然可以从本文件取到。
 *
 * 依赖方向：keywords ← mechanics ← effects ← engine
 * 实现（targets/actions/amounts）不反向 import 本文件，避免自引用。
 */

import { describeTarget, resolveTargets } from './targets.js';
import { execActions, execAction, evalCondition } from './actions.js';
import { resolveAmount, resolveSide, asUnit, asKing } from './amounts.js';
import { log } from './mechanics.js';

export {
  describeTarget, resolveTargets,
  execActions, execAction, evalCondition,
  resolveAmount, resolveSide, asUnit, asKing,
  log,
};
