/**
 * 卡牌飞行（作者 2026-10-07）
 *   增手牌   -> 从屏幕正下方曲线划入卡槽
 *   打出手牌 -> 从卡槽滑向落点格子
 *   AI 出牌  -> 统一从屏幕正上方滑入
 *
 * 这一组验的是「意图算得对」与「没有 DOM 时不动手」：
 * 门禁的 DOM 桩没有 createElement / getBoundingClientRect / animate，
 * 动画本身只能在真机上看；这里保证渲染链路会算出该飞的卡、配对正确，
 * 而且缺这些能力时一行 DOM 都不碰（animated 恒为 false）。
 */
import { ROOT, api, elements, check } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const renderSrc = read('app/js/render.js');
const flowSrc = read('app/js/game-flow.js');
const cssSrc = read('app/style.css');
const mainSrc = read('app/js/main.js');

check('源码：render.js 有完整的飞行引擎（覆盖层 / 弧线 / 落点脉冲 / 日志）', () => {
  const need = ['function flushCardFlights(', 'function spawnFlight(', 'function arcFrames(', 'function resetCardFlights(', 'function captureHandCardSource(', 'function cardFlightLog(', 'function canFlyDom('];
  for (const n of need) if (!renderSrc.includes(n)) throw new Error('render.js 缺少 ' + n);
  if (!renderSrc.includes('fx-layer')) throw new Error('render.js 没有建覆盖层 #fx-layer');
});

check('源码：出牌前抓源卡、新局重置、样式与自检钩子都在', () => {
  if (!flowSrc.includes('captureHandCardSource(action.i')) throw new Error('game-flow.js 出牌前没有抓源卡');
  if (!flowSrc.includes('resetCardFlights();')) throw new Error('game-flow.js 新局没有重置飞行状态');
  for (const sel of ['#fx-layer', '.fly-card', 'slotDrop']) if (!cssSrc.includes(sel)) throw new Error('style.css 缺少 ' + sel);
  if (!mainSrc.includes('window.__cardFlights')) throw new Error('main.js 缺少 __cardFlights 自检钩子');
  if (!mainSrc.includes('window.__cardFlightSeq')) throw new Error('main.js 缺少 __cardFlightSeq 计数钩子');
  if (!mainSrc.includes('cardFlightLog()')) throw new Error('__cardFlights 没有接上 cardFlightLog()');
});

check('新抽到的手牌：每一张都记一笔「从屏幕下方划入」', () => {
  api.__newGame();
  const before = api.__cardFlightSeq();
  api.__demoHand(['U05', 'U07', 'U10']);
  const added = api.__cardFlightSeq() - before;
  if (added < 3) throw new Error('换了 3 张手牌，只记了 ' + added + ' 笔飞行');
  const tail = api.__cardFlights().slice(-3);
  for (const f of tail) {
    if (f.kind !== 'draw') throw new Error('新手牌应记成 draw，实际 ' + f.kind);
    if (f.from !== 'below') throw new Error('新手牌应从屏幕下方划入，实际 from=' + f.from);
    if (f.side !== 0) throw new Error('新手牌应记在真人那一侧，实际 side=' + f.side);
  }
});

check('整局跑完：出牌的飞行都记下来了，对手侧从屏幕上方滑入', () => {
  const r = api.__autoPlay();
  if (r && r.error) throw new Error(r.error);
  const plays = api.__cardFlights().filter((f) => f.kind === 'play');
  if (!plays.length) throw new Error('整局跑完没有任何出牌飞行的记录');
  if (!plays.some((f) => f.from === 'above')) throw new Error('对手出牌应从屏幕上方滑入，实际没有任何 above');
  for (const f of plays) {
    if (f.kind === 'play' && f.side !== -1 && f.lane != null && f.row == null) throw new Error('出牌飞行缺少落点行：' + JSON.stringify(f));
  }
});

check('DOM 桩里只记意图、不碰 DOM（animated 全为 false）', () => {
  const bad = api.__cardFlights().filter((f) => f.animated);
  if (bad.length) throw new Error('门禁没有 DOM，不应有已播动画的记录，实际 ' + bad.length + ' 笔');
});

check('飞行记录有上限，不会无限增长', () => {
  const all = api.__cardFlights();
  if (all.length > 200) throw new Error('飞行记录应截断在 200 条内，实际 ' + all.length);
  const seq = api.__cardFlightSeq();
  if (seq < all.length) throw new Error('累计计数不应小于当前条数：seq=' + seq + ' len=' + all.length);
});
