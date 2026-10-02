/** § 进入对局 */
import { api, elements, timers, check } from './harness.mjs';

console.log('\n§ 进入对局');
api.__newGame();

/**
 * 回归：开局时如果 AI 是先手，回合循环必须仍然跑起来。
 *
 * 曾经因为 startNewGame() 先调 newGame()（内部就调了 tick()）再设
 * screen='game'，而 tick() 开头有 `if (screen !== 'game') return;` ——
 * 于是 tick() 在守卫处直接返回，整个回合循环根本没启动。
 * 表现是「有时开局无法出牌也无法结束回合」（先手随机，所以是「有时」）。
 */
check('开局后回合循环确实在推进（覆盖 AI 先手的情况）', () => {
  // 反复开局，直到碰到一次「AI 先手」，再确认循环能推进
  let sawAiFirst = false;
  for (let i = 0; i < 40; i++) {
    api.__newGame();
    const s = api.__game();
    if (s.firstPlayer !== 0) {
      sawAiFirst = true;
      // AI 是先手 → 开局应该在 AI 的放置阶段，并且有计时器在排队
      if (timers.size === 0) {
        throw new Error('AI 先手时没有排任何计时器，回合循环没启动（这个 bug 又回来了）');
      }
      // 把计时器跑掉若干轮，确认阶段真的能往前走
      const phaseBefore = s.phase;
      let steps = 0;
      while (timers.size > 0 && steps++ < 30) {
        const [id, t] = [...timers.entries()][0];
        timers.delete(id);
        t.fn();
      }
      const after = api.__game();
      if (after.turn === s.turn && after.phase === phaseBefore) {
        throw new Error(`跑了 30 轮计时器，回合与阶段都没变（${phaseBefore}）—— 循环卡住了`);
      }
      break;
    }
  }
  if (!sawAiFirst) throw new Error('40 次开局都没碰到 AI 先手，测试没覆盖到目标场景');

  // 这条测试会把回合往前推，测完复位成全新的一局，
  // 免得影响后面「初始 state 应为第 1 回合」的断言
  api.__newGame();
});

check('初始 state 已建立（第 1 回合）', () => {
  const s = api.__game();
  if (!s) throw new Error('__game() 返回空');
  if (s.turn !== 1) throw new Error(`回合数应为 1，实际 ${s.turn}`);
  if (!['TURN_START', 'DEPLOY_FIRST', 'DEPLOY_SECOND', 'SPELL_FIRST', 'SPELL_SECOND'].includes(s.phase)) {
    throw new Error(`初始阶段异常: ${s.phase}`);
  }
});

check('stage 已渲染出战场与手牌', () => {
  const html = elements.get('stage')?.innerHTML ?? '';
  if (!html) throw new Error('stage.innerHTML 为空');
  for (const marker of ['board-row', 'lane-head', 'class="hand"', 'statusbar', 'phasebar']) {
    if (!html.includes(marker)) throw new Error(`渲染结果缺少 ${marker}`);
  }
});

check('战场包含 5 排 × 4 路 = 20 格', () => {
  const html = elements.get('stage').innerHTML;
  const slots = (html.match(/class="slot/g) || []).length;
  // 4 排单位格 × 4 路 = 16 个单位格 + 4 个陷阱格
  if (slots !== 20) throw new Error(`slot 数量应为 20，实际 ${slots}`);
});
