/**
 *  0.48.0 动画（作者 m10625 的三条反馈后的修正版）
 *
 * 1. 只动按钮：菜单按钮从右（前进）/ 左（返回）逐个滑入，整页不再平移、旧页面不再整页退场。
 * 2. 动画要播得完：延迟最多 .30s + 时长 .42s，JS 侧 900ms 后才摘掉入场类。
 * 3. 开局：棋盘从上往下一行行铺开，手牌从下滑入。
 * 4. 交战时只渲染要攻击的卡牌 / 国王（fx-lane 已删）。
 * 5. 手牌横向滚动位置要留着重绘前的那一份。
 *
 * 帧动画是 CSS 的，这里只能断言「类 / 序号 / 关键帧有没有挂上」。真实观感靠 tools/verify-apk.ps1 截图人工核对。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, api, elements, check } from './harness.mjs';

console.log('\n 0.48.0 动画（只动按钮 / 播得完 / 手牌滚动位置）');

const stageEl = () => elements.get('stage');
const stageHTML = () => (stageEl() && stageEl().innerHTML) || '';
const hasCls = (c) => !!(stageEl() && stageEl().classList.contains(c));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

check('前进：只挂 nav-forward（不再有整页 nav-in）', () => {
  api.__go('home');
  api.__go('play');
  if (!hasCls('nav-forward')) throw new Error('进二级菜单没有挂 nav-forward');
  if (hasCls('nav-in')) throw new Error('又挂上了整页动画类 nav-in（作者要求只动按钮）');
});

check('返回：方向相反（nav-back）', () => {
  api.__go('home');
  if (!hasCls('nav-back')) throw new Error('返回主菜单没有挂 nav-back');
  if (hasCls('nav-in')) throw new Error('返回时又挂上了整页动画类 nav-in');
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

check('开局：棋盘与手牌带序号，且挂了 board-enter', () => {
  api.__go('game');
  if (!hasCls('board-enter')) throw new Error('进入对局没有挂 board-enter（没有铺开动画）');
  const html = stageHTML();
  if (!html.includes('board-row')) throw new Error('对局画面里没有 board-row');
  if (!/class="board-row[^"]*" style="--i:[0-9]+"/.test(html)) throw new Error('棋盘行没有写 --i 序号');
  if (!/data-iid="[^"]+" style="--i:[0-9]+"/.test(html)) throw new Error('手牌没有写 --i 序号');
  api.__go('home');
});

check('CSS 只对菜单按钮做动画，且不再有整页移动', () => {
  const css = read('app/screens.css');
  for (const bad of ['.nav-ghost', '#stage.nav-in', 'nav-out-left', 'nav-out-right']) {
    if (css.includes(bad)) throw new Error('screens.css 里还有整页动画：' + bad);
  }
  for (const need of ['#stage.nav-forward .hm-btn', '#stage.nav-back .hm-btn', '.42s']) {
    if (!css.includes(need)) throw new Error('screens.css 里缺菜单按钮动画：' + need);
  }
  for (const k of ['menu-in-right', 'menu-in-left', 'board-in', 'hand-in']) {
    if (!css.includes('@keyframes ' + k + ' {')) throw new Error('screens.css 里缺关键帧 ' + k);
  }
});

check('手牌滚动位置会被保留（不是重绘后弹回最前面）', () => {
  const js = read('app/js/render.js');
  if (!js.includes('function handScrollOf(')) throw new Error('render.js 里没有 handScrollOf');
  if (!js.includes('function restoreHandScroll(')) throw new Error('render.js 里没有 restoreHandScroll');
  if (!js.includes('restoreHandScroll(stage, handScroll);')) throw new Error('对局分支没有恢复手牌滚动位置');
  if (!js.includes('restoreHandScroll(stage, replayHandScroll);')) throw new Error('回放分支没有恢复手牌滚动位置');
  if (js.indexOf('handScrollOf(stage)') > js.indexOf('restoreHandScroll(stage, handScroll);')) throw new Error('记录与恢复的顺序反了');
});

check('不再整行闪：ui.js / style.css 里都没有 fx-lane', () => {
  for (const rel of ['app/js/ui.js', 'app/style.css']) {
    if (read(rel).includes('fx-lane')) throw new Error(rel + ' 里还留着 fx-lane（整行闪光）');
  }
});
