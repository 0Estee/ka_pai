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
import { ROOT, api, elements, timers, check } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const renderSrc = read('app/js/render.js');
const flowSrc = read('app/js/game-flow.js');
const cssSrc = read('app/style.css');
const mainSrc = read('app/js/main.js');
const uiSrc = read('app/js/ui.js');

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

/**
 * 落点等飞完再露牌（作者 2026-10-07）：
 *   手牌从卡槽飞向落点的那段动画播完之前，落点格子里的牌不能先出现。
 * 隐藏状态放在 JS 里（view.flyPending），所以渲染只是照当前状态画一遍：
 * 飞行途中重绘不会提前露出，飞完（或动画没播成）再摘掉标记。
 */
const pump = (rounds = 60) => {
  for (let i = 0; i < rounds; i++) {
    const list = [...timers.entries()];
    if (!list.length) break;
    for (const [id, t] of list) { timers.delete(id); try { t.fn(); } catch (e) { /* 忽略 */ } }
  }
};

check('源码：落点先藏住、飞完再露牌（渲染前扫描 / 渲染后起飞）', () => {
  for (const n of ['function scanCardFlights(', 'function hideSlotForFlight(', 'function revealFlightSlot(', 'view.flyPending', "hides: e.type === 'deploy'"]) {
    if (!renderSrc.includes(n)) throw new Error('render.js 缺少 ' + n);
  }
  const at = renderSrc.indexOf('view.revealShown = boardReveal');
  const seg = renderSrc.slice(at, at + 500);
  const scan = seg.indexOf('scanCardFlights();');
  const draw = seg.indexOf('render(stage, state, view);');
  if (scan < 0) throw new Error('refresh() 没有在渲染前扫描飞行');
  if (draw < 0 || scan > draw) throw new Error('扫描必须在 render() 之前，否则牌会先在格子里露出来');
  if (!uiSrc.includes('fly-pending')) throw new Error('ui.js 没有给落点格子打 fly-pending');
  if (!uiSrc.includes('view.flyPending')) throw new Error('ui.js 没有读 view.flyPending');
  if (!cssSrc.includes('.slot.fly-pending')) throw new Error('style.css 缺少 .slot.fly-pending 规则');
});

check('落点格子先藏住牌，飞行计时器跑完才露出来', () => {
  api.__newGame();
  api.__pause(true);
  const st = api.__game();
  if (!st || !Array.isArray(st.log)) throw new Error('没有拿到对局 state.log');
  // 伪一条刚刚打出的单位日志：落点是 mountain 路 / 我方前排
  st.log.push({ type: 'deploy', uid: 900001, cardId: 'U05', name: '吸血鬼', side: 0, lane: 'mountain', row: 'front' });
  api.refresh();
  const html = elements.get('stage').innerHTML;
  const spot = new RegExp('class="[^"]*fly-pending[^"]*" data-lane="mountain" data-side="0" data-row="front"');
  if (!spot.test(html)) throw new Error('打出单位后，落点格子没有先藏住牌');
  pump(60);
  const after = elements.get('stage').innerHTML;
  if (after.includes('fly-pending')) throw new Error('飞行结束后落点格子还藏着牌');
  if (!after.includes('data-lane="mountain"')) throw new Error('揭开之后棋盘没有渲染回来');
});

/**
 * 弃置的慢速飞离（作者 2026-10-10）：
 *   卡牌被弃置时要缓慢从手牌中飞出  引擎的 discard 日志带 iid，
 *   界面靠它把「飞出去的是哪一张」配对到答问之前抓下的卡面。
 */
check('源码：弃置动画的抓拍 / 慢速时长 / 配对都对上了', () => {
  for (const n of ['function captureDiscardSource(', 'function takeDiscardSource(', 'const FLIGHT_MS_SLOW', "kind: 'discard'", "slow: true"]) {
    if (!renderSrc.includes(n)) throw new Error('render.js 缺少 ' + n);
  }
  if (!renderSrc.includes('iid: e.iid == null ? null : e.iid')) throw new Error('弃置飞行没有带上日志里的 iid');
  const inputSrc = read('app/js/play-input.js');
  if (!inputSrc.includes('captureDiscardSource(answer.iid')) throw new Error('play-input.js 答「选择弃置」之前没有抓源卡');
  if (!inputSrc.includes("rq.type === 'chooseHandCard'")) throw new Error('抓源卡没有限定在 chooseHandCard 上');
});

check('弃置：自己的牌从手牌飞出、对手的牌从屏幕上方飞出，都带上 iid', () => {
  api.__newGame();
  api.__pause(true);
  const st = api.__game();
  const hc = st.players[0].hand[0];
  if (!hc) throw new Error('开局手牌是空的，这条检查没有意义');
  const before = api.__cardFlightSeq();
  st.log.push({ type: 'discard', side: 0, cardId: hc.cardId, iid: hc.iid });
  st.log.push({ type: 'discard', side: 1, cardId: 'U05', iid: 987654, stolen: true });
  api.refresh();
  const added = api.__cardFlightSeq() - before;
  if (added !== 2) throw new Error('两条弃置日志应各记一笔飞行，实际 ' + added);
  const tail = api.__cardFlights().slice(-2);
  if (tail[0].kind !== 'discard') throw new Error('弃置应记成 discard，实际 ' + tail[0].kind);
  if (tail[0].from !== 'hand') throw new Error('自己的弃牌应从手牌飞出去，实际 from=' + tail[0].from);
  if (tail[0].iid !== hc.iid) throw new Error('弃置飞行要带 iid（界面靠它认是哪一张），实际 ' + tail[0].iid);
  if (tail[0].side !== 0) throw new Error('弃置飞行的 side 记错了：' + tail[0].side);
  if (tail[1].from !== 'above') throw new Error('对手的弃牌应从屏幕上方飞出，实际 from=' + tail[1].from);
  if (tail[1].cardId !== 'U05') throw new Error('对手的弃牌要带上 cardId，实际 ' + tail[1].cardId);
  if (tail.some((f) => f.animated)) throw new Error('门禁没有 DOM，不应有已播动画的记录');
});

check('弃置：同一张牌只飞一次（重绘不重放）', () => {
  const before = api.__cardFlightSeq();
  api.refresh();
  api.refresh();
  const added = api.__cardFlightSeq() - before;
  if (added !== 0) throw new Error('重绘又记了 ' + added + ' 笔弃置飞行，游标没推进');
});
