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
import { ROOT, api, elements, timers, check } from './harness.mjs';

// 这一节的用例要按卡面原值断言攻/血：AI 的强化（enhance.js 的 aiForge）会按难度
// 随机给敌方的牌加成，normal 起步就可能让 6 血靶子变成 6.4，所以固定成「简单」（不强化）。
api.setDifficulty('easy');

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

check('开局铺开：从上往下一行一行出现，重绘既不重放也不掐掉', () => {
  const STEP_MS = 90;
  const revealTimers = () => [...timers.entries()].filter(([, t]) => t.ms === STEP_MS);
  const stepReveal = () => {
    const hit = revealTimers()[0];
    if (!hit) throw new Error('没有铺开计时器在排队');
    timers.delete(hit[0]);
    hit[1].fn();
  };
  const hiddenRows = (html) => (html.match(/class="board-row[^"]*" data-in="0"/g) || []).length;

  api.__go('home');
  // 清掉前面分组可能留下的铺开计时器，免得抢到别人的
  for (const [id, t] of [...timers.entries()]) if (t.ms === STEP_MS) timers.delete(id);
  api.__newGame();
  const first = stageHTML();
  if (hiddenRows(first) !== 5) throw new Error('刚开局时五行都应还没出现，实际 ' + hiddenRows(first));
  if (first.includes('data-in="1"')) throw new Error('渲染出来的 HTML 不该带入場动画标记（重绘会重放）');
  if (!/class="board-row[^"]*" data-in="0" style="--i:[0-9]+"/.test(first)) throw new Error('棋盘行没有写 --i 序号');
  if (!/data-iid="[^"]+" data-in="0"/.test(first)) throw new Error('手牌在铺开完成前也应不可见');

  stepReveal();
  let html = stageHTML();
  if (hiddenRows(html) !== 4) throw new Error('铺开一步后应该只露出第一行，还没出现的行数 ' + hiddenRows(html));
  if (!/class="board-row r-foe-back"(?![^>]*data-in)/.test(html)) throw new Error('第一行（敌后排）没有出现');

  // 铺开中途来一次同屏重绘：进度要保持，且不能出现重放标记
  api.__go('game');
  html = stageHTML();
  if (hiddenRows(html) !== 4) throw new Error('同屏重绘把铺开进度弄丢了');
  if (html.includes('data-in="1"')) throw new Error('同屏重绘把入场动画重放了');

  for (let i = 0; i < 5; i++) stepReveal();
  html = stageHTML();
  if (hiddenRows(html) !== 0) throw new Error('铺开结束后还有行不可见');
  if (html.includes('data-in="0"')) throw new Error('铺开结束后还有不可见的格子');
  if (revealTimers().length) throw new Error('铺开结束后计时器没有停');
  api.__go('home');
});

check('CSS：动画只挂在渲染时的属性上，且不再有整页移动', () => {
  const css = read('app/screens.css');
  for (const bad of ['.nav-ghost', '#stage.nav-in', 'nav-out-left', 'nav-out-right', 'board-enter']) {
    if (css.includes(bad)) throw new Error('screens.css 里还有旧动画：' + bad);
  }
  for (const need of ['[data-nav="in-right"] .hm-btn', '[data-nav="in-left"] .hm-btn', '.board-row[data-in="1"]', '.hand .card[data-in="1"]', '.board-row[data-in="0"], .hand .card[data-in="0"]', '.50s']) {
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


check('铺开由 JS 推进：动画只能来自属性翻转，渲染出的 HTML 不带 data-in="1"', () => {
  const js = read('app/js/render.js');
  if (!js.includes('function startBoardReveal(')) throw new Error('render.js 里没有 startBoardReveal');
  if (!js.includes('function boardRevealStep(')) throw new Error('render.js 里没有 boardRevealStep');
  if (js.includes('boardFxUntil')) throw new Error('render.js 里还留着 700ms 窗口的 boardFxUntil');
  const ui = read('app/js/ui.js');
  // 只看代码：注释里可以出现这个字面量，不算渲染出来的 HTML
  const uiCode = ui.split('\n').filter((l) => { const s = l.trim(); return !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*'); }).join('\n');
  if (uiCode.includes('data-in="1"')) throw new Error('ui.js 渲染出的 HTML 不该带 data-in="1"（动画只由属性翻转产生）');
  if (!uiCode.includes('data-in="0"')) throw new Error('ui.js 没有把未铺开的行渲染成不可见（data-in="0"）');
  const gf = read('app/js/game-flow.js');
  if (!gf.includes('startBoardReveal();')) throw new Error('startNewGame 里没有启动铺开');
});

// ══════════════════════════════════════════════════════════
// 瞬态动画钩子（fx-*）：CSS 早就写好了，这一节守的是「有没有人真的用上它们」
//
// 门禁的 DOM 桩没有 querySelectorAll —— 接线代码在桩里会安静跳过（这正是设计要求）。
// 所以这里给 #stage 临时补一个假的 querySelector(All)：它先按选择器在**当前渲染出来的
// HTML** 里查有没有对应元素（打不中就不给节点，这样「存在性」才可信），命中就返回一个
// 只用来记账的空节点。于是可以断言「代码真的给这个选择器加了这个类」，不用真浏览器。
// 用完必须还原 —— 铺开那一节正是靠「桩里没有 querySelectorAll」来回退整块重绘。
// ══════════════════════════════════════════════════════════

/** 只做「选择器里的类名 / [属性=值] 出现在 HTML 里吗」这种粗匹配：够门禁用，不装 CSS 引擎 */
function fxSelPresent(html, sel) {
  for (const c of sel.match(/\.([A-Za-z0-9_-]+)/g) || []) if (!html.includes(c.slice(1))) return false;
  for (const a of sel.match(/\[[a-z-]+="[^"]*"\]/g) || []) if (!html.includes(a.slice(1, -1))) return false;
  return true;
}

/** 临时给 #stage 装一个记账用的 querySelector(All)，返回这一轮被加上的 { sel, cls } 列表 */
function withFxProbe(fn) {
  const stage = stageEl();
  const added = [];
  const mk = (sel) => {
    const cls = new Set();
    const node = {
      __sel: sel,
      classList: {
        add: (c) => { cls.add(c); added.push({ sel, cls: c }); },
        remove: (c) => cls.delete(c),
        contains: (c) => cls.has(c),
        toggle: () => {},
      },
      setAttribute() {}, getAttribute() { return null; },
      dataset: {}, style: {}, innerHTML: '', scrollLeft: 0,
    };
    node.closest = (s) => mk(s);
    return node;
  };
  const all = (sel) => {
    const html = stage.innerHTML || '';
    if (!fxSelPresent(html, sel)) return [];
    // pip 是一排：按 HTML 里真实的 pip 个数给，索引切片（只弹翻面的那几个）才有意义
    if (sel.endsWith('.pip')) {
      const n = (html.match(/class="pip/g) || []).length;
      return Array.from({ length: n }, () => mk(sel));
    }
    return [mk(sel)];
  };
  stage.querySelectorAll = all;
  stage.querySelector = (sel) => (fxSelPresent(stage.innerHTML || '', sel) ? mk(sel) : null);
  try { fn(added); } finally { delete stage.querySelectorAll; delete stage.querySelector; }
  return added;
}

const hasAdded = (added, cls, selPart) => added.some((a) => a.cls === cls && (!selPart || a.sel.includes(selPart)));

check('瞬态钩子都在：render.js 有扫描/施加两支，样式里八支的类与关键帧齐全', () => {
  const js = read('app/js/render.js');
  for (const n of ['function scanTransientFx(', 'function applyTransientFx(', 'function applyScreenFx(', 'function applyHomeFx(', 'function applyRoomsFx(', 'function applyReplayFx(', 'function dropHandPulse(', 'function spawnHandGhost(']) {
    if (!js.includes(n)) throw new Error('render.js 缺少 ' + n);
  }
  for (const c of ["'fx-death'", "'fx-dead'", "'fx-heal'", "'fx-pop-up'", "'fx-pop-down'", "'fx-phase'", "'fx-draw'", "'fx-spend'", "'fx-pop'", "'fx-row'", "'fx-num'", "'fx-warn'", "'fx-rp'"]) {
    if (!js.includes(c)) throw new Error('有钩子没接线：render.js 里找不到 ' + c);
  }
  for (const s of ['.statusbar', ' .sb-mana', '.sb-king[data-king="', '.unit[data-uid="', '.slot[data-lane="', '.room-row[data-url="http://', '.hud-gold', '.hud-lv', '.rp-btn-play', '.hand .card[data-iid="']) {
    if (!js.includes(s)) throw new Error('render.js 里找不到目标选择器片段：' + s);
  }
  for (const m of ['FX_POP_MS = 240', 'FX_ROW_MS = 300', 'FX_NUM_MS = 320', 'FX_WARN_MS = 260', 'FX_RP_MS = 280', 'FX_DEATH_MS = 340', 'FX_HEAL_MS = 420', 'FX_MANA_MS = 300', 'FX_PHASE_MS = 300', 'FX_DRAW_MS = 300', 'FX_SPEND_MS = 260']) {
    if (!js.includes(m)) throw new Error('时长和清单对不上：' + m);
  }
  const style = read('app/style.css');
  for (const r of ['.slot.fx-death .unit', '.sb-king.fx-heal', '.slot.fx-heal .unit', '.pip.fx-pop-up', '.sb-mana.fx-pop-down', '.phasebar.fx-phase .phase-name', '.slot.fx-dead .unit', '.hand .card.fx-draw', '@keyframes fx-draw', '.fx-spend', '@keyframes fx-spend']) {
    if (!style.includes(r)) throw new Error('style.css 缺少规则：' + r);
  }
  const scr = read('app/screens.css');
  for (const r of ['.fx-pop', '.net-banner.fx-pop', '.fx-row', '.fx-num', '.fx-warn', '.fx-rp']) {
    if (!scr.includes(r)) throw new Error('screens.css 缺少规则：' + r);
  }
});

check('棋盘侧接线：阶段 / 法力涨跌 / 回血都在活节点上加了类', () => {
  api.__go('home');
  api.__newGame();
  api.__pause(true);
  const st = api.__game();
  const u = api.__place(0, 'W04', 'mountain', 'front');
  // 阶段推进
  const a1 = withFxProbe((added) => { api.__setPhase(st.phase === 'COMBAT' ? 'TURN_END' : 'COMBAT'); api.refresh(); });
  if (!hasAdded(a1, 'fx-phase', '.phasebar')) throw new Error('阶段变了却没有给 .phasebar 加 fx-phase');
  // 法力：先把费用压到和 pip 数一致（__place 会把它顶到 99），再涨 / 降
  st.players[0].manaCap = 10;
  st.players[0].mana = 4;
  api.refresh();
  const a2 = withFxProbe((added) => { st.players[0].mana = 6; api.refresh(); });
  if (!hasAdded(a2, 'fx-pop-up', '.sb-mana')) throw new Error('法力增加没有给 .sb-mana 加 fx-pop-up');
  if (!hasAdded(a2, 'fx-pop-up', '.pip')) throw new Error('法力增加没有弹起新翻面的 pip');
  const a3 = withFxProbe((added) => { st.players[0].mana = 1; api.refresh(); });
  if (!hasAdded(a3, 'fx-pop-down', '.sb-mana')) throw new Error('法力减少没有给 .sb-mana 加 fx-pop-down');
  // 回血：拿场上真实的 uid，血条上的单位要能对上
  const a4 = withFxProbe((added) => { st.log.push({ type: 'heal', uid: u.uid, from: 1, to: 6 }); api.refresh(); });
  if (!hasAdded(a4, 'fx-heal')) throw new Error('治疗日志出现了却没有播 fx-heal');
});

check('阵亡接线：本路演出播完之后才给那一格加 fx-death，并靠静态 fx-dead 按住不弹回', () => {
  api.__go('home');
  api.__newGame();
  api.__pause(true);
  api.__place(0, 'W04', 'mountain', 'front');
  api.__place(1, 'W02', 'mountain', 'front');
  let n = 0;
  while (api.__game().phase !== 'COMBAT' && n++ < 14) api.__advance();
  // 作者 2026-10：退场与掉血都要等这一路的动画演完。所以结算当帧**不该**退场，
  // 要把队列里剩下的特效推完（手动推桩计时器），fx-death 才会补上。
  const added = withFxProbe(() => {
    api.__advance();
    const early = elements.get('stage').innerHTML || '';
    if (early.includes('fx-dead')) throw new Error('开战当帧就退场了：应该等本路动画演完再退');
    for (let i = 0; i < 30; i++) {
      for (const [id, t] of [...timers.entries()]) { timers.delete(id); try { t.fn(); } catch (e) { /* 桩 */ } }
    }
  });
  if (!added.some((a) => a.cls === 'fx-death' && a.sel.includes('.slot[data-lane='))) {
    throw new Error('单位阵亡了，残影格子上却没有加 fx-death');
  }
  if (!hasAdded(added, 'fx-dead')) throw new Error('没有补静态的 fx-dead（残影中途重绘会弹回不透明）');
});

check('屏侧接线：弹层 / 警示 / HUD 数字都在活节点上加了类', () => {
  // 弹层：抉择面板刚出现
  const a1 = withFxProbe(() => { api.__demoChoice(); });
  if (!hasAdded(a1, 'fx-pop', '.choice-box')) throw new Error('抉择弹层出现时没有加 fx-pop');
  // 警示：大厅那条 hf-warn，以及金币不足的 lobby-broke
  const pr = api.__profile();
  const gold = pr.gold;
  pr.gold = 0;
  const a2 = withFxProbe(() => { api.__demoLobby(); });
  pr.gold = gold;
  if (!hasAdded(a2, 'fx-warn', '.hf-warn')) throw new Error('大厅警示文案出现时没有加 fx-warn');
  if (!hasAdded(a2, 'fx-warn', '.lobby-broke')) throw new Error('金币不足提示出现时没有加 fx-warn');
  // 首页 HUD：金币变了
  api.__go('home');
  const p2 = api.__profile();
  p2.gold += 137;
  const a3 = withFxProbe(() => { api.refresh(); });
  p2.gold -= 137;
  if (!hasAdded(a3, 'fx-num', '.hud-gold')) throw new Error('金币变了却没有给 .hud-gold 加 fx-num');
});

check('回放控制条：播放 ↔ 暂停翻转时给 .rp-btn-play 加 fx-rp', () => {
  api.__newGame();
  const r = api.__autoPlay();
  if (r && r.error) throw new Error('整局跑完失败：' + r.error);
  if (!api.__replays().length) throw new Error('整局跑完没有留下回放，这条检查没法做');
  const demo = api.__replayDemo(0, 5);
  if (demo.error) throw new Error('打开回放失败：' + demo.error);
  const a = withFxProbe(() => { api.__nav('replay-toggle'); });
  if (!hasAdded(a, 'fx-rp', '.rp-btn-play')) throw new Error('播放 / 暂停翻转没有加 fx-rp');
});

check('纪律：这些 fx-* 类一个都不许出现在渲染出来的 HTML 里', () => {
  // fx-pop / fx-dead 这些只能由 JS 在活节点上加：写进 HTML 就会每次重绘重放。
  // （fx-hit / fx-lunge / fx-float 是作者另一套战斗特效，确实写在 HTML 里，不在此列。）
  const bad = /fx-(pop|row|num|warn|rp|dead|draw|spend|phase)(?![-\w])/;
  api.__go('home');
  let m = (stageHTML() || '').match(bad);
  if (m) throw new Error('home 屏渲染出的 HTML 里出现了 ' + m[0]);
  api.__newGame();
  m = (stageHTML() || '').match(bad);
  if (m) throw new Error('对局屏渲染出的 HTML 里出现了 ' + m[0]);
});
