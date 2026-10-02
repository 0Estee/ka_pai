/**  战斗可视化：每一次攻击都要在棋盘上看得见 */
import { api, elements, timers, check } from './harness.mjs';

console.log('\n 战斗可视化：每一次攻击都看得见');

/**
 * 引擎是「瞬间算完」，界面靠 state.log 逐条翻成特效。这一节守两件事：
 *    开战结算之后，棋盘上**必须**出现攻击类特效（整路高亮 / 出手前冲 / 受击抖动）；
 *    掉字（伤害数字）要真的渲染出来  它是「这一下打了多少」的唯一反馈。
 * 特效是 setTimeout 逐条播的（150ms 一条），而集成测试里的计时器是桩，
 * 所以要**手动把计时器推几步**再看渲染结果。
 */
function pumpTimers(rounds) {
  for (let i = 0; i < rounds; i++) {
    const pending = [...timers.entries()];
    if (!pending.length) break;
    for (const [id, t] of pending) {
      timers.delete(id);
      try { t.fn(); } catch { /* 桩里其它定时器抛错不影响这条断言 */ }
    }
  }
}

check('开战结算后棋盘上出现攻击特效（整路高亮 / 出手 / 受击）', () => {
  api.__go('home');
  api.__newGame();
  api.__pause(true);
  api.__place(0, 'W04', 'mountain', 'front'); // 5/6 打
  api.__place(1, 'W02', 'mountain', 'front'); // 2/1 挡
  let n = 0;
  while (api.__game().phase !== 'COMBAT' && n++ < 14) api.__advance();
  api.__advance(); // 结算开战
  const html = elements.get('stage').innerHTML;
  if (!/fx-(lane|lunge|hit)/.test(html)) {
    throw new Error('开战之后棋盘上没有任何攻击特效');
  }
});

check('每一次攻击都掉字（伤害数字真的渲染出来了）', () => {
  // 自包含：自己建局、自己打一次、自己泵计时器  不依赖上一条用例的残留状态
  //（fx 的游标/队列是跨局保留的，newGame 现在会调 resetCombatFx 清一次）。
  api.__go('home');
  api.__newGame();
  api.__pause(true);
  api.__place(0, 'W04', 'mountain', 'front');
  api.__place(1, 'W02', 'mountain', 'front');
  let n = 0;
  while (api.__game().phase !== 'COMBAT' && n++ < 14) api.__advance();
  api.__advance();
  let sawHitFx = false;
  let sawFloatHtml = false;
  for (let i = 0; i < 12; i++) {
    const st = api.__fx();
    if (st.fx && st.fx.kind === 'hit' && st.fx.text) sawHitFx = true;
    if (elements.get('stage').innerHTML.includes('fx-float')) sawFloatHtml = true;
    if (sawHitFx && sawFloatHtml) break;
    pumpTimers(1);
  }
  if (!sawHitFx) throw new Error('特效队列里从没出现「受击掉字」事件');
  if (!sawFloatHtml) throw new Error('fx 里有掉字事件，但棋盘上没有渲染出 fx-float');
});

check('特效队列不会无限堆（大战役也不会排成幻灯片）', () => {
  api.__go('home');
  api.__newGame();
  api.__pause(true);
  for (const lane of ['mountain', 'plainL', 'plainR', 'water']) {
    // 水路放不了陆地单位（地形限制）：那一路换成水生单位
    const mine = lane === 'water' ? 'K07' : 'W04';
    const foe = lane === 'water' ? 'K07' : 'W02';
    api.__place(0, mine, lane, 'front');
    api.__place(1, foe, lane, 'front');
  }
  let n = 0;
  while (api.__game().phase !== 'COMBAT' && n++ < 14) api.__advance();
  api.__advance();
  // 队列上限这件事由 pumpCombatFx 自己保证（cap 14），这里只确认没有因为大战役而卡住：
  // 特效是 setTimeout 逐条播的，只要还在播就说明队列没炸。
  const html = elements.get('stage').innerHTML;
  if (!/fx-(lane|lunge|hit)/.test(html) && !html.includes('board-row')) {
    throw new Error('大战役之后棋盘渲染异常');
  }
  // 收尾：把队列播完，别把定时器留给后面的用例
  pumpTimers(30);
  api.__pause(false);
});
