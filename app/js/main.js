/**
 * 入口：启动（读存档、套主题、进首页）、DOM 事件绑定、以及调试 / 自动化测试钩子。
 *
 * 界面代码已按职责拆成几个模块：
 *   app-state.js  共享可变状态（screen/state/view/session/... 与 me()/foe()/foeName()）
 *   render.js     屏幕路由与渲染（makeView / refresh / showBanner / 战报菜单）
 *   game-flow.js  建局、引擎操作通道、回合驱动、结算与录制
 *   play-input.js 手牌选中 / 目标分析 / 出牌 / 点击处理 / data-act 路由
 *   lan.js        局域网大厅、开房扫描、房间内开局与退出
 *   replay-ui.js  回放档案增删改与回放播放器
 *
 * ⚠ 共享状态一律**读写裸名字**（`screen` / `state` / `view` / `profile` …）：
 *   它们是 app-state.js 的模块级声明，打包器把各模块拍进同一个作用域后谁都看得见。
 *   注意求值顺序由 import 图推出、**不按文件编号**，而 app-state.js 自己就排在
 *   很靠后（它 import 的模块太多）；所以任何模块的顶层代码都不要去读别的模块
 *   还没求值的状态，否则撞 TDZ 会直接抛 ReferenceError。
 * ⚠ 这些 import 必须都是**具名**的：打包器不认纯副作用 import（`import './x.js'`），
 *   那样写的模块根本不会被打进 bundle。
 *
 * 屏幕划分（由 `screen` 决定，全部渲染进 #stage）：
 *   home      首页（金币/等级 HUD + 开始游戏 / 回放对局 / 设置）
 *   game      对局
 *   settings  设置
 *   replays   回放列表
 *   replay    回放播放中（复用 game 的棋盘渲染）
 *
 * #menu 是对局中的战报浮层，独立于 #stage，不受重绘影响。
 */

import { AI, me, foe } from './app-state.js';
import {
  makeView, applyTheme, setTheme, goHome, goSettings, goReplays,
  refresh, toggleMenu, revealBoardAll, resetCardFlights,
  beginDragChip, moveDragChip, endDragChip, flyDragChipBack,
} from './render.js';
import {
  startNewGame, applyLocalAction, advanceGame, tick, settleIfNeeded,
} from './game-flow.js';
import {
  clearSelection, selectCard, resolvePlayerChoice,
  handleSlotClick, handleUnitClick, handleKingClick, handleAction,
  canDragCard, beginCardDrag, updateCardDrag, endCardDrag, abortCardDrag, applyDragHit,
} from './play-input.js';
import { enterLobby, beginLanMatch } from './lan.js';
import {
  updateReplay, deleteReplay, openReplay, stopReplay, seekReplayTo,
} from './replay-ui.js';

import * as G from '../../engine/src/engine.js';
import { TEST_CARD_LIB, buildTestDeck } from '../../engine/cards/test-cards.js';
import { aiTakeTurn, DIFFICULTIES, difficultyByKey, applyDifficultyBonus, applyBonusObject } from './ai.js';
import * as Store from './store.js';
import * as Eco from './economy.js';
import * as RP from './replay.js';
import * as Net from './multiplayer.js';
import * as Cloud from './cloud.js';

// ══════════════════════════════════════════════════════════
// 启动：读存档、套主题、进首页
// ══════════════════════════════════════════════════════════

function boot() {
  settings = Store.loadSettings();
  difficulty = difficultyByKey(settings.difficulty).key;

  const saved = Store.loadProfile();
  if (saved) {
    profile = saved;
  } else {
    // 第一次进游戏：发初始金币与初始星尘，但**不计入表现分**（不然白送一级）
    profile = { ...Store.defaultProfile(), gold: Eco.INITIAL_GOLD, dust: Eco.INITIAL_DUST, perf: 0 };
    Store.saveProfile(profile);
  }

  replays = Store.loadReplays();
  applyTheme();
  // 界面状态在任何屏幕上都要有，不然首页点「扫描房间」之类的会碰到 null
  view = makeView();

  // 云存档：读登录态 + 注册「本地存档后自动上传」的钩子。
  // 放在联机分支**之前**：公网站点从 ?net=host 直接进大厅时，也要能继续同步；
  // 异步校验 token / 拉状态会通过 onChange 自己刷新，不阻塞启动。
  Cloud.init({
    onChange: () => {
      try {
        if (screen === 'home' || screen === 'account' || screen === 'admin') refresh();
      } catch { /* DOM 桩环境忽略 */ }
    },
  });

  // ── 联机模式：页面是从主机的 HTTP 服务加载的，URL 带 ?net=host|guest。
  //    这时直接进大厅，不走首页。
  const mode = Net.netMode();
  if (mode) {
    enterLobby(mode);
    return;
  }

  screen = 'home';
  refresh();
}

// 拖动结束那一拍会紧跟着一个 click，要吃掉它（见下面 click 监听开头）
let dragSwallowClick = false;

document.addEventListener('click', (ev) => {
  // 拖动结束时浏览器还会补一个 click：那颗 click 不能当成「点了这张牌」，
  // 否则刚放下的牌又会被重新选中，甚至误触格子再走一次放置。
  if (dragSwallowClick) {
    dragSwallowClick = false;
    ev.preventDefault();
    ev.stopPropagation();
    return;
  }
  const actEl = ev.target.closest('[data-act]');
  if (actEl) {
    handleAction(actEl.dataset.act, actEl);
    return;
  }
  // 回放中只允许操作控制条，不响应对局内的点击
  if (screen !== 'game') return;
  // 有挂起的交互请求时，棋盘一律不响应 —— 必须先把它答完
  // 例外：召唤落点（summonCell）本来就要玩家点棋盘上的格子（作者 2026-10-04）
  if (state && state.pending && state.pending.request.type !== 'summonCell') return;
  // 顺序要紧：国王在状态条里、单位在格子内部，必须先判断更内层的元素
  const kingEl = ev.target.closest('[data-king]');
  if (kingEl) {
    handleKingClick(Number(kingEl.dataset.king));
    return;
  }
  const unitEl = ev.target.closest('.unit');
  if (unitEl) {
    handleUnitClick(Number(unitEl.dataset.uid));
    return;
  }
  const slotEl = ev.target.closest('.slot');
  if (slotEl) {
    handleSlotClick(slotEl);
    return;
  }
  const cardEl = ev.target.closest('.card');
  if (cardEl) {
    selectCard(Number(cardEl.dataset.iid));
  }
});

// 阻止移动端双击缩放 / 长按选中
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => e.preventDefault());

// 账户页按回车直接登录：手机上多一步点按钮，体验会差一截
document.addEventListener('keydown', (ev) => {
  if (!ev || ev.key !== 'Enter') return;
  const id = ev.target && ev.target.id;
  if (id === 'cloud-user' || id === 'cloud-pass') {
    ev.preventDefault();
    handleAction('cloud-login', { dataset: {} });
  }
});

/* ══════════════════════════════════════════════════════════════════════
   长按拖动放置（作者 2026-10）

   手势：按住手牌里的单位牌约 0.3 秒 → 这张牌「起来」跟着手指走（可放区同时
   点亮，那是 selectCard 干的）→ 拖到某个高亮格子上松手就放下去；松在别处
   就从当前位置飞回手牌。

   为什么不用 HTML5 的 draggable：安卓 WebView 里那套要长按才出影子、
   而且拖到格子上的判定要靠 preventDefault 硬扛，手感很差。Pointer 事件
   覆盖触摸与鼠标，且能直接拿到视口坐标配合 elementFromPoint 找格子。

   和「点两次放置」的关系：两者并存。轻点（没等到长按就抬手）仍然走 click
   那条老路，所以 selectCard / handleSlotClick 的语义没有变。
   ══════════════════════════════════════════════════════════════════════ */
const DRAG_HOLD_MS = 320;   // 按住多久算「要拖了」
const DRAG_SLOP_PX = 10;    // 长按判定期间手指允许的抖动
let dragHoldTimer = null;
let dragOrigin = null;      // { iid, x, y, html }
let dragActive = false;     // 已经真的拖起来了（松手要吃掉随之而来的 click）
let dragMoved = false;

function clearDragHold() {
  if (dragHoldTimer !== null) { clearTimeout(dragHoldTimer); dragHoldTimer = null; }
  dragOrigin = null;
  dragActive = false;
  dragMoved = false;
}

function dragPointOf(ev) {
  const t = (ev && ev.touches && ev.touches[0]) || ev;
  return { x: t && t.clientX ? t.clientX : 0, y: t && t.clientY ? t.clientY : 0 };
}

document.addEventListener('pointerdown', (ev) => {
  if (screen !== 'game' || !state || !view) return;
  if (ev.button !== undefined && ev.button !== 0 && ev.pointerType === 'mouse') return;
  const cardEl = ev.target && ev.target.closest ? ev.target.closest('.hand .card[data-iid]') : null;
  if (!cardEl) return;
  const iid = Number(cardEl.dataset.iid);
  if (!canDragCard(iid)) return;

  const pt = dragPointOf(ev);
  // 克隆卡必须按**源卡的实测尺寸**画：以前只配了 .fx-drag-card 一个 class，
  // 里面那层 .card 写的是 width/height:100%，而绝对定位的父元素宽度是 auto ——
  // 百分比回退到包含块（整块 #fx-layer）解析，克隆卡就成了一条通屏宽的长条。
  let w = 0;
  let h = 0;
  try {
    const r = typeof cardEl.getBoundingClientRect === 'function' ? cardEl.getBoundingClientRect() : null;
    if (r && r.width) { w = Math.round(r.width); h = Math.round(r.height); }
  } catch (e) { /* 量不到就交给 render.js 的兜底尺寸 */ }
  dragOrigin = { iid, x: pt.x, y: pt.y, html: cardEl.innerHTML || '', w, h };
  dragActive = false;
  dragMoved = false;
  clearTimeout(dragHoldTimer);
  dragHoldTimer = setTimeout(() => {
    dragHoldTimer = null;
    if (!dragOrigin) return;
    if (!beginCardDrag(dragOrigin.iid)) { dragOrigin = null; return; }
    dragActive = true;
    beginDragChip(dragOrigin.html, dragOrigin.x, dragOrigin.y, dragOrigin.w, dragOrigin.h);
    refresh();
  }, DRAG_HOLD_MS);
});

document.addEventListener('pointermove', (ev) => {
  if (!dragOrigin) return;
  const pt = dragPointOf(ev);
  if (!dragActive) {
    // 长按还没成立就滑开了：当成普通点击（让手牌区自己横向滚动）
    const dx = pt.x - dragOrigin.x;
    const dy = pt.y - dragOrigin.y;
    if (dx * dx + dy * dy > DRAG_SLOP_PX * DRAG_SLOP_PX) clearDragHold();
    return;
  }
  dragMoved = true;
  if (ev.cancelable) ev.preventDefault();
  moveDragChip(pt.x, pt.y);
  updateCardDrag(pt.x, pt.y);
}, { passive: false });

function finishDrag(failed) {
  if (!dragOrigin) return;
  const iid = dragOrigin.iid;
  const wasActive = dragActive;
  const moved = dragMoved;
  clearDragHold();
  if (!wasActive) { endDragChip(); return; }
  /**
   * 被 pointercancel 打断（滚动抢手势 / 来电 / 切后台）：**不能当成放手放下去**。
   * 以前这里和 pointerup 走同一条路，只要取消那一刻手指正好压在高亮格子上，
   * 牌就被放了下去 —— 表现是「刚开始动，牌自己就落位了」（作者 2026-10 报的）。
   * 也不留「没放到格子上」的提示：玩家什么都没做错。
   */
  if (failed) {
    dragSwallowClick = false;   // 浏览器不会补 click，吞了反而吃掉玩家下一次点击
    abortCardDrag();
    flyDragChipBack(iid);
    return;
  }
  // 拖过一段距离才吞掉后面的 click；原地长按又原地松手仍然按「点一下」处理，
  // 这样「长按选中、再点格子」这条老手感不会丢。
  dragSwallowClick = moved;
  const res = endCardDrag();
  if (res && res.placed) endDragChip();
  // 失败一律飞回手牌：提示行写的就是「牌已飞回手牌」，不能只把克隆卡悄悄删掉。
  else flyDragChipBack(iid);
}

document.addEventListener('pointerup', () => finishDrag(false));
document.addEventListener('pointercancel', () => finishDrag(true));

// 回放进度条拖动（range 用 input 事件才跟手）
document.addEventListener('input', (ev) => {
  if (ev.target && ev.target.id === 'rp-seek') seekReplayTo(ev.target.value);
});

// 进游戏：读存档 → 套主题 → 首页
boot();

// ══════════════════════════════════════════════════════════
// 调试 / 自动化测试钩子
// ══════════════════════════════════════════════════════════

window.__game = () => state;
/** 建一局并跳到对局屏幕（构建门禁/自动化测试用）。**和真实开局一样是随机先手**。 */
window.__newGame = () => { startNewGame(); return state; };

/**
 * 自检用：建一局，并把**先手固定为 0 号**。
 *
 * 为什么需要单独一个钩子：真实开局的先手是随机的（`seed % 2`）。
 * 要「构造一个特定场面」的测试一旦碰上随机先后手，就会有一半概率踩到
 * 「这个阶段该谁行动」的判断上（例如往后手的位置上摆牌直接抛错）——
 * 表现为偶发失败，很难查。要求可复现的测试用这个；
 * 要测随机先手本身请用 __newGame（见 tools/checks/03-enter-game.mjs 的 AI 先手用例）。
 */
window.__newGameFirst = () => {
  startNewGame();
  state.firstPlayer = 0;
  if (state.phase === 'DEPLOY_SECOND') state.phase = 'DEPLOY_FIRST';
  refresh();
  return state;
};
window.__screen = () => screen;
/** 截图 / 自检用：清掉正在飞的卡，棋盘立刻显示真实单位 */
window.__clearFlights = () => {
  resetCardFlights();
  refresh();
  return true;
};
/** 截图 / 自检用：改我方费用，避免调试时手牌全不可出 */
window.__setMana = (m, cap) => {
  if (!state || !state.players) return null;
  const p = state.players[0];
  p.mana = Math.max(0, Number(m) || 0);
  p.manaCap = Math.max(1, Number(cap) || p.mana);
  refresh();
  return { mana: p.mana, cap: p.manaCap };
};
/** 截图 / 自检用：跳过开局铺开动画，直接把棋盘和手牌全部显示出来 */
window.__revealAll = () => {
  revealBoardAll();
  return view ? view.revealShown : null;
};
/** 云存档自检用：返回 Cloud.cloudStatus() 的只读快照 */
window.__cloud = () => Cloud.cloudStatus();
/** 云存档自检用：直接调公开 API（登录 / 同步 / 管理员），返回 Promise */
window.__cloudCall = (name, ...args) => {
  try {
    return typeof Cloud[name] === 'function' ? Cloud[name](...args) : null;
  } catch (e) {
    return Promise.reject(e);
  }
};
/** 直接切屏（截图 / 自检用） */
window.__go = (name) => {
  if (name === 'home') goHome();
  else if (name === 'account') { screen = 'account'; refresh(); }
  else if (name === 'admin') { screen = 'admin'; Cloud.loadAdminUsers(); refresh(); }
  else if (name === 'settings') goSettings();
  else if (name === 'replays') goReplays();
  else if (name === 'play' || name === 'difficulty' || name === 'lan' || name === 'lanScan' || name === 'lobby') {
    screen = name;
    if (name === 'lanScan') { lanRooms = []; lanScanning = false; }
    refresh();
  } else if (name === 'game') { if (!state) startNewGame(); else { screen = 'game'; refresh(); } }
  return screen;
};
/**
 * 自检用：走一次真实的 handleAction 路由。
 *
 * 点击委托（document click → closest('[data-act]')）最后调的就是 handleAction，
 * 所以这里测的是**同一张路由表** —— 「按钮点了没反应」这类 bug 全部住在这张表里，
 * 而只调 __go() 是测不到的（__go 直接改 screen，绕过路由）。
 */
window.__nav = (act, dataset) => {
  handleAction(act, { dataset: dataset || {} });
  return screen;
};

/**
 * 自检 / 截图用：无视费用与阶段，直接往棋盘上摆一只指定的牌。
 *
 * 存在的理由：集成测试与截图脚本要构造「某个特定场面」（例如「强化士兵 vs 一个
 * 打不死的挡路者 + 另一个线路的 1/1」），但它们是跑在打包产物上的，
 * 拿不到打包作用域里的 `G`（`const G = {...}` 不是 window 属性）。
 * 所以由界面自己开这个口子，而不是让测试去猜内部名字。
 */
window.__place = (side, cardId, lane, row) => {
  if (!state) startNewGame();
  const s = Number(side) === 1 ? 1 : 0;
  /*
   * ⚠ 必须**无条件**把阶段设成该方在「放置单位」阶段的对应阶段，不能「按需」设。
   *   踩过的坑：写成「actor 不等于这一方时才设」之后，在 TURN_START 这种自动阶段里
   *   getActor() 返回 null，判断「成立」，但当 firstPlayer === 1 时
   *   DEPLOY_SECOND 的行动方其实是 0 号 —— 于是 playCard 抛「应由后手行动」。
   *   而且先后手是随机的，所以它表现为**偶发**摆不上牌。
   */
  state.phase = (s === 0) === (state.firstPlayer === 0) ? 'DEPLOY_FIRST' : 'DEPLOY_SECOND';
  const p = state.players[s];
  p.manaCap = 99;
  p.mana = 99;
  const hc = { iid: state.nextIid++, cardId };
  p.hand.push(hc);
  G.playCard(state, s, hc.iid, { lane, row: row || 'front' });
  const u = state.board[lane].units[s][row || 'front'];
  return u ? { uid: u.uid, name: u.name, atk: u.atk, hp: u.hp } : null;
};

/** 自检 / 截图用：把阶段停在某个阶段（不改别的） */
window.__setPhase = (phase) => { if (state) state.phase = phase; return state ? state.phase : null; };

/**
 * 自检 / 截图用：推进一个阶段（走和对局完全相同的通道，会记回放、会刷新界面）。
 *
 * 和「点结束阶段按钮」的区别：按钮受行动权守卫保护（不是你的阶段就点不动），
 * 而这个钩子不管行动权 —— 测试与截图脚本需要把局面推到某个阶段（例如进开战），
 * 但不可能真的替对手点按钮，也不该为此把守卫拆掉。
 */
window.__advance = () => {
  if (!state) return null;
  clearTimeout(autoAdvanceTimer);
  view.busy = false;
  advanceGame();
  tick();
  return { phase: state.phase, pending: state.pending ? state.pending.request.type : null };
};

/**
 * 自检钩子：把「换屏幕 / 选牌 / 点格子 / 长按拖动」这几条真实入口露出来，
 * 好让门禁能在没有 DOM 的环境里走玩家那条路径（作者 2026-10 的两步放置）。
 */
window.__me = () => me();
window.__view = () => view;
window.__selectCard = (iid) => { selectCard(iid); return view.selectedIid; };
window.__slotClick = (lane, row) => {
  handleSlotClick({ dataset: { side: String(me()), lane, row } });
  return { pickedSlot: view.pickedSlot, hint: view.hint, selectedIid: view.selectedIid };
};
window.__canDrag = (iid) => canDragCard(iid);
window.__beginDrag = (iid) => beginCardDrag(iid);
window.__dragTo = (lane, row, side) => {
  // 门禁没有 elementFromPoint，直接喂真实的判定函数一个已知落点；
  // 是否合法、提示怎么写、要不要重绘，走的都是 updateCardDrag 那一套。
  applyDragHit({ side: side === undefined ? me() : Number(side), lane, row });
  return !!(view.dragOver && view.dragOver.lane === lane && view.dragOver.row === row);
};
window.__endDrag = () => endCardDrag();
window.__abortDrag = () => abortCardDrag();        // 模拟手势被系统取消（pointercancel）

/**
 * 自检用：丢掉内存里的对局，模拟「刚启动、还没打过任何一局」。
 *
 * 真实场景：玩家打开 App → 直接点「回放对局」→ 点回放。
 * 这时 state 是 null，但 localStorage 里有上次存的回放。
 */
window.__dropLiveGame = () => {
  clearTimeout(bannerTimer);
  clearTimeout(autoAdvanceTimer);
  stopReplay();
  state = null;
  view = makeView();
  recording = null;
  return true;
};

/**
 * 自检用：把**正在进行中这一局**的录制原样拿去重放，逐步比较状态指纹。
 *
 * 为什么需要它：`__replayVerify` 只能验**已经打完并存档**的回放，
 * 而那 30 局全是 AI 代打（`__autoPlay`）—— 「真人出牌需要点选目标/抉择」
 * 这条路根本没被走过。这个钩子让测试能在**走完真人路径之后立刻**验一次。
 */
window.__recordingActions = () => (recording ? recording.actions.map((a) => ({ ...a })) : null);

/**
 * 自检用：看战斗可视化的状态（当前特效 / 待播队列 / 日志游标）。
 * 为什么要专门开一个钩子：`view` 是 app-state.js 里的 `let` 声明，**不在沙箱对象上**，
 * 集成测试直接读 `api.view` 会取不到（踩过一次）。
 */
window.__fx = () => ({
  fx: view.fx || null,
  queue: (view.fxQueue || []).slice(),
  cursor: view.fxCursor,
  logLen: state && state.log ? state.log.length : 0,
});

/**
 * 自检用：记下「当前局面在第 N 步时的指纹」。
 *
 * 为什么必须有它：要判断回放忠不忠实，唯一站得住的判据是
 * **「同一位置 → 同一局面」** —— 也就是说，必须拿「实战走到第 N 步时的局面」
 * 与「回放走到第 N 步时的局面」比。只比两边**当前**的局面全是坑：
 * 界面上那一局早就走到第 58 步了，回放才走第 1 步，比一次报一次分叉。
 *
 * 用法（测试脚本里）：在真实对局的循环里每次**记录条数发生变化**时调一次，
 * 它会把当前局面按「第几条记录」存进 `__liveDigests`。存满之后交给
 * `__replayVerifyLive(digests)` 逐步对拍。
 */
window.__liveDigests = [];window.__snapLive = () => {
  if (!state || !recording) return -1;
  const n = recording.actions.length;
  window.__liveDigests[n] = RP.replayDigest(state);
  return n;
};
/**
 * 按「第几条记录」存指纹（`recAction` 在记账那一刻回头调它）。
 *
 * 为什么不能让外部按「记录条数变了没有」自己观察着存：`tick()` 里一次循环
 * 可能连着推进好几个阶段（AI 那侧尤其如此），等外部观察到时局面已经走到
 * 好几步之后了，存下来的位置全是错的。所以位置必须由**记账那一刻**决定。
 */
window.__snapLiveAt = (n) => {
  if (!state || !recording) return -1;
  window.__liveDigests[n] = RP.replayDigest(state);
  window.__liveBriefs[n] = window.__stateBrief(state);
  return n;
};
window.__liveBriefs = [];

/**
 * 自检用：把某个引擎状态压成一份**便于对拍**的简报（不是指纹，是给人读的）。
 *
 * 与 `RP.replayDigest` 的分工：指纹只回答「一样不一样」，简报回答「差在哪」。
 * 对数时两边各来一份，直接 diff 就能看出是少抽了一张、还是 rng 走岔了。
 */
window.__stateBrief = (s) => {
  if (!s) return '';
  const hand = (p) => p.hand.map((c) => `${c.iid}=${c.cardId}`).join(',');
  const board = ['mountain', 'plainL', 'plainR', 'water']
    .map((l) => `${l}:${s.board[l].units[0].front ? s.board[l].units[0].front.cardId : '-'}/${s.board[l].units[0].back ? s.board[l].units[0].back.cardId : '-'}|${s.board[l].units[1].front ? s.board[l].units[1].front.cardId : '-'}/${s.board[l].units[1].back ? s.board[l].units[1].back.cardId : '-'}`)
    .join(' ');
  return [
    `turn=${s.turn} phase=${s.phase} nextIid=${s.nextIid} rng=${s.rng && s.rng.state} cards=${s.stats && s.stats.cardsPlayed} pend=${s.pending ? s.pending.request.type : '-'}`,
    ...s.players.map((p, i) => `p${i} king=${p.kingHp} mana=${p.mana} deck=${p.deck ? p.deck.length : '-'} hand=[${hand(p)}] grave=${(p.discard || []).length}`),
    `board ${board}`,
  ].join('\n');
};

/**
 * 自检用：拿「同一位置  同一局面」的判据，逐步对拍一条录制。
 *
 * @param liveDigests     实战留下的指纹（由 __snapLive 采）
 * @param recordOverride  可选：**指定的回放记录**。传它就是为了验「存档里那条」
 *    存档经过 finishRecording 打包 + JSON 序列化（漏字段就播不对），
 *   与内存里那份 recording 不是一回事：不传就退化成原来的行为。
 *
 *  判据必须比「同一位置」而不是「两边当前」；顺序是先 next() 再比。这两条都踩过。
 */
window.__replayVerifyLive = (liveDigests, recordOverride) => {
  const src = recordOverride || recording;
  if (!src) return { error: '没有正在录制的对局，也没给回放记录' };
  const actions = src.actions;
  if (!actions.length) return { error: '还没录到任何操作' };
  const snaps = liveDigests || window.__liveDigests || [];
  if (!snaps[actions.length]) {
    return { error: '没有实战指纹（请在每一步操作后调 __snapLive()）' };
  }

  /** 从内存里那份 recording 重建一条等价的回放记录（给不传 recordOverride 的场合用） */
  const recOf = (acts) => ({
    ...RP.newRecording({
      seed: recording.seed, firstPlayer: recording.firstPlayer, deck: recording.deck,
      cardSet: recording.cardSet, bonuses: recording.bonuses, humanSide: recording.humanSide, factions: recording.factions,
      opening: recording.opening,
    }),
    choiceLog: (recording.choiceLog || []).map((e) => ({ ...e })),
    actions: acts.map((a) => ({ ...a })),
  });

  // 给了 recordOverride 就直接用它（那是「存档里那条」）；否则从内存那份重建一条等价的
  const player = RP.createReplayPlayer(recordOverride || recOf(actions), TEST_CARD_LIB);
  const trace = [];
  let divergedAt = 0;
  for (let i = 0; i < actions.length; i++) {
    player.next();
    const live = snaps[i + 1];
    const replay = player.digest();
    if (player.error) {
      trace.push({ step: i + 1, k: actions[i].k, action: actions[i], error: player.error });
      divergedAt = i + 1;
      break;
    }
    if (live !== undefined && live !== replay) {
      const la = live.split('|');
      const ra = replay.split('|');
      const diff = [];
      for (let k = 0; k < Math.max(la.length, ra.length); k++) {
        if (la[k] !== ra[k]) diff.push(`live=${la[k]} 回放=${ra[k]}`);
      }
      trace.push({
        step: i + 1, k: actions[i].k, action: actions[i], diff,
        hand: player.state.players[0].hand.map((c) => `${c.iid}:${c.cardId}`),
        mana: player.state.players[0].mana, phase: player.state.phase,
      });
      divergedAt = i + 1;
      break;
    }
  }
  return {
    total: actions.length,
    played: player.index,
    divergedAt,
    error: player.error,
    trace,
    qTrace: (player.state && Array.isArray(player.state.qTrace)) ? player.state.qTrace.slice() : [],
    ok: !player.error && divergedAt === 0 && player.index >= actions.length,
  };
};

/** 自检用：点一个场上单位（手牌没选任何牌 → 应打开详情面板） */
window.__tapUnit = (uid) => {
  view.selectedIid = null;
  handleUnitClick(uid);
  const html = document.getElementById('stage').innerHTML;
  return { infoUid: view.infoUid, hasPanel: html.includes('unit-info'), html };
};

/** 存档快照（自检用） */
window.__profile = () => profile;
window.__replays = () => replays;
window.__setTheme = (t) => { setTheme(t); return settings.theme; };
window.__theme = () => {
  try { return document.documentElement.dataset.theme; } catch { return null; }
};
window.__settings = () => settings;

/**
 * 自检用：把第 i 条回放**从头跑到尾**，返回复现出来的终局。
 * 这是验证「回放确实能精确重放」的关键 —— 重放的 winner / turns
 * 必须和录下来的完全一致，否则说明引擎有非确定性来源。
 */
window.__replayVerify = (i = 0) => {
  const rec = replays[i];
  if (!rec) return { error: '没有这条回放' };
  if (!RP.isCompatible(rec, TEST_CARD_LIB)) {
    return { error: RP.incompatibleReason(rec, TEST_CARD_LIB), incompatible: true };
  }
  const player = RP.createReplayPlayer(rec, TEST_CARD_LIB);
  player.toEnd();
  return {
    winner: player.state.winner,
    turn: player.state.turn,
    expectWinner: rec.winner,
    expectTurn: rec.turns,
    steps: player.total,
    played: player.index,
    error: player.error,
    ok: player.state.winner === rec.winner && player.state.turn === rec.turns,
  };
};

/** 自检用：打开第 i 条回放并步进若干步（顺带验证回放界面能渲染） */window.__replayDemo = (i = 0, steps = 20) => {
  const rec = replays[i];
  if (!rec) return { error: '没有这条回放' };
  openReplay(rec.id);
  if (!replayCtx) return { error: '打开失败' };
  for (let k = 0; k < steps; k++) if (!replayCtx.player.next()) break;
  refresh();
  return {
    screen,
    index: replayCtx.player.index,
    total: replayCtx.player.total,
    htmlLength: document.getElementById('stage').innerHTML.length,
  };
};

/** 自检用：改备注 / 删回放（不经过 DOM 输入框） */
window.__replayNote = (i, note) => {
  const rec = replays[i];
  if (!rec) return null;
  updateReplay(rec.id, { note: String(note).slice(0, 40) });
  refresh();
  return replays.find((r) => r.id === rec.id) || null;
};
window.__replayDelete = (i) => {
  const rec = replays[i];
  if (!rec) return -1;
  deleteReplay(rec.id);
  refresh();
  return replays.length;
};

// ══════════════════════════════════════════════════════════
// 联机 / 难度 的自检钩子
// ══════════════════════════════════════════════════════════

window.__mp = {
  stateHash: Net.stateHash,
  stateSignature: Net.stateSignature,

  /**
   * 锁步一致性检查 —— **整个联机设计成立的前提**。
   *
   * 用同一串操作喂两个独立引擎（同种子、同牌库），每一步都比较状态指纹。
   * 只要始终一致，就说明「只同步操作、不同步棋盘」是可行的。
   *
   * ⚠ 两个引擎都用 `RP.createReplayPlayer` 重建 —— 和 `replay.js` 的正规回放
   *   走**同一段建局代码**，两条路永远不会再分叉。
   *
   *   以前这里自己写了一份「建局」（只有 `createGame` + `startGame`）：不传
   *   `opening`（开局发牌前一刻的牌库与 rng），也不喂 `choiceLog` 裁定流。
   *   于是重建出来的那一局和录的那一局**抽牌顺序不同**，录下来的操作指向的手牌
   *   实例在重建的那一局里根本不存在，报
   *   `第 N 步开始不一致（共 N 步）  错误：手牌中没有 iid=xx`。
   *
   *   为什么是**偶发**：`08-mp-lockstep.mjs` 喂的是本次进程里随机播出来的那一局
   *   （`game-flow.js` 的 `seed = (Date.now() ^ Math.random()*0xffffffff) >>> 0`），
   *   只有那一局真正用到「开局对齐 / 裁定流」时才会暴露 —— 实测 40 局里错 3 局。
   *
   * 签名保持向后兼容：第 7 个参数 `record` 可选。传完整录制
   * （`api.__replays()[0]`）时按它逐字段重建；不传时退回旧口径
   * （照种子自己洗牌、两侧都不是真人），旧的调用方式照样能跑。
   */
  lockstepCheck: (seed, firstPlayer, deck, actions, bonuses = [], factions = [], record = null) => {
    const makeRec = () => ({
      v: RP.REPLAY_VERSION,
      seed,
      firstPlayer,
      deck: (deck || []).slice(),
      // `shuffled` / `opening` / `choiceLog` 一个都不能少：少了 `opening` 就是
      // 「照种子自己洗牌自己发牌」而手里那份牌库是已经洗过的那一份；
      // 少了 `choiceLog` 则是每一问都落回引擎策略、与录制那局的裁定错位。
      shuffled: record ? !!record.shuffled : false,
      opening: record ? record.opening : null,
      humanSide: record && record.humanSide !== undefined ? record.humanSide : -1,
      factions: (factions || []).slice(),
      bonuses: (bonuses || []).map((b) => ({ ...b })),
      // 强化增量和 bonuses 一样是**建局参数**：少了它，重建的那一局单位攻/血
      // 与锦囊费用都回到卡面原值，战斗结果就从某一步起错位
      // （表现为「手牌中没有 iid=xx」这类看起来毫不相干的报错）。
      enhance: record && Array.isArray(record.enhance) ? record.enhance.map((side) => ({ ...(side || {}) })) : null,
      choiceLog: record && Array.isArray(record.choiceLog) ? record.choiceLog : [],
      actions,
    });
    const a = RP.createReplayPlayer(makeRec(), TEST_CARD_LIB);
    const b = RP.createReplayPlayer(makeRec(), TEST_CARD_LIB);

    let divergedAt = -1;
    let error = '';
    for (let i = 0; i < actions.length; i++) {
      const ra = a.next();
      const rb = b.next();
      if (a.error || b.error) { error = a.error || b.error; divergedAt = i + 1; break; }
      if (!ra || !rb) break;
      if (Net.stateSignature(a.state) !== Net.stateSignature(b.state)) { divergedAt = i + 1; break; }
    }
    return {
      ok: divergedAt < 0,
      steps: actions.length,
      divergedAt,
      error,
      hashA: Net.stateHash(a.state),
      hashB: Net.stateHash(b.state),
      winnerA: a.state.winner,
      winnerB: b.state.winner,
    };
  },
};

/**
 * 让两个难度互相对打 n 局，返回战绩。
 * 用来验证「难度确实是递增的」—— 如果困难打不过普通，那这张参数表就是坏的。
 */
window.__aiLeague = (diff0, diff1, n = 60, params0 = null, params1 = null, seedBase = 1) => {
  const tally = { p0: 0, p1: 0, draw: 0 };
  for (let seed = seedBase; seed < seedBase + n; seed++) {
    const deck = buildTestDeck(80, seed);
    const st = G.createGame({ seed, firstPlayer: seed % 2, deck, cardLib: TEST_CARD_LIB });
    G.startGame(st);
    st.autoResolveChoices = true;
    /**
     *  必须声明「没有真人」：不设的话 humanSide 默认 0，强化士兵（U396）开战时
     * 那条 noAuto 的 combatTarget 请求就**没人能答**，整条跑批会抛
     * 「存在待处理的交互请求，无法推进」难度门禁会永远报同一条警告。
     * （tools/balance-check.mjs 早就这么做了，这里以前漏了。）
     */
    st.humanSide = -1;
    applyDifficultyBonus(st, 0, diff0);
    applyDifficultyBonus(st, 1, diff1);

    let guard = 0;
    while (st.winner === null && guard++ < 3000) {
      const actor = G.getActor(st);
      if (actor === null) { try { G.advance(st); } catch { break; } continue; }
      const key = actor === 0 ? diff0 : diff1;
      const over = actor === 0 ? params0 : params1;
      try { aiTakeTurn(st, actor, over ? { difficulty: key, params: over } : { difficulty: key }); } catch { break; }
      if (st.winner === null) { try { G.advance(st); } catch { break; } }
    }
    if (st.winner === 0) tally.p0++;
    else if (st.winner === 1) tally.p1++;
    else tally.draw++;
  }
  return tally;
};

/** 难度表（界面与测试共用） */
window.__difficulties = () => DIFFICULTIES.map((d) => d.key);

/** 自检用：应用难度增益并返回结果 */
window.__applyBonus = (st, side, key) => {
  applyDifficultyBonus(st, side, key);
  return {
    hand: st.players[side].hand.length,
    hp: st.players[side].kingHp,
    manaCap: st.players[side].manaCap,
    // 固定费用加成也要露出来：它才是「每回合都多几点」的来源，
    // 而 manaCap 只在当回合体现，光看 manaCap 会漏掉它。
    flatManaBonus: st.players[side].flatManaBonus || 0,
    mana: st.players[side].mana,
  };
};

/**
 * 自检钩子：造一个「效果打到一半反问玩家」的现场（卡牌「歼-10」的抉择）。
 * 把歼-10 塞进手牌 → 以 autoResolveChoices=false 打出 → 引擎应当挂起。
 */
window.__demoChoice = () => {
  // 自检钩子，每次都要一个干净局面（上一局的前排可能已经被占了）
  startNewGame();
  screen = 'game';
  paused = true;
  clearTimeout(bannerTimer);
  clearTimeout(autoAdvanceTimer);
  state.phase = me() === state.firstPlayer ? 'DEPLOY_FIRST' : 'DEPLOY_SECOND';
  const p = state.players[me()];
  p.manaCap = 20;
  p.mana = 20;
  const hc = { iid: state.nextIid++, cardId: 'U393' };
  p.hand.push(hc);
  state.autoResolveChoices = false;
  try {
    G.playCard(state, me(), hc.iid, { lane: 'mountain', row: 'front' });
  } catch (err) {
    state.autoResolveChoices = true;
    return { error: err.message };
  }
  const rq = state.pending ? state.pending.request : null;
  const info = {
    pending: !!state.pending,
    prompt: rq ? rq.prompt : null,
    options: rq ? rq.options.map((o) => o.label) : [],
  };
  refresh();
  info.html = document.getElementById('stage').innerHTML;
  info.hasMask = info.html.includes('choice-mask');
  if (!state.pending) state.autoResolveChoices = true;
  return info;
};

/** 自检钩子：打开战报菜单，把渲染出来的 HTML 交出去（门禁断言用） */
window.__menuLog = (open = true) => {
  toggleMenu(!!open);
  const el = document.getElementById('menu');
  return { hidden: el ? el.classList.contains('hidden') : null, html: el ? el.innerHTML : '' };
};

/** 自检钩子：替玩家点第 idx 个选项 */
window.__resolveChoice = (idx) => {
  resolvePlayerChoice(idx);
  const u = state && state.board.mountain.units[me()].front;
  return {
    pending: !!(state && state.pending),
    atk: u ? u.atk : null,
    hp: u ? u.hp : null,
    mana: state ? state.players[me()].mana : null,
    auto: state ? state.autoResolveChoices : null,
  };
};

/**
 * 自检钩子：在**真实的界面路径**上打出一张「融合进化」牌，验证能打到队友身上。
 * 走的是 selectCard + handleUnitClick，也就是玩家实际点的那两下。
 */
window.__demoFuse = () => {
  startNewGame();
  screen = 'game';
  paused = true;
  view.busy = false;
  clearTimeout(bannerTimer);
  clearTimeout(autoAdvanceTimer);
  state.players[0].manaCap = 20; state.players[0].mana = 20;
  state.players[1].manaCap = 20; state.players[1].mana = 20;
  state.phase = me() === state.firstPlayer ? 'DEPLOY_FIRST' : 'DEPLOY_SECOND';
  const p = state.players[me()];

  // 1) 先在场上放一个队友
  const mate = { iid: state.nextIid++, cardId: 'W01' };
  p.hand.push(mate);
  G.playCard(state, me(), mate.iid, { lane: 'mountain', row: 'front' });
  const before = state.board.mountain.units[me()].front;
  if (!before) return { error: '队友没放上去' };

  // 2) 手上给一张带融合进化的牌，选中它
  const fuserId = Object.values(TEST_CARD_LIB).find((c) => (c.keywords || []).includes('fuse')).id;
  const hc = { iid: state.nextIid++, cardId: fuserId };
  p.hand.push(hc);
  state.phase = me() === state.firstPlayer ? 'DEPLOY_FIRST' : 'DEPLOY_SECOND';
  p.manaCap = 20;
  p.mana = 20;
  selectCard(hc.iid);
  const legal = view.legalSlots.map((s) => `${s.lane}-${s.row}`);
  // 场上队友所在格是否被算成合法落点（界面高亮就是看这个）
  const highlighted = legal.includes(`${before.lane}-${before.row}`);

  // 3) 点那个队友（玩家实际会点的地方）
  handleUnitClick(before.uid);
  const after = state.board.mountain.units[me()].front;

  return {
    legalSlots: legal,
    highlighted,
    beforeName: before.name,
    afterName: after ? after.name : null,
    fused: !!after && after.uid !== before.uid,
    error: view.hint || '',
  };
};

/** 自检钩子：在真实界面路径上打出一张「打出:需要指定目标」的单位 */
window.__demoUnitTarget = () => {
  startNewGame();
  screen = 'game';
  paused = true;
  view.busy = false;
  clearTimeout(bannerTimer);
  clearTimeout(autoAdvanceTimer);
  state.players[0].manaCap = 20; state.players[0].mana = 20;
  state.players[1].manaCap = 20; state.players[1].mana = 20;
  state.phase = me() === state.firstPlayer ? 'DEPLOY_FIRST' : 'DEPLOY_SECOND';
  const p = state.players[me()];

  // 先给对面放一个单位当目标
  const foeP = state.players[1 - me()];
  const foeCard = { iid: state.nextIid++, cardId: 'W03' };
  foeP.hand.push(foeCard);
  const savedPhase = state.phase;
  state.phase = me() === state.firstPlayer ? 'DEPLOY_SECOND' : 'DEPLOY_FIRST';
  G.playCard(state, 1 - me(), foeCard.iid, { lane: 'plainL', row: 'front' });
  state.phase = savedPhase;

  // 手上给魔术师，走真实的「选牌 → 点格子」
  const hc = { iid: state.nextIid++, cardId: 'U208' };
  p.hand.push(hc);
  selectCard(hc.iid);
  const slots = view.legalSlots.map((s) => `${s.lane}-${s.row}`);
  const slotEl = { dataset: { side: String(me()), lane: slots[0].split('-')[0], row: slots[0].split('-')[1] } };
  /**
   * 两步放置（作者 2026-10）：第一下只是选中落点，第二下才真的打出去。
   * 这个钩子要的是「一次调用就打出这张牌」，所以照玩家会做的那样点两次，
   * 中间的 pickedSlot 也算一次断言素材（门禁能看出两步确实生效了）。
   */
  handleSlotClick(slotEl);
  const picked = view.pickedSlot ? `${view.pickedSlot.lane}-${view.pickedSlot.row}` : null;
  handleSlotClick(slotEl);

  const rq = state.pending ? state.pending.request : null;
  const info = {
    slots,
    picked,
    pending: !!state.pending,
    type: rq ? rq.type : null,
    options: rq ? rq.options.map((o) => o.label) : [],
  };
  refresh();
  info.hasMask = document.getElementById('stage').innerHTML.includes('choice-mask');
  return info;
};

/**
 * 自检钩子：伪造一个联机会话，渲染大厅，看主机「开始对战」按钮到底能不能点。
 * 这个 bug 的表现就是「能进房间，但开不了局」——按钮一直是灰的。
 */
window.__demoLobby = (peerName) => {
  const real = session;
  session = {
    isHost: true,
    peerName: peerName === undefined ? '张三' : peerName,
    started: false,
    state: null,
    stop() {},
  };
  lanInfo = {
    roomName: '测试房间', port: 8765, peerName: '', status: 'connected',
    gameReady: false, localIp: '192.168.1.7',
  };
  screen = 'lobby';
  refresh();
  const html = document.getElementById('stage').innerHTML;
  const r = {
    html,
    // 按钮是否被 disabled（灰掉就点不动 = 开不了局）
    startDisabled: /data-act="lan-start"[^>]*\bdisabled\b/.test(html),
    showsPeer: html.includes('已连接'),
    // 大厅里能不能选阵营（以前只有难度页有；联机时客人只能被主机安排）
    factionRows: (html.match(/data-act="set-faction"/g) || []).length,
  };
  session = real;
  return r;
};

/**
 * 自检钩子：伪造一个联机会话（不联网），造出「对手 / 自己打出的牌要选效果」的现场，
 * 用来验证「提问归谁答」的界面分流（单机路径有 __demoChoice，联机路径用它）。
 *
 *   opts.mySide : 我这一侧（0 = 主机 / 1 = 客人，默认 0）
 *   opts.owner  : 这张牌归谁打（'me' | 'foe'，默认 'foe'）
 */
/** 联机开局自检用：保存/恢复真实会话 */
let __lanDemoSaved = null;

/**
 * 自检钩子：走**真实的联机开局路径**（lan.js 的 beginLanMatch），
 * 并故意留下「上一局中途退出」的现场（autoAdvancing = true）。
 *
 * 钉的是作者 2026-10 报的「联机开始后无法出牌」：联机开局以前只调 tick()，
 * 不像单机 newGame() 那样复位回合循环。残留的 autoAdvancing=true 会让
 * tick() 在防重入那一行直接返回 —— 阶段永远停在 TURN_START、
 * busy 恒为 true、点牌毫无反应。开局自己复位是本钩子要守住的契约。
 */
window.__demoLanStart = (opts = {}) => {
  __lanDemoSaved = { session, screen };
  const mySide = opts.mySide === 1 ? 1 : 0;
  if (opts.myName !== undefined) lanInfo = { ...(lanInfo || {}), myName: String(opts.myName || '') };
  session = {
    isHost: mySide === 0, mySide, started: true, step: 0, lastError: '',
    peerName: opts.peerName === undefined ? '对手' : String(opts.peerName),
    // 真 Session 会本地应用 + 广播；这里只要本地那一半
    submit(a) { applyLocalAction(a); this.step++; return true; },
  };
  if (opts.leak !== false) autoAdvancing = true;   // 上一局没退干净
  paused = false;                                  // 真实开局时界面不是暂停态
  const seed = opts.seed === undefined ? 2024 : opts.seed;
  const deck = buildTestDeck(80, seed);
  recordingSeed = seed;
  recordingDeck = deck;
  recordingFactions = ['demon', 'demon'];
  recordingEnhance = null;
  const st = G.createGame({ seed, firstPlayer: 0, deck, cardLib: TEST_CARD_LIB, factions: ['demon', 'demon'], enhance: null });
  G.startGame(st);
  // 与 multiplayer.js 的 applyStart 一致：联机没有 AI 代答
  st.autoResolveChoices = false;
  beginLanMatch(st);
  return { phase: state.phase, actor: G.getActor(state), busy: view.busy, screen };
};

/** 收尾：恢复真实会话并回到一局干净的单机对局 */
window.__demoLanEnd = () => {
  session = __lanDemoSaved ? __lanDemoSaved.session : null;
  __lanDemoSaved = null;
  startNewGame();
  refresh();
};

window.__demoLanChoice = (opts = {}) => {
  const mySide = opts.mySide === undefined ? 0 : opts.mySide;
  const owner = opts.owner === undefined ? 'foe' : opts.owner;
  const real = session;
  const sent = [];
  // 假会话：只把交上来的操作记下来（真 Session 才会本地应用 + 广播）
  session = {
    isHost: mySide === 0,
    mySide,
    step: 0,
    lastError: '',
    peerName: '对手',
    started: true,
    submit: (a) => { sent.push(a); return true; },
  };
  startNewGame();
  screen = 'game';
  paused = true;
  clearTimeout(bannerTimer);
  clearTimeout(autoAdvanceTimer);
  const side = owner === 'me' ? mySide : 1 - mySide;
  // 摆到「出这张牌的那一侧」的行动阶段：DEPLOY_FIRST = 先手的放置阶段
  state.phase = side === state.firstPlayer ? 'DEPLOY_FIRST' : 'DEPLOY_SECOND';
  const p = state.players[side];
  p.manaCap = 20;
  p.mana = 20;
  const hc = { iid: state.nextIid++, cardId: 'U393' }; // 歼-10：打出后要「抉择」
  p.hand.push(hc);
  state.autoResolveChoices = false;
  let error = null;
  try {
    G.playCard(state, side, hc.iid, { lane: 'mountain', row: 'front' });
  } catch (err) {
    error = err.message;
  }
  const rq = state.pending ? state.pending.request : null;
  refresh();
  const html = document.getElementById('stage').innerHTML;
  const out = {
    error,
    owner,
    mySide,
    requestSide: rq ? rq.side : null,
    pending: !!state.pending,
    clickable: html.includes('data-act="choose-option"'),
    waiting: html.includes('等待对手选择'),
  };
  if (state.pending) resolvePlayerChoice(0); // 本地点一下，看它敢不敢替对手作答
  out.sentAfterClick = sent.map((a) => ({ ...a }));
  out.pendingAfterClick = !!state.pending;
  state.autoResolveChoices = true;
  session = real;
  startNewGame();
  refresh();
  return out;
};

window.__demoKingTarget = () => {
  // 已经分出胜负的局里 selectCard 会直接 return（对局结束就不该再操作了），
  // 于是这个钩子会返回空的 kingTargets —— 截图/自检要的是一个能操作的活局，
  // 所以残局时重开一局。这也是它以前偶发失败的原因（随机种子下 AI 有时 4 回合就打穿国王）。
  if (!state || state.winner !== null) startNewGame();
  screen = 'game';
  paused = true;
  clearTimeout(bannerTimer);
  clearTimeout(autoAdvanceTimer);

  state.phase = me() === state.firstPlayer ? 'SPELL_FIRST' : 'SPELL_SECOND';
  state.players[me()].manaCap = 9;
  state.players[me()].mana = 9;

  const hc = { iid: state.nextIid++, cardId: 'U01' }; // U01 = 攻击（可指定国王）
  state.players[me()].hand.push(hc);
  view.busy = false;
  view.busyText = '';

  selectCard(hc.iid);
  return {
    selected: state.cardLib[hc.cardId].name,
    kingTargets: view.legalKingTargets,
    unitTargets: view.legalUnitTargets.length,
    hint: view.hint,
  };
};

/** 暂停 / 恢复自动回合循环（预览、截图、自检用）。不传参数 = 暂停。 */
window.__pause = (on = true) => {
  paused = !!on;
  clearTimeout(bannerTimer);
  clearTimeout(autoAdvanceTimer);
  view.busy = false;
  view.busyText = '';
  refresh();
  return paused;
};

/**
 * 自检钩子：卡牌飞行的意图记录（门禁用）。
 * 每次该飞的卡都记一笔：{ kind, side, cardId, iid, lane, row, from, animated }。
 * kind: 'draw' 是新抽到的手牌（从屏幕下方划入），'play' 是打出的牌
 *       （我方从卡槽滑向落子格、对手从屏幕上方滑入）。
 * 门禁的 DOM 桩没有 createElement / animate，所以那里 animated 恒为 false 
 * 这正说明「少了浏览器能力时只记意图、不碰 DOM」，真机上才真的有动画。
 */
window.__cardFlights = () => cardFlightLog();

/** 累计记过多少笔飞行（环形缓冲会截断，数增量用这个） */
window.__cardFlightSeq = () => cardFlightSeq();

window.__demoHand = (ids) => {
  if (!state) startNewGame();
  screen = 'game';
  paused = true;
  clearTimeout(bannerTimer);
  clearTimeout(autoAdvanceTimer);

  const list = (ids && ids.length)
    ? ids
    : ['U05', 'U07', 'U10', 'U12', 'U15', 'U16', 'U06', 'U09', 'U14'];
  state.players[me()].hand = list.map((cardId) => ({ iid: state.nextIid++, cardId }));
  state.players[me()].manaCap = 10;
  state.players[me()].mana = 10;
  state.phase = me() === state.firstPlayer ? 'SPELL_FIRST' : 'SPELL_SECOND';
  view.busy = false;
  view.busyText = '';
  clearSelection();
  refresh();
  return list;
};

/**
 * 无头推进的一步：让当前行动方由 AI 走完，再推进阶段。
 *
 * 调用方必须先把 `state.humanSide` 设成 -1（「这一局没有真人」）：
 * 强化士兵（拟定目标攻击）在真人那一侧会挂起等人答，而这条路径上没有玩家 ——
 * 设成 -1 后引擎自己挑目标，从源头上就不产生挂起
 * （这也是它能替代 autoAnswerPending 的原因）。
 *
 * 出错就抛，由调用方决定是「静默停下」还是「把错误报回去」—— 下面两个钩子口径不同。
 */
function driveAiStep() {
  const actor = G.getActor(state);
  if (actor === null) { advanceGame(); return; }
  const r = aiTakeTurn(state, actor);
  RP.recAiActions(recording, actor, r && r.actions);
  if (state.winner === null) advanceGame();
}

/** 双方都由 AI 代打，推进到第 n 回合后停下（预览中局用） */
window.__playTurns = (n = 3) => {
  if (!state) startNewGame();
  screen = 'game';
  paused = true;
  clearTimeout(bannerTimer);
  clearTimeout(autoAdvanceTimer);
  state.humanSide = -1;
  let guard = 0;
  while (state.winner === null && state.turn <= n && guard++ < 4000) {
    try { driveAiStep(); } catch { break; }
  }
  view.busy = false;
  view.busyText = '';
  refresh();
  return state.turn;
};

/**
 * 让 AI 接管人类一方，直接驱动引擎跑完整局。
 * 用于在无浏览器环境下验证「引擎 + AI + 渲染」整条链路是否可用。
 *
 * 走的是和真实对局完全相同的录制 + 结算路径，
 * 所以构建门禁顺带就能验证「回放能存下来」「金币会增长」。
 */
window.__autoPlay = (maxSteps = 4000) => {
  if (!state) startNewGame();
  screen = 'game';
  state.humanSide = -1;
  let guard = 0;
  while (state.winner === null && guard++ < maxSteps) {
    try { driveAiStep(); } catch (err) { return { error: `推进失败: ${err.message}` }; }
  }
  settleIfNeeded();
  refresh();
  const html = document.getElementById('stage').innerHTML;
  return {
    winner: state.winner,
    reason: state.winReason,
    turn: state.turn,
    cardsPlayed: state.stats.cardsPlayed,
    unitsDestroyed: state.stats.unitsDestroyed,
    htmlLength: html.length,
    htmlOk: html.includes('board-row') && html.includes('class="hand"'),
    stalled: state.winner === null && guard >= maxSteps,
  };
};

/**
 * 自检钩子：伪造一个联机会话，按一次「认输」，看这条操作有没有真的交给会话发出去。
 * 联机认输的旧 bug：一边认输只改了本机 state.winner，对手收不到操作，所以不结算。
 * 返回 { sent, finish() }：sent 是交给 session.submit 的操作；finish() 收尾。
 */
window.__demoSurrender = (mySide = 0) => {
  const real = session;
  const sent = [];
  session = {
    isHost: mySide === 0,
    mySide,
    step: 0,
    lastError: '',
    peerName: '对手',
    started: true,
    submit(a) {
      sent.push(a);
      // 真会话的 submit 也会先本地应用再发包，这里保持一致
      if (a.k === 's') applyLocalAction(a);
      return true;
    },
  };
  startNewGame();
  screen = 'game';
  paused = true;
  clearTimeout(bannerTimer);
  clearTimeout(autoAdvanceTimer);
  refresh();
  return {
    sent,
    finish() {
      session = real;
      startNewGame();
      refresh();
    },
  };
};
