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
import { render } from './ui.js';
import {
  homeHTML, settingsHTML, replayListHTML, replayBarHTML,
  playMenuHTML, difficultyHTML, lanMenuHTML, lanScanHTML, lobbyHTML,
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
  const theme = settings && settings.theme === 'light' ? 'light' : 'dark';
  // DOM stub（tools/check-bundle.mjs）里没有 documentElement，必须兜住
  try {
    const root = document.documentElement;
    if (root && root.dataset) root.dataset.theme = theme;
  } catch { /* 非浏览器环境，忽略 */ }
}

function setTheme(theme) {
  settings = { ...settings, theme: theme === 'light' ? 'light' : 'dark' };
  Store.saveSettings(settings);
  applyTheme();
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
function showBanner(text, ms, sub) {
  clearTimeout(bannerTimer);
  view.banner = text;
  view.bannerSub = sub || "";
  refresh();
  bannerTimer = setTimeout(() => {
    view.banner = "";
    view.bannerSub = "";
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

  const lines = state.log
    .filter((e) => ['deploy', 'cast', 'destroy', 'king-damage', 'turn-start', 'game-over', 'nimble-drown', 'poison-tick', 'disease-tick'].includes(e.type))
    .slice(-220)
    .map((e) => {
      // 联机时对手是真人，别叫他「AI」
      const who = e.side === undefined ? '' : (e.side === me() ? '你' : foeName());
      switch (e.type) {
        case 'turn-start': return `<div class="lg-turn">── 第 ${e.turn} 回合 ──</div>`;
        case 'deploy': return `<div class="lg lg-${e.side === me() ? 'me' : 'foe'}">${who} 放置 ${e.name} → ${LANE_LABEL[e.lane] || e.lane}-${e.row === 'front' ? '前排' : '后排'}</div>`;
        case 'cast': return `<div class="lg lg-${e.side === me() ? 'me' : 'foe'}">${who} 打出锦囊 ${e.name}</div>`;
        case 'destroy': return `<div class="lg lg-${e.side === me() ? 'me' : 'foe'}">${who} 的 ${e.cardId} 被消灭（${e.reason}）</div>`;
        case 'king-damage': return `<div class="lg lg-king">${e.side === me() ? '你的' : 'AI 的'}国王受到 ${e.amount} 点伤害 → ${e.hp}</div>`;
        case 'nimble-drown': return `<div class="lg">轻灵单位在水路失去两栖被消灭</div>`;
        case 'poison-tick': return `<div class="lg">淬毒结算 ${e.x} 点</div>`;
        case 'disease-tick': return `<div class="lg">疾病结算：目标被消灭</div>`;
        case 'game-over': return `<div class="lg-turn">对局结束：${e.reason}</div>`;
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
      <div class="menu-foot">
        <button class="btn-restart" data-act="restart">重新开局</button>
        <button class="btn-surrender" data-act="surrender">认输</button>
      </div>
    </div>`;
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
    stage.innerHTML = difficultyHTML({ current: difficulty, difficulties: DIFFICULTIES });
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
      isReplay: true,
    };
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
    return;
  }

  // ── 对局
  computePlayable();
  render(stage, state, view);

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
    stage.innerHTML += `<div class="choice-mask"><div class="choice-box">
      <div class="choice-title">${escMain(rq.prompt || '选择一项')}</div>
      ${isCombatTarget ? '<div class="choice-sub">指定谁，这一击就打谁（可以跨线路、也可以打脸）</div>' : ''}
      <div class="choice-list">${(rq.options || []).map((o, i) =>
    `<button class="choice-opt" data-act="choose-option" data-idx="${i}">${escMain(o.label)}</button>`).join('')}</div>
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
  makeView, applyTheme, setTheme, setDifficulty, goHome, goSettings, goReplays,
  showBanner, refresh, escMain, LANE_LABEL, toggleMenu, fillMenuLog,
};
