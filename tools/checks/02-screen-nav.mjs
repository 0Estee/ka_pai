/** § 屏幕导航：按钮点出来的那条路 */
import { api, elements, check } from './harness.mjs';

console.log('\n§ 屏幕导航：按钮点出来的那条路');

/**
 * 这一节测的是 handleAction 的路由表 —— 「AI 对决进不去」那个 bug 就住在里面。
 *
 * 曾经：「开始游戏 → AI 对决 → 选难度」在选完难度后又 `screen = 'play'`
 * 绕回二级菜单，而**全流程没有任何一个按钮会调 startNewGame()**，
 * 所以 AI 对决永远开不了局。
 *
 * 注意：只调 __go() 是抓不到这个 bug 的 —— __go 直接改 screen，绕过路由表。
 */
check('首页 →「开始游戏」→ 二级菜单（AI 对决 / 局域网对决）', () => {
  if (api.__nav('start-game') !== 'play') throw new Error(`应进 play，实际 ${api.__screen()}`);
  const html = elements.get('stage').innerHTML;
  if (!html.includes('data-act="choose-ai"')) throw new Error('二级菜单缺少「AI 对决」入口');
  if (!html.includes('data-act="lan-menu"')) throw new Error('二级菜单缺少「局域网对决」入口');
  if (!html.includes('>AI 对决</span>')) throw new Error('二级菜单的入口文案必须是「AI 对决」（曾被写成 PI）');
});

check('二级菜单 →「AI 对决」→ 难度页（5 个难度）', () => {
  if (api.__nav('choose-ai') !== 'difficulty') throw new Error(`应进 difficulty，实际 ${api.__screen()}`);
  const rows = (elements.get('stage').innerHTML.match(/data-act="set-difficulty"/g) || []).length;
  if (rows !== 5) throw new Error(`难度项应为 5 个，实际 ${rows}`);
  const dHtml = elements.get('stage').innerHTML;
  if (!dHtml.includes('AI 难度')) throw new Error('难度页标题必须是「AI 难度」');
  if (dHtml.includes('PI')) throw new Error('难度页出现了 PI 字样');
});

check('选难度只改选中项，不把玩家弹回二级菜单', () => {
  if (api.__nav('set-difficulty', { key: 'hard' }) !== 'difficulty') {
    throw new Error(`选完难度应留在 difficulty，实际 ${api.__screen()}`);
  }
  if (api.__settings().difficulty !== 'hard') throw new Error('选的难度没有存进设置');
  if (!elements.get('stage').innerHTML.includes('data-key="hard"')) throw new Error('难度页没有按新难度重绘');
});

check('难度页 →「开始对战」真的能建出对局（这个按钮以前根本不存在）', () => {
  if (!elements.get('stage').innerHTML.includes('data-act="start-ai"')) {
    throw new Error('难度页缺少「开始对战」按钮，玩家没有任何办法开局');
  }
  if (api.__nav('start-ai') !== 'game') throw new Error(`应进 game，实际 ${api.__screen()}`);
  if (!api.__game()) throw new Error('点了「开始对战」却没有建出对局');
  if (!elements.get('stage').innerHTML.includes('board-row')) throw new Error('开局后棋盘没渲染出来');
  api.__pause(false); // __playTurns 之外别让回合循环挂着；下面会重新开局
});
