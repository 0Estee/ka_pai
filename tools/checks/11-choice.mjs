/** § 抉择：效果打到一半反问玩家 */
import { api, check } from './harness.mjs';

// ── 目标高亮（含国王）─────────────────────────────────────
console.log('\n§ 抉择：效果打到一半反问玩家');

check('「抉择」：会挂起并弹出二选一，点选后结算并恢复', () => {
  if (typeof api.__demoChoice !== 'function') throw new Error('缺少 __demoChoice 钩子');
  const info = api.__demoChoice();
  if (info.error) throw new Error(`打出歼-10 失败：${info.error}`);
  if (!info.pending) throw new Error('引擎没有挂起 —— 抉择面板不会出现');
  if (!info.hasMask) throw new Error('挂起了，但界面上没有渲染出 choice-mask 面板');
  if (info.options.length !== 2) throw new Error(`应该有 2 个选项，实际 ${info.options.length}`);
  for (const label of info.options) {
    if (!info.html.includes(label)) throw new Error(`选项「${label}」没有渲染到界面上`);
  }
  if (!info.html.includes('data-act="choose-option"')) throw new Error('选项按钮没有绑定 choose-option');

  // 点第二个选项：「+4⚔+2♥ 并获得装甲1」→ 场上应该是 8/6
  const after = api.__resolveChoice(1);
  if (after.pending) throw new Error('回答之后仍然处于挂起状态');
  if (after.atk !== 8 || after.hp !== 6) {
    throw new Error(`选第二项后应该是 8/6，实际 ${after.atk}/${after.hp}`);
  }
  if (after.auto !== true) throw new Error('交互走完后没有把 autoResolveChoices 恢复成 true（后面会自动卡住）');
});

check('「抉择」：点第一个选项走另一条分支（少花 4 费 + 穿透1）', () => {
  const info = api.__demoChoice();
  if (!info.pending) throw new Error('没有挂起');
  const after = api.__resolveChoice(0);
  if (after.pending) throw new Error('回答之后仍挂起');
  if (after.atk !== 4 || after.hp !== 4) {
    throw new Error(`选第一项不该改身材，实际 ${after.atk}/${after.hp}`);
  }
  if (after.mana !== 16) throw new Error(`8 费打出 + 退还 4 = 剩 16，实际 ${after.mana}`);
});
