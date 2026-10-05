/**
 *  0.49.0 动画（作者 m10625 / m10666 两轮反馈后的修正版）
 *
 * 1. 只动菜单项：按钮 / 难度行 / 房间行从右（前进）或左（返回）逐个滑入，整页不平移、旧页面不整页退场。
 * 2. 只播一次：入场标记是渲染时写在容器上的 data-nav / data-in 属性，同屏刷新会重新生成 HTML，
 *    所以挂在属性上而不是 #stage 的类上  否则刷新一次动画就从头重放（看起来就是「卡一下、动画过快」）。
 * 3. 动画放慢并保证播完：.50s，逐个延迟最多 .30s。
 * 4. 开局：棋盘从上往下一行行铺开，手牌从下滑入。
 * 5. 交战时只渲染要攻击的卡牌 / 国王（fx-lane 已删）。
 * 6. 手牌横向滚动位置要留着重绘前的那一份。
 *
 * 帧动画是 CSS 的，这里只能断言「标记 / 序号 / 关键帧有没有挂上」。真实观感靠 tools/verify-apk.ps1 截图人工核对。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, api, elements, check } from './harness.mjs';

console.log('\n 0.49.0 动画（只动菜单项 / 只播一次 / 手牌滚动位置）');

const stageEl = () => elements.get('stage');
const stageHTML = () => (stageEl() && stageEl().innerHTML) || '';
const hasCls = (c) => !!(stageEl() && stageEl().classList.contains(c));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

check('前进：菜单项带 in-right，且仍标记为前进（nav-forward）', () => {
  api.__go('home');
  api.__go('play');
  const html = stageHTML();
  if (!html.includes('data-nav="in-right"')) throw new Error('进入人机对决没有带上滑动动画标记');
  if (!hasCls('nav-forward')) throw new Error('进二级菜单没有挂 nav-forward');
  if (hasCls('nav-in')) throw new Error('又挂上了整页动画类 nav-in（作者要求只动按钮）');
});

check('返回：动画方向相反（in-left）', () => {
  api.__go('home');
  const html = stageHTML();
  if (!html.includes('data-nav="in-left"')) throw new Error('返回主菜单没有带上反向滑动动画标记');
  if (hasCls('nav-in')) throw new Error('返回时又挂上了整页动画类 nav-in');
});

check('逐级进第三级也是前进方向（二级 -> 三级）', () => {
  api.__go('play');
  api.__go('difficulty');
  if (!stageHTML().includes('data-nav="in-right"')) throw new Error('二级进三级没有带上 in-right');
  api.__go('play');
  if (!stageHTML().includes('data-nav="in-left"')) throw new Error('三级返回二级没有带上 in-left');
  api.__go('home');
});

check('同一屏幕再刷新一次不会重放动画（卡一下的根因）', () => {
  api.__go('play');
  api.__go('play');
  if (stageHTML().includes('data-nav=')) throw new Error('同屏刷新又带上了入场标记，动画会被重放');
  api.__go('home');
});

check('开局入场：进入对局的那次渲染带 data-in，开场窗口过后不再带（不会重放）', () => {
  const realNow = api.Date.now;
  let fake = 1000;
  api.Date.now = () => fake;
  try {
    api.__go('home');
    api.__go('game');
    const first = stageHTML();
    if (!first.includes('data-in="1"')) throw new Error('进入对局没有带上摊开动画标记');
    if (!/class="board-row[^"]*" data-in="1"/.test(first)) throw new Error('棋盘行没有带 data-in');
    if (!/data-iid="[^"]+" data-in="1"/.test(first)) throw new Error('手牌没有带 data-in');
    if (!/class="board-row[^"]*" data-in="1" style="--i:[0-9]+"/.test(first)) throw new Error('棋盘行没有写 --i 序号');
    if (!/data-iid="[^"]+" data-in="1" style="--i:[0-9]+"/.test(first)) throw new Error('手牌没有写 --i 序号');
    fake = 1200;
    api.__go('game');
    if (!stageHTML().includes('data-in="1"')) throw new Error('开场窗口内的刷新丢掉了 data-in（动画会被掐掉）');
    fake = 4000;
    api.__go('game');
    if (stageHTML().includes('data-in="1"')) throw new Error('开场窗口过后还带 data-in，铺开动画会被重放');
  } finally {
    api.Date.now = realNow;
  }
  api.__go('home');
});

check('CSS：动画只挂在渲染时的属性上，且不再有整页移动', () => {
  const css = read('app/screens.css');
  for (const bad of ['.nav-ghost', '#stage.nav-in', 'nav-out-left', 'nav-out-right', 'board-enter']) {
    if (css.includes(bad)) throw new Error('screens.css 里还有旧动画：' + bad);
  }
  for (const need of ['[data-nav="in-right"] .hm-btn', '[data-nav="in-left"] .hm-btn', '.board-row[data-in="1"]', '.hand .card[data-in="1"]', '.50s']) {
    if (!css.includes(need)) throw new Error('screens.css 里缺动画规则：' + need);
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
