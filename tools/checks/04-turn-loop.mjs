/** § 异步回合循环（手动推进计时器） */
import { api, timers, check } from './harness.mjs';

console.log('\n§ 异步回合循环（手动推进计时器）');
check('推进计时器不会抛异常，且能走出回合开始阶段', () => {
  for (let i = 0; i < 8 && timers.size > 0; i++) {
    const [id, t] = [...timers.entries()][0];
    timers.delete(id);
    t.fn();
  }
  const s = api.__game();
  if (s.turn < 1) throw new Error('回合数异常');
});
