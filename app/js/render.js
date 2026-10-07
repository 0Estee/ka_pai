/**
 * 渲染与屏幕切换：makeView / applyTheme / 主题与难度 / 首页·设置·回放列表路由 /
 * showBanner / refresh（按 `screen` 渲染进 #stage）/ 战报菜单。
 *
 * 与 app/js 其它模块共享同一个打包作用域（见 tools/build-web.mjs）：
 * screen/state/view/session/profile/settings/replays/replayCtx/rpUI/lanRooms/
 * lanScanning/difficulty/lanInfo/lastSettle 等共享状态直接按裸名字读写，不需要 import。
 */

import * as Store from './store.js';
import * as Eco from './economy.js';
import * as Net from './multiplayer.js';
import { TEST_CARD_LIB } from '../../engine/cards/test-cards.js';
import { difficultyByKey, DIFFICULTIES } from './ai.js';
import { FACTIONS } from '../../engine/src/engine.js';
import { render } from './ui.js';
import {
  homeHTML, settingsHTML, replayListHTML, replayBarHTML,
  playMenuHTML, difficultyHTML, lanMenuHTML, lanScanHTML, lobbyHTML,
  setNavDir,
} from './screens.js';

/** 建立一份新的界面状态 */
function makeView() {
  return {
    humanSide: me(),
    selectedIid: null,
    legalSlots: [],
    legalUnitTargets: [],
    legalLanes: [],
    legalKingTargets: [],
    playableIids: [],
    lastDamaged: [],
    lastKilled: null,
    /** 正在查看详情的场上单位 uid（点场上卡牌打开，null = 没打开） */
    infoUid: null,
    hint: '',
    banner: '',
    busy: false,
    busyText: '',
    settle: null,
  };
}

function applyTheme() {
  // 主题白名单：认不出的取值一律回落到深色（老存档里可能存着别的字符串）
  const theme = settings && (settings.theme === 'light' || settings.theme === 'glass') ? settings.theme : 'dark';
  // DOM stub（tools/check-bundle.mjs）里没有 documentElement，必须兜住
  try {
    const root = document.documentElement;
    if (root && root.dataset) root.dataset.theme = theme;
  } catch { /* 非浏览器环境，忽略 */ }
}

function setTheme(theme) {
  settings = { ...settings, theme: theme === 'light' || theme === 'glass' ? theme : 'dark' };
  Store.saveSettings(settings);
  applyTheme();
  refresh();
}

/** 阵营界面选项：引擎的 FACTIONS + 一句人话说明（策划口径，写在这里以免污染引擎） */
const FACTION_TAGLINE = {
  demon: '献祭自己的单位换取力量：更疼的伤害、更高的攻击力',
  god: '稳扎稳打：无敌、治疗与祝福，让队友站得住',
  sword: '一套连招打到底：穿透、额外攻击与成吨的伤害',
  music: '用光环与音波削弱全场：全体 -1/-1，越打越弱',
  science: '攒钱拍科技：费用越滚越多，锦囊还能再放一次',
  divine: '守护国王：替伤、治疗，并把敌人的攻击力永久清零',
  alchemy: '炼药：每抽一张牌得一份原料，把原料组成药水与令牌',
};

function factionOptions() {
  return Object.keys(FACTIONS).map((key) => ({
    key,
    name: FACTIONS[key].name || key,
    tagline: FACTION_TAGLINE[key] || '',
  }));
}

/**
 * 选择本局阵营。和难度不同，**不写进设置**：它是「这一局」的选择。
 */
function setFaction(key) {
  const known = Object.keys(FACTIONS);
  myFaction = known.indexOf(key) >= 0 ? key : known[0];
  refresh();
}

function setDifficulty(key) {
  difficulty = difficultyByKey(key).key;
  settings = { ...settings, difficulty };
  Store.saveSettings(settings);
  refresh();
}

// ══════════════════════════════════════════════════════════
// 屏幕切换
// ══════════════════════════════════════════════════════════

function goHome() {
  stopReplay();
  clearTimeout(bannerTimer);
  clearTimeout(autoAdvanceTimer);
  screen = 'home';
  rpUI.editingNoteId = null;
  rpUI.confirmDelId = null;
  refresh();
}

function goSettings() {
  screen = 'settings';
  refresh();
}

function goReplays() {
  replays = Store.loadReplays();
  screen = 'replays';
  rpUI.editingNoteId = null;
  rpUI.confirmDelId = null;
  refresh();
}

/**
 * 横幅提示：text 是主标题，sub 是可选的小字第二行。
 *
 * 为什么要拆成两段：横幅渲染时对整串做了 esc()（见 app/js/ui.js 里的 banner 那一行），
 * 以前调用方往 text 里直接写 <small>...</small>，玩家看到的就是标签字样本身
 * （作者 2026-10 报的「锦囊的使用提示不正确」）。分开传、分开转义就不会有这个问题。
 */
/**
 * 排队展示横幅（作者 2026-10 口径：AI 用锦囊也要放大展示，持续 2 秒）。
 * showBanner 是「后一条顶掉前一条」，而 AI 一回合可能连出好几张锦囊，
 * 直接连着调只会看到最后一张，所以多的排进 view.bannerQueue 一张张播。
 */
let bannerAnimTimer = null;

function queueBanner(text, ms, sub) {
  if (!view) return;
  if (view.banner) {
    if (!view.bannerQueue) view.bannerQueue = [];
    if (view.bannerQueue.length < 4) view.bannerQueue.push({ text, ms, sub });
    return;
  }
  showBanner(text, ms, sub);
}

function showBanner(text, ms, sub) {
  clearTimeout(bannerTimer);
  view.banner = text;
  view.bannerSub = sub || "";
  // 入场动画只播一次：refresh() 会整块重建 #stage，每重渲染一次动画就重启一次，
  // 玩家看到的就是「横幅反复弹出来」（作者 2026-10 报的「提示多次出现」）。
  // 首次渲染带 .banner（有动画），之后都带 .banner-rest（静止）。
  view.bannerAnimate = true;
  refresh();
  // 关键是这个标记什么时候关：showBanner 之后同一次任务里往往还有一次 refresh
  //（commitPlay 收尾、AI 分支收尾），标记要留到那之后才关，
  // 这样最后画到屏幕上的那一帧是带动画的；之后的重渲染（特效步进、tick）
  // 才带 .banner-rest（animation: none），也就不会「反复弹出来」。
  if (bannerAnimTimer) clearTimeout(bannerAnimTimer);
  bannerAnimTimer = setTimeout(() => {
    bannerAnimTimer = null;
    view.bannerAnimate = false;
  }, 220);
  bannerTimer = setTimeout(() => {
    view.banner = "";
    view.bannerSub = "";
    if (view.bannerQueue && view.bannerQueue.length) {
      const next = view.bannerQueue.shift();
      showBanner(next.text, next.ms, next.sub);
      return;
    }
    refresh();
  }, ms);
}

// ══════════════════════════════════════════════════════════
// 菜单 / 战报
// ══════════════════════════════════════════════════════════

function toggleMenu(force) {
  const el = document.getElementById('menu');
  const show = force === undefined ? el.classList.contains('hidden') : force;
  if (show) fillMenuLog();
  el.classList.toggle('hidden', !show);
}

function fillMenuLog() {
  const el = document.getElementById('menu');
  if (!el || !state) return;

  // 卡名一律从卡库解析：老日志（消灭 / 中毒 / 疾病 / 落水）只带 cardId，
  // 直接打到界面上就是 U401 这种内部编号（作者 2026-10 报的 bug）。
  const nameOf = (e) => e.name || (state.cardLib && state.cardLib[e.cardId] && state.cardLib[e.cardId].name) || '';
  // 消灭原因在引擎里是英文标识，翻一次再给人看；不认识的就不显示括号。
  const REASON_LABEL = {
    effect: '效果', sacrifice: '献祭', combat: '战斗', 'lethal-damage': '致命伤害',
    'stat-loss': '属性归零', 'stat-set': '属性被设为 0', 'nimble-drown': '轻灵落水',
    disease: '疾病', destroy: '被消灭',
  };
  // 谁 / 干了什么 / 目标：三段分开着色。
  // 谁 —— 继承行色（.lg-me / .lg-foe 已按敌我上色），加粗即可；
  // 动作 —— 次级色；目标（卡名、线路、数值） —— 强调色。
  const W = (t) => '<span class="lg-who">' + t + '</span>';
  const A = (t) => '<span class="lg-act">' + t + '</span>';
  const T = (t) => '<span class="lg-tgt">' + t + '</span>';
  const laneRow = (e) => T((LANE_LABEL[e.lane] || e.lane) + '-' + (e.row === 'front' ? '前排' : '后排'));

  const lines = state.log
    .filter((e) => ['deploy', 'cast', 'destroy', 'king-damage', 'turn-start', 'game-over', 'nimble-drown', 'poison-tick', 'disease-tick'].includes(e.type))
    .slice(-220)
    .map((e) => {
      // 联机时对手是真人，别叫他「AI」
      const who = e.side === undefined ? '' : (e.side === me() ? '你' : foeName());
      const cls = e.side === undefined ? 'lg' : 'lg lg-' + (e.side === me() ? 'me' : 'foe');
      const card = nameOf(e);
      switch (e.type) {
        case 'turn-start': return `<div class="lg-turn">── 第 ${e.turn} 回合 ──</div>`;
        case 'deploy': return '<div class="' + cls + '">' + W(who) + ' ' + A('放置') + ' ' + T(card) + ' ' + A('到') + ' ' + laneRow(e) + '</div>';
        case 'cast': return '<div class="' + cls + '">' + W(who) + ' ' + A('打出锦囊') + ' ' + T(card) + '</div>';
        case 'destroy': {
          const why = REASON_LABEL[e.reason];
          return '<div class="' + cls + '">' + W(who) + ' ' + A('的') + ' ' + T(card) + ' ' + A('被消灭') + (why ? ' ' + A('（' + why + '）') : '') + '</div>';
        }
        case 'king-damage': return '<div class="lg lg-king">' + W(e.side === me() ? '你的国王' : 'AI 的国王') + ' ' + A('受到') + ' ' + T(e.amount + ' 点伤害') + ' ' + A('，剩余') + ' ' + T(String(e.hp)) + '</div>';
        case 'nimble-drown': return '<div class="' + cls + '">' + T(card) + ' ' + A('在水路失去两栖被消灭') + '</div>';
        case 'poison-tick': return '<div class="' + cls + '">' + (e.kingSide !== undefined ? W(e.kingSide === me() ? '你的国王' : 'AI 的国王') + ' ' : (card ? T(card) + ' ' : '')) + A('中毒结算') + ' ' + T(e.x + ' 点') + '</div>';
        case 'disease-tick': return '<div class="' + cls + '">' + (card ? T(card) + ' ' : '') + A('疾病发作被消灭') + '</div>';
        case 'game-over': return '<div class="lg-turn">对局结束：' + T(e.reason) + '</div>';
        default: return '';
      }
    })
    .join('');

  el.innerHTML = `
    <div class="menu-panel">
      <div class="menu-head">
        <h3>战报 / 菜单</h3>
        <button class="btn-close" data-act="close-menu">关闭</button>
      </div>
      <div class="menu-body">${lines || '<div class="lg">暂无记录</div>'}</div>
      ${screen === 'replay' ? '' : `<div class="menu-foot">
        <button class="btn-restart" data-act="restart">重新开局</button>
        <button class="btn-surrender" data-act="surrender">认输</button>
      </div>`}
    </div>`;
}

/**
 * 屏幕层级：数字变大 = 前进（进二级 / 三级菜单、进对局），变小 = 返回。
 * 切换时用它决定滑动方向，于是「返回动画与进入相反」是自动成立的。
 */
const SCREEN_DEPTH = { home: 0, settings: 1, replays: 1, play: 1, difficulty: 2, lan: 2, lanScan: 3, lobby: 3, game: 3, replay: 4 };
let lastScreen = null;
let navTimer = null;

/**
 * 开局铺开：进入对局后「从上往下一行一行出现」（作者 2026-10-07 反馈）。
 *
 * 上一版把入场动画整个交给 CSS（所有行同时带 data-in="1"，靠 animation-delay * --i 排队），
 * 但 refresh() 每次都整块重建 #stage 的 innerHTML，重建就会让 CSS 动画从头重放；
 * 而开局后 260ms / 420ms 就有自动阶段与 AI 回合的刷新，于是玩家看到的是
 * 「卡一下、像重新渲染了一遍」。把入场窗口改小、或改成「一次性标记」都治不了：
 * 只要动画还在播，任何一次重绘都会把它重放。
 *
 * 现在改成 JS 推进 + 直接翻属性：
 *    进度（已经露出几格）存在模块变量里，重绘只是「照当前进度画一遍」，
 *     所以刷新既不重放、也不会把正在进行的铺开掐掉；
 *    每格出场是把活节点上的 data-in 从 "0" 改成 "1"（不重建 DOM），
 *     浏览器只对这一行播一次入场动画，其它行连重新光栅化都没有；
 *    还没轮到的行照常渲染在 HTML 里，只是不可见（data-in="0"），
 *     行数 / 格子数 / 布局都不受铺开影响；
 *    重绘出来的 HTML 永远不带 data-in="1"：入场动画只能由这一次属性翻转产生，
 *     从根上杜绝「重绘把动画重放一遍」。
 */
const REVEAL_STEP_MS = 90;   // 每格之间的间隔；一共 5 行棋盘 + 1 步手牌
const REVEAL_TOTAL = 6;      // 铺开槽位：0..4 是棋盘行（从上到下），5 是手牌

let boardReveal = null;      // { shown, total, timer }；null = 不在铺开（渲染成全部可见）

function stopBoardReveal() {
  if (boardReveal && boardReveal.timer) clearTimeout(boardReveal.timer);
  boardReveal = null;
}

/** 开始铺开：进度从 0（全部不可见）开始；调用方紧接着会渲染一次 */
function startBoardReveal() {
  stopBoardReveal();
  boardReveal = { shown: 0, total: REVEAL_TOTAL, timer: null };
  boardReveal.timer = setTimeout(boardRevealStep, REVEAL_STEP_MS);
}

function boardRevealStep() {
  if (!boardReveal) return;
  boardReveal.timer = null;
  if (screen !== 'game') { stopBoardReveal(); return; }
  const slot = boardReveal.shown;      // 这一步要露出的格子
  boardReveal.shown += 1;
  let flipped = false;
  try {
    const stage = document.getElementById('stage');
    if (stage && typeof stage.querySelectorAll === 'function') {
      const rows = stage.querySelectorAll('.board-row');
      if (slot < rows.length) rows[slot].setAttribute('data-in', '1');
      else for (const c of stage.querySelectorAll('.hand .card')) c.setAttribute('data-in', '1');
      flipped = true;
    }
  } catch (e) { flipped = false; }
  // DOM 桩（门禁里）没有 querySelectorAll：退回整块重绘，进度照样推进、断言照样可查
  if (!flipped) refresh();
  if (boardReveal && boardReveal.shown >= boardReveal.total) stopBoardReveal();
  else if (boardReveal) boardReveal.timer = setTimeout(boardRevealStep, REVEAL_STEP_MS);
}

/**
 * 卡牌飞行（作者 2026-10-07）：
 *   增手牌   -> 从屏幕正下方沿弧线划进手牌卡槽；
 *   打出手牌 -> 从手牌卡槽滑向落点格子；
 *   AI 出牌  -> 统一从屏幕正上方滑入。
 *
 * 为什么必须有覆盖层：
 *   1) #stage 每次 refresh() 都整块重写 innerHTML，动画元素放在里面会被立刻冲掉；
 *   2) 手牌区 .hand 是 overflow: hidden，被 transform 移出卡槽的克隆卡会被直接裁掉。
 *   所以克隆卡挂在 document.body 的 #fx-layer 上（和 #menu 一样，独立于 stage 的重绘）。
 *
 * 门禁里的 DOM 桩没有 createElement / getBoundingClientRect / animate：
 * 这种情况下只把「本该飞的卡」记进 flightLog（animated: false），一行 DOM 都不碰。
 */
const FLIGHT_MS = 460;
const FLIGHT_LOG_MAX = 200;
let flightLayer = null;
let pendingFlights = [];
let flightLog = [];
let lastHandIids = null;   // 上一帧的手牌 iid，用来认「刚抽到的新牌」
let playSources = [];      // 出牌前抓下来的源卡（按顺序配对给 deploy/cast 日志）
let cardFxCursor = -1;     // state.log 的扫描游标；< 0 表示还没定基线
let flightSeq = 0;         // 单调计数：环形缓冲被截断时，门禁靠它数「新增了几笔」

function canFlyDom() {
  try {
    return typeof document !== 'undefined'
      && typeof document.createElement === 'function'
      && !!document.body
      && typeof document.body.appendChild === 'function';
  } catch (e) { return false; }
}

/** 新局：清空没播完的队列与抓拍（flightLog 留着给门禁和排查看） */
function resetCardFlights() {
  pendingFlights = [];
  playSources = [];
  lastHandIids = null;
  cardFxCursor = -1;
}

/** 自检用：最近这些笔「该飞的卡」（main.js 的 window.__cardFlights 读它） */
function cardFlightLog() { return flightLog.slice(); }

/** 累计记过多少笔（不受环形缓冲截断影响，门禁数增量用） */
function cardFlightSeq() { return flightSeq; }

function enqueueCardFlight(f) {
  if (!f) return;
  pendingFlights.push(f);
  if (pendingFlights.length > 24) pendingFlights.shift();
}

function noteFlight(f, animated) {
  flightSeq += 1;
  flightLog.push({
    kind: f.kind,
    side: f.side,
    cardId: f.cardId || null,
    iid: f.iid == null ? null : f.iid,
    lane: f.lane == null ? null : f.lane,
    row: f.row || null,
    from: f.from || null,
    animated: !!animated,
  });
  if (flightLog.length > FLIGHT_LOG_MAX) flightLog.shift();
}

/** 出牌前抓源卡：卡槽位置 + 卡面 HTML（打出去之后这张牌就不在手牌里了） */
function captureHandCardSource(iid, cardId) {
  const cap = { iid: iid == null ? null : iid, cardId: cardId || null, rect: null, html: '' };
  try {
    const stage = document.getElementById('stage');
    if (stage && typeof stage.querySelector === 'function' && iid != null) {
      const el = stage.querySelector('.hand .card[data-iid="' + iid + '"]');
      if (el) {
        cap.html = el.innerHTML || '';
        if (typeof el.getBoundingClientRect === 'function') cap.rect = el.getBoundingClientRect();
      }
    }
  } catch (e) { /* 拿不到就算了：飞行会退回默认轨迹 */ }
  playSources.push(cap);
  if (playSources.length > 8) playSources.shift();
  return cap;
}

function rectCenterOf(r) {
  if (!r || typeof r.left !== 'number') return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
}

function queryRect(sel) {
  try {
    if (typeof document.querySelector !== 'function') return null;
    const el = document.querySelector(sel);
    if (el && typeof el.getBoundingClientRect === 'function') return el.getBoundingClientRect();
  } catch (e) {}
  return null;
}

function slotRectOf(lane, side, row) {
  if (lane == null || side == null || !row) return null;
  return queryRect('.slot[data-lane="' + lane + '"][data-side="' + side + '"][data-row="' + row + '"]');
}

function handRectOf(iid) {
  if (iid == null) return null;
  return queryRect('.hand .card[data-iid="' + iid + '"]');
}

function flightLayerEl() {
  if (flightLayer) return flightLayer;
  if (!canFlyDom()) return null;
  try {
    const el = document.createElement('div');
    el.id = 'fx-layer';
    document.body.appendChild(el);
    flightLayer = el;
    return el;
  } catch (e) { return null; }
}

/** 起点 -> 控制点 -> 终点摊成 11 帧（二次贝塞尔），交给 Web Animations 播 */
function arcFrames(from, to, bulge) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const ctrl = {
    x: (from.x + to.x) / 2 + (-dy / len) * len * bulge,
    y: (from.y + to.y) / 2 + (dx / len) * len * bulge,
  };
  const frames = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const u = 1 - t;
    const x = u * u * from.x + 2 * u * t * ctrl.x + t * t * to.x;
    const y = u * u * from.y + 2 * u * t * ctrl.y + t * t * to.y;
    frames.push({
      transform: 'translate(' + (x - from.x).toFixed(1) + 'px, ' + (y - from.y).toFixed(1) + 'px)'
        + ' rotate(' + ((1 - t) * -7).toFixed(2) + 'deg) scale(' + (1 - t * 0.12).toFixed(3) + ')',
      opacity: t > 0.82 ? String(Math.max(0, (1 - t) / 0.18)) : '1',
    });
  }
  return frames;
}

/** 落点格子被砸一下（卡牌落地的反馈） */
function dropSlotPulse(f) {
  try {
    const el = document.querySelector('.slot[data-lane="' + f.lane + '"][data-side="' + f.side + '"][data-row="' + f.row + '"]');
    if (!el || !el.classList) return;
    el.classList.add('fx-drop');
    setTimeout(() => { try { el.classList.remove('fx-drop'); } catch (e) {} }, 380);
  } catch (e) {}
}

/** 没有源卡面（AI 出牌 / 召唤）时，按卡牌定义拼一张 */
function faceHTML(cardId) {
  const def = (state && state.cardLib && state.cardLib[cardId]) || null;
  if (!def) return '<div class="card fly-face"></div>';
  const cls = def.type === 'unit' ? '' : (def.spellKind === 'item' ? ' is-item' : ' is-spell');
  const stat = def.type === 'unit'
    ? '<div class="c-stats"><span>' + (def.atk == null ? 0 : def.atk) + '</span>/<span>' + (def.hp == null ? 0 : def.hp) + '</span></div>'
    : '';
  return '<div class="card fly-face' + cls + '">'
    + '<div class="c-cost">' + (def.cost == null ? 0 : def.cost) + '</div>'
    + '<div class="c-name">' + escMain(def.name || '') + '</div>'
    + stat
    + '</div>';
}

/** 真的动手飞一张；没有 DOM 就返回 false（只记意图） */
function spawnFlight(f) {
  if (!canFlyDom()) return false;
  const layer = flightLayerEl();
  if (!layer) return false;
  const vw = (typeof window !== 'undefined' && window.innerWidth) || 390;
  const vh = (typeof window !== 'undefined' && window.innerHeight) || 844;

  const toRect = f.kind === 'draw' ? handRectOf(f.iid) : slotRectOf(f.lane, f.side, f.row);
  const to = rectCenterOf(toRect);
  if (!to) return false;
  const w = Math.round(Math.min(to.w || 84, 96));
  const h = Math.round(Math.min(to.h || 112, 128));

  let from;
  let bulge;
  if (f.kind === 'draw') {
    from = { x: Math.max(w / 2 + 6, Math.min(vw - w / 2 - 6, to.x + w * 0.45)), y: vh + h * 0.8 };
    bulge = -0.24;
  } else if (f.from === 'hand' && f.srcRect) {
    const c = rectCenterOf(f.srcRect);
    from = { x: c.x, y: c.y };
    bulge = to.x >= from.x ? -0.26 : 0.26;
  } else if (f.from === 'above') {
    from = { x: Math.max(w / 2 + 6, Math.min(vw - w / 2 - 6, to.x + 12)), y: -h * 0.7 };
    bulge = 0.26;
  } else {
    from = { x: Math.max(w / 2 + 6, Math.min(vw - w / 2 - 6, to.x + 8)), y: vh + h * 0.8 };
    bulge = -0.24;
  }

  const el = document.createElement('div');
  el.className = 'fly-card';
  el.style.width = w + 'px';
  el.style.height = h + 'px';
  el.style.left = Math.round(from.x - w / 2) + 'px';
  el.style.top = Math.round(from.y - h / 2) + 'px';
  el.innerHTML = f.srcHTML ? '<div class="card fly-face">' + f.srcHTML + '</div>' : faceHTML(f.cardId);
  layer.appendChild(el);

  if (typeof el.animate !== 'function') { try { el.remove(); } catch (e) {} return false; }

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (f.kind === 'play') dropSlotPulse(f);
    try { el.remove(); } catch (e) {}
  };
  try {
    const anim = el.animate(arcFrames(from, to, bulge), { duration: FLIGHT_MS, easing: 'ease-out', fill: 'forwards' });
    if (anim) anim.onfinish = finish;
  } catch (e) {}
  setTimeout(finish, FLIGHT_MS + 180);
  return true;
}

function flyCard(f) {
  let animated = false;
  try { animated = spawnFlight(f); } catch (e) { animated = false; }
  noteFlight(f, animated);
}

/**
 * 每次对局渲染后调用：把「该飞的卡」找出来（新手牌 + 新增的 deploy/cast 日志），
 * 逐张交给 flyCard。游标保证同一条出牌只飞一次（重绘不会重放）。
 */
function flushCardFlights() {
  if (!state || !view || view.isReplay) { pendingFlights = []; return; }
  const logs = state.log || [];
  if (cardFxCursor < 0 || cardFxCursor > logs.length) cardFxCursor = logs.length;

  // 新抽到的手牌：从屏幕正下方划入。首帧只记基线（开局发牌交给铺开动画，不叠加）。
  const p = state.players && state.players[view.humanSide];
  if (p && Array.isArray(p.hand)) {
    if (lastHandIids) {
      for (const c of p.hand) {
        if (!lastHandIids.includes(c.iid)) {
          enqueueCardFlight({ kind: 'draw', side: view.humanSide, iid: c.iid, cardId: c.cardId, from: 'below' });
        }
      }
    }
    lastHandIids = p.hand.map((c) => c.iid);
  }

  // 新增的出牌日志：deploy / cast 都带 side + lane（deploy 还有 row）
  for (let i = cardFxCursor; i < logs.length; i++) {
    const e = logs[i];
    if (!e || (e.type !== 'deploy' && e.type !== 'cast')) continue;
    const mine = e.side === view.humanSide;
    let cap = null;
    // 只把「同一张牌」的抓拍配给它：召唤出来的单位没有抓拍，别把后面那张牌的抓拍吃掉
    if (mine && playSources.length && playSources[0].cardId === (e.cardId || null)) cap = playSources.shift();
    enqueueCardFlight({
      kind: 'play',
      side: e.side,
      cardId: e.cardId || null,
      lane: e.lane == null ? null : e.lane,
      row: e.type === 'deploy' ? (e.row || 'front') : 'front',
      from: mine ? (cap && cap.rect ? 'hand' : 'below') : 'above',
      srcHTML: cap ? cap.html : '',
      srcRect: cap ? cap.rect : null,
    });
  }
  cardFxCursor = logs.length;

  const queued = pendingFlights;
  pendingFlights = [];
  for (const f of queued) flyCard(f);
}

/**
 * 屏幕切换动画：只动按钮，不动整页。
 * 前进时新页面的菜单按钮从右往左滑入，返回时相反（方向由 SCREEN_DEPTH 自动决定）。
 * 旧页面不做整页退场  上一版整页退场与新页面滑入同时进行，看起来就是两个画面重叠。
 * 入场类只挂到动画播完为止（900ms），否则后续 refresh 重绘会把动画反复重播。
 * DOM 桩里没有 querySelector，取手牌滚动位置那段会被 try 跳过。
 */
function playNavFx(stage) {
  const changed = lastScreen !== null && lastScreen !== screen;
  const dir = (SCREEN_DEPTH[screen] || 0) >= (SCREEN_DEPTH[lastScreen] || 0) ? 'forward' : 'back';
  lastScreen = screen;
  setNavDir(changed ? dir : '');
  if (!changed) return;
  if (navTimer) { clearTimeout(navTimer); navTimer = null; }
  try {
    stage.classList.remove('nav-forward', 'nav-back');
    stage.classList.add(dir === 'forward' ? 'nav-forward' : 'nav-back');
    navTimer = setTimeout(() => {
      try { stage.classList.remove('nav-forward', 'nav-back'); } catch (e) { /* stub */ }
      navTimer = null;
    }, 900);
  } catch (e) { /* DOM 桩 */ }
}

/**
 * 手牌是横向滚动的（.hand overflow-x: auto）。refresh() 整块重绘 innerHTML 之后，
 * 滚动位置会被弹回最前面  表现就是每小回合结束后手牌自己跳回去（作者 2026-10-05 报的）。
 * 渲染前记下、渲染后写回。
 */
function handScrollOf(stage) {
  try { const el = stage.querySelector && stage.querySelector('.hand'); return el ? el.scrollLeft || 0 : 0; } catch (e) { return 0; }
}
function restoreHandScroll(stage, x) {
  if (!x) return;
  try { const el = stage.querySelector && stage.querySelector('.hand'); if (el) el.scrollLeft = x; } catch (e) { /* stub */ }
}

const LANE_LABEL = { mountain: '山地', plainL: '平地左', plainR: '平地右', water: '水路' };

// ══════════════════════════════════════════════════════════
// 渲染与事件
// ══════════════════════════════════════════════════════════

/** 按当前屏幕渲染。所有屏幕都写进同一个 #stage */
function refresh() {
  const stage = document.getElementById('stage');

  // 回放时底部有一条固定的控制条，给内容留出高度，别盖住手牌
  try { stage.classList.toggle('stage-replay', screen === 'replay'); } catch { /* stub */ }

  playNavFx(stage);
  if (screen !== 'game') stopBoardReveal();   // 离开对局就别再推铺开

  if (screen === 'home') {
    stage.innerHTML = homeHTML({
      profile,
      level: Eco.levelProgress(profile.lifetimeGold),
      storageMode: Store.storageMode(),
      lastSettle,
    });
    return;
  }

  if (screen === 'play') {
    stage.innerHTML = playMenuHTML({ difficulty: difficultyByKey(difficulty), lanSupported: Net.nativeAvailable() });
    return;
  }

  if (screen === 'difficulty') {
    stage.innerHTML = difficultyHTML({
      current: difficulty,
      difficulties: DIFFICULTIES,
      faction: myFaction,
      factions: factionOptions(),
    });
    return;
  }

  if (screen === 'lan') {
    stage.innerHTML = lanMenuHTML({ lanSupported: Net.nativeAvailable(), localIp: Net.localIp() });
    return;
  }

  if (screen === 'lanScan') {
    stage.innerHTML = lanScanHTML({ rooms: lanRooms, scanning: lanScanning, manualError: lanManualError });
    return;
  }

  if (screen === 'lobby') {
    // ⚠️ 把会话里知道的对手名字**同步进界面状态**。
    //   以前这一栏没有任何地方赋值，`lanInfo.peerName` 永远是空字符串，
    //   而主机「开始对战」按钮的启用条件正是「peerName 非空」——
    //   所以按钮永远停在 disabled，表现就是「能进房间，但点不了开始」。
    if (session && session.peerName) lanInfo.peerName = session.peerName;
    // 身份以**会话**为准：它才是真正在建局的那一方；URL 上的 ?net= 只是入口标记
    const lobbyMode = session ? (session.isHost ? 'host' : 'guest') : Net.netMode();
    stage.innerHTML = lobbyHTML({
      ...lanInfo,
      mode: lobbyMode,
      // 联机要金币 > 0（作者裁决：联机没有保底，归零后只能去打 AI 赚回来）
      gold: profile.gold,
      canPvp: Eco.canPlayPvp(profile),
      // 大厅里也要能选阵营（作者 2026-10-05）
      faction: myFaction,
      factions: factionOptions(),
    });
    return;
  }

  if (screen === 'settings') {
    stage.innerHTML = settingsHTML({
      settings,
      storageMode: Store.storageMode(),
      replaysBytes: Store.replaysBytes(),
    });
    return;
  }

  if (screen === 'replays') {
    stage.innerHTML = replayListHTML({
      records: replays,
      cardLib: TEST_CARD_LIB,
      editingNoteId: rpUI.editingNoteId,
      confirmDelId: rpUI.confirmDelId,
      storageMode: Store.storageMode(),
      replaysBytes: Store.replaysBytes(),
    });
    return;
  }

  // ── 回放播放：复用对局的棋盘渲染，只是数据源换成播放器
  if (screen === 'replay' && replayCtx) {
    // ⚠ 绝对不能调 computePlayable() —— 它读的是**实时对局** state，
    //   而回放渲染的是 replayCtx.player.state。冷启动（内存里还没有对局）
    //   时 state 是 null，整条 refresh() 会在那里抛异常，回放界面根本画不出来。
    //   回放是只读的：合法落点/可出牌这些高亮一律清空。
    const replayView = {
      ...view,
      humanSide: view.humanSide,
      selectedIid: null,
      legalSlots: [],
      legalUnitTargets: [],
      legalLanes: [],
      legalKingTargets: [],
      playableIids: [],
      lastDamaged: [],
      lastKilled: null,
      hint: '',
      banner: '',
      busy: false,
      infoUid: null,
      revealShown: null,
      isReplay: true,
    };
    const replayHandScroll = handScrollOf(stage);
    render(stage, replayCtx.player.state, replayView);
    // 拼字符串而不是 insertAdjacentHTML —— DOM stub 里没有那个方法
    stage.innerHTML += replayBarHTML({
      record: replayCtx.record,
      index: replayCtx.player.index,
      total: replayCtx.player.total,
      playing: replayCtx.playing,
      speed: replayCtx.speed,
      error: replayCtx.player.error,
    });
    restoreHandScroll(stage, replayHandScroll);
    return;
  }

  // ── 对局
  const handScroll = handScrollOf(stage);
  computePlayable();
  // 开局铺开：进度存在模块状态里（不是 CSS 的 animation-delay 排队），
  // 于是任何一次重绘都只是「照当前进度画一遍」已出现的行不重放，没轮到的行保持不可见。
  view.revealShown = boardReveal ? boardReveal.shown : null;
  render(stage, state, view);
  restoreHandScroll(stage, handScroll);
  // 卡牌飞行：这一帧该飞的卡（新抽的手牌 / 刚打出的牌）在这里起飞
  flushCardFlights();

  // 「打到一半反问玩家」的交互，统一走这一层面板。现在有两类请求：
  //   · chooseOption  「抉择」（卡牌「歼-10」）
  //   · combatTarget  「拟定目标攻击」（卡牌「强化士兵」）——开战结算轮到它
  //                    出手时引擎挂起，问这一击打谁
  // 引擎在 autoResolveChoices=false 时会把请求挂进 state.pending；
  // 点选后由 resolvePlayerChoice 恢复效果。
  // 盖在整屏之上，所以挂起期间别的点击都点不到（下面点击分发里也有兜底）。
  if (state.pending) {
    const rq = state.pending.request;
    const isCombatTarget = rq.type === 'combatTarget';
    // 联机：这一问归谁答？归对手时本地不能替他选 
    // 选项还可能泄露对手的手牌/目标，所以连列都不列，只显示等待。
    const canAnswer = canAnswerChoice(rq);
    /**
     * 召唤落点用不遮棋盘的底部条（作者 2026-10-04：召唤时直接在场上选一个
     * 位置放下）。别的请求照旧用遮罩面板。
     */
    if (rq.type === 'summonCell') {
      stage.innerHTML += `<div class="choice-bar">
        <div class="choice-title">${escMain(rq.prompt || '选择召唤位置')}</div>
        ${canAnswer
      ? (rq.options || []).map((o, i) =>
        `<button class="choice-opt" data-act="choose-option" data-idx="${i}">${escMain(o.label)}</button>`).join('')
      : '<div class="choice-sub net-dim">等待对手选择</div>'}
      </div>`;
    }
    if (rq.type !== 'summonCell') stage.innerHTML += `<div class="choice-mask"><div class="choice-box">
      <div class="choice-title">${escMain(rq.prompt || '选择一项')}</div>
      ${isCombatTarget ? '<div class="choice-sub">指定谁，这一击就打谁（可以跨线路、也可以打脸）</div>' : ''}
      ${canAnswer
      ? `<div class="choice-list">${(rq.options || []).map((o, i) =>
    `<button class="choice-opt" data-act="choose-option" data-idx="${i}">${escMain(o.label)}</button>`).join('')}</div>`
      : '<div class="choice-sub net-dim">等待对手选择</div>'}
    </div></div>`;
  }

  // 联机掉线时盖一层提示，并按协议 §7 冻结操作
  if (session && lanInfo.status !== 'connected') {
    const text = lanInfo.status === 'reconnecting'
      ? `与对手的连接中断<br>正在等待重连（最多 60 秒）<br><span class="net-dim">第 ${session.step} 步</span>`
      : `对手已离开，本局结束`;
    stage.innerHTML += `<div class="net-banner">${text}</div>`;
  }
  if (session && session.conflict) {
    stage.innerHTML += `<div class="net-banner net-bad">${escMain(session.conflict)}</div>`;
  }
}

/** HTML 转义。不能叫 esc —— ui.js 里已有同名常量，打包器会因重名直接报错。 */
function escMain(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export {
  makeView, applyTheme, setTheme, setDifficulty, setFaction, goHome, goSettings, goReplays,
  showBanner, refresh, escMain, LANE_LABEL, toggleMenu, fillMenuLog,
  resetCardFlights, captureHandCardSource, cardFlightLog, cardFlightSeq, flushCardFlights,
};
