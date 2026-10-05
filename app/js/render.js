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
};
