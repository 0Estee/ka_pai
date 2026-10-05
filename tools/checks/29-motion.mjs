/**
 *  0.47.0 动画（作者 2026-10-05 的三条要求）
 *
 * 1. 菜单逐级切换：前进时旧页面先向右让一小步、再向左滑出，新页面从右滑入；返回相反。
 * 2. 开局入场：棋盘从上往下一行行铺开，手牌从下滑入。
 * 3. 交战时只渲染要攻击的卡牌 / 国王，不再整行闪（fx-lane 已删）。
 *
 * 帧动画是 CSS 的，这里只能断言「类与序号有没有挂上」「旧实现有没有留下」。
 * 真实观感靠 tools/verify-apk.ps1 的截图人工核对。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, api, elements, check } from './harness.mjs';

console.log('\n 0.47.0 动画（菜单切换 / 开局铺开 / 不再整行闪）');

const stageEl = () => elements.get('stage');
const stageHTML = () => (stageEl() && stageEl().innerHTML) || '';
const hasCls = (c) => !!(stageEl() && stageEl().classList.contains(c));

check('前进：新页面从右滑入（nav-forward + nav-in）', () => {
  api.__go('home');
  api.__go('play');
  if (!hasCls('nav-forward')) throw new Error('进二级菜单没有挂 nav-forward');
  if (!hasCls('nav-in')) throw new Error('进二级菜单没有挂 nav-in（新页面没有滑入动画）');
});

check('返回：方向相反（nav-back + nav-in）', () => {
  api.__go('home');
  if (!hasCls('nav-back')) throw new Error('返回主菜单没有挂 nav-back（方向应当与进入相反）');
  if (!hasCls('nav-in')) throw new Error('返回主菜单没有挂 nav-in');
  api.__go('home');
});

check('逐级进第三级也是前进方向（二级 -> 三级）', () => {
  api.__go('play');
  api.__go('difficulty');
  if (!hasCls('nav-forward')) throw new Error('二级进三级没有挂 nav-forward');
  api.__go('play');
  if (!hasCls('nav-back')) throw new Error('三级返回二级没有挂 nav-back');
  api.__go('home');
});

check('开局：棋盘与手牌带序号，且挂了 board-enter（从上往下铺开）', () => {
  api.__go('game');
  if (!hasCls('board-enter')) throw new Error('进入对局没有挂 board-enter（没有铺开动画）');
  const html = stageHTML();
  if (!html.includes('board-row')) throw new Error('对局画面里没有 board-row');
  if (!/class="board-row[^"]*" style="--i:[0-9]+"/.test(html)) throw new Error('棋盘行没有写 --i 序号（没法逐行错开延迟）');
  if (!/data-iid="[^"]+" style="--i:[0-9]+"/.test(html)) throw new Error('手牌没有写 --i 序号（没法逐张滑入）');
  api.__go('home');
});

check('不再整行闪：ui.js / style.css 里都没有 fx-lane', () => {
  for (const rel of ['app/js/ui.js', 'app/style.css']) {
    const s = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (s.includes('fx-lane')) throw new Error(rel + ' 里还留着 fx-lane（整行闪光）');
  }
});

check('四段关键帧都在 screens.css 里（滑出 / 滑入 / 铺开 / 滑入滑出）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'app/screens.css'), 'utf8');
  for (const k of ['nav-out-left', 'nav-out-right', 'nav-in-right', 'nav-in-left', 'board-in', 'hand-in']) {
    if (!css.includes('@keyframes ' + k + ' {')) throw new Error('screens.css 里缺关键帧 ' + k);
  }
  for (const sel of ['.nav-ghost.nav-out-left', '#stage.board-enter .board-row', '#stage.board-enter .hand .card']) {
    if (!css.includes(sel)) throw new Error('screens.css 里缺规则 ' + sel);
  }
});
