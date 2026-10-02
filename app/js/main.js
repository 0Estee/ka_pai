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
 * ⚠ app-state.js 必须**第一个** import：它是共享状态的声明，要先求值；
 *   而且打包器会把 `const G = {...}` 这类命名空间对象插在模块代码之后，
 *   所以共享状态的读取一律走裸名字（见各文件头部说明）。
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

import { HUMAN, AI, me, foe, foeName, HOME_ASSET_URL } from './app-state.js';
import {
  makeView, applyTheme, setTheme, setDifficulty, goHome, goSettings, goReplays,
  showBanner, refresh, escMain, LANE_LABEL, toggleMenu, fillMenuLog,
} from './render.js';
import {
  startNewGame, newGame, doAction, applyLocalAction, advanceGame,
  playCardAction, tick, settleIfNeeded, summarizeLog,
} from './game-flow.js';
import {
  NO_CHOICE_TARGET_KINDS, analyzeSpell, isPlayable, computePlayable, clearSelection,
  selectCard, resolvePlayerChoice, commitPlay,
  handleSlotClick, handleUnitClick, handleKingClick, handleAction,
} from './play-input.js';
import {
  enterLobby, isHostName, normalizeHostInput, joinByManualAddress,
  randomRoomName, createRoom, scanLanRooms, hostStartMatch, quitRoom,
} from './lan.js';
import {
  persistReplays, updateReplay, deleteReplay, openReplay, stopReplay, replayDelay,
  scheduleReplay, toggleReplayPlay, stepReplay, cycleReplaySpeed, seekReplayTo,
} from './replay-ui.js';

import * as G from '../../engine/src/engine.js';
import * as M from '../../engine/src/mechanics.js';
import { LANES, ROWS, LANE_NAME } from '../../engine/src/constants.js';
import { matchesTargetFilter } from '../../engine/src/keywords.js';
import { filterCtx } from '../../engine/src/auras.js';
import { TEST_CARD_LIB, buildTestDeck } from '../../engine/cards/test-cards.js';
import { aiTakeTurn, DIFFICULTIES, DEFAULT_DIFFICULTY, difficultyByKey, applyDifficultyBonus, applyBonusObject } from './ai.js';
import { render } from './ui.js';
import * as Store from './store.js';
import * as Eco from './economy.js';
import * as RP from './replay.js';
import * as Net from './multiplayer.js';
import {
  homeHTML, settingsHTML, replayListHTML, replayBarHTML, nextSpeed, APP_VERSION,
  playMenuHTML, difficultyHTML, lanMenuHTML, lanScanHTML, lobbyHTML,
} from './screens.js';

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
    // 第一次进游戏：发初始金币，但**不计入累计金币**（不然白送一级）
    profile = { ...Store.defaultProfile(), gold: Eco.INITIAL_GOLD, lifetimeGold: 0 };
    Store.saveProfile(profile);
  }

  replays = Store.loadReplays();
  applyTheme();
  // 界面状态在任何屏幕上都要有，不然首页点「扫描房间」之类的会碰到 null
  view = makeView();

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

document.addEventListener('click', (ev) => {
  const actEl = ev.target.closest('[data-act]');
  if (actEl) {
    handleAction(actEl.dataset.act, actEl);
    return;
  }
  // 回放中只允许操作控制条，不响应对局内的点击
  if (screen !== 'game') return;
  // 有挂起的交互请求时，棋盘一律不响应 —— 必须先把它答完
  if (state && state.pending) return;
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
/** 直接切屏（截图 / 自检用） */
window.__go = (name) => {
  if (name === 'home') goHome();
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
/** 自检用：看录制里那份「每一问的答案流水」 */
window.__recordingLog = () => (recording && recording.choiceLog ? recording.choiceLog.map((e) => ({ ...e })) : []);

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
 * 自检用：以**当前局面**为起点重开一份录制（动作清空）。
 *
 * 用途：测试要构造特定场面（例如「手上正好有一张歼-10」）时，
 * 直接改 `state` 会让录制里的起局与实际不符，回放必然对不上 ——
 * 那不是回放的 bug，是造场面的方式不对。以当前局面为起点重新录，
 * 两边就吃同一份「起局 + 操作」，才能干净地验回放。
 *
 * 只需要 `seed / firstPlayer / deck / cardSet / bonuses` 就够了，
 * 因为 `createGame` 是按这些确定性重建的，而 `deck` 此刻就是**还没抽的那部分**。
 */
window.__resetRecording = () => {
  if (!state) return null;
  recording = RP.newRecording({
    seed: state.seed,
    firstPlayer: state.firstPlayer,
    deck: state.deck,
    cardSet: RP.cardSetId(TEST_CARD_LIB),
    bonuses: [],
    humanSide: state.humanSide,
  });
  // 答案流水也要一起清空：它属于「这一份录制」，不清就等于带着上一段的答案
  // 重放新的一段，从第一问起就错位。
  state.choiceLog = recording.choiceLog;
  return recording.actions.length;
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
  if (state && Array.isArray(state.qTrace)) window.__liveQTrace = state.qTrace.slice();

  /** 从内存里那份 recording 重建一条等价的回放记录（给不传 recordOverride 的场合用） */
  const recOf = (acts) => ({
    ...RP.newRecording({
      seed: recording.seed, firstPlayer: recording.firstPlayer, deck: recording.deck,
      cardSet: recording.cardSet, bonuses: recording.bonuses, humanSide: recording.humanSide,
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
window.__setGold = (n) => {
  profile = { ...profile, gold: Number(n) || 0 };
  Store.saveProfile(profile);
  refresh();
  return profile;
};
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
   */
  lockstepCheck: (seed, firstPlayer, deck, actions, bonuses = []) => {
    const build = () => {
      const s = G.createGame({ seed, firstPlayer, deck: deck.slice(), cardLib: TEST_CARD_LIB });
      G.startGame(s);
      // 难度加成也要复现，否则「锁步」在一开始就不锁（那是它自己在跟自己比）
      for (const bn of bonuses) applyBonusObject(s, bn.side, bn);
      s.autoResolveChoices = true;
      /**
       * **两侧都不是真人**：这一局是「拿录下来的操作流喂给两个引擎」，
       * 没有人在旁边点。强化士兵（拟定目标攻击）在真人那一侧会挂起等人答，
       * 而这里没人答 —— 设成 -1 让两侧都由引擎自己决策，
       * 两端走的是同一套确定性策略，锁步才有意义。
       * （真实联机里 humanSide 是 me()，和这里的用途不同。）
       */
      s.humanSide = -1;
      return s;
    };
    const a = build();
    const b = build();

    let divergedAt = -1;
    for (let i = 0; i < actions.length; i++) {
      const act = actions[i];
      try {
        applyTo(a, act);
        applyTo(b, act);
      } catch (err) {
        return { ok: false, steps: i, divergedAt: i, error: err.message };
      }
      if (Net.stateSignature(a) !== Net.stateSignature(b)) { divergedAt = i + 1; break; }
    }
    return {
      ok: divergedAt < 0,
      steps: actions.length,
      divergedAt,
      hashA: Net.stateHash(a),
      hashB: Net.stateHash(b),
      winnerA: a.winner,
      winnerB: b.winner,
    };
  },
};

function applyTo(st, act) {
  if (act.k === 'a') G.advance(st);
  else if (act.k === 'p') G.playCard(st, act.s, act.i, act.o || {});
  else if (act.k === 'c') G.resolveChoice(st, act.v);
}

/**
 * 让两个难度互相对打 n 局，返回战绩。
 * 用来验证「难度确实是递增的」—— 如果困难打不过普通，那这张参数表就是坏的。
 */
window.__aiLeague = (diff0, diff1, n = 60) => {
  const tally = { p0: 0, p1: 0, draw: 0 };
  for (let seed = 1; seed <= n; seed++) {
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
      try { aiTakeTurn(st, actor, { difficulty: actor === 0 ? diff0 : diff1 }); } catch { break; }
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
 * 截图 / 自检用：构造一个「玩家手里有【攻击】且轮到玩家打锦囊」的场景，
 * 并自动选中那张牌，用来验证「敌方国王」这个目标是否正确高亮、可点击。
 */
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
  handleSlotClick(slotEl);

  const rq = state.pending ? state.pending.request : null;
  const info = {
    slots,
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
  };
  session = real;
  return r;
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
 * 截图 / 自检用：把手牌换成指定的一组卡，用来检查卡面文字排版。
 * 不传参数时放一批第二批手绘卡（单位牌现在也要显示异能文字）。
 */
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

/** 双方都由 AI 代打，推进到第 n 回合后停下（预览中局用） */
window.__playTurns = (n = 3) => {
  if (!state) startNewGame();
  screen = 'game';
  paused = true;
  clearTimeout(bannerTimer);
  clearTimeout(autoAdvanceTimer);
  // 「这一局没有真人」——同 __autoPlay：否则强化士兵的问询会挂起等人，而这里没人
  state.humanSide = -1;
  let guard = 0;
  while (state.winner === null && state.turn <= n && guard++ < 4000) {
    const actor = G.getActor(state);
    if (actor === null) {
      try { advanceGame(); } catch { break; }
      continue;
    }
    try { const r = aiTakeTurn(state, actor); for (const a of (r && r.actions) || []) RP.recPlay(recording, actor, a.iid, a.opts); } catch { break; }
    try { if (state.winner === null) advanceGame(); } catch { break; }
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
  /**
   * 「这一局没有真人」：把双方都交给 AI 决策。
   *
   * 强化士兵（拟定目标攻击）在真人那一侧会挂起等人答，而这条路径上没有玩家 ——
   * humanSide = -1 表示两侧都不是真人，引擎就会自己挑目标，不会挂起。
   * （这也是它能替代 autoAnswerPending 的原因：从源头上就不产生挂起。）
   */
  state.humanSide = -1;
  let guard = 0;
  while (state.winner === null && guard++ < maxSteps) {
    const actor = G.getActor(state);
    if (actor === null) {
      try { advanceGame(); } catch (err) { return { error: `advance 失败: ${err.message}` }; }
      continue;
    }
    try {
      const r = aiTakeTurn(state, actor);
      for (const a of (r && r.actions) || []) RP.recPlay(recording, actor, a.iid, a.opts);
    } catch (err) {
      return { error: `AI 出牌失败: ${err.message}` };
    }
    try {
      if (state.winner === null) advanceGame();
    } catch (err) {
      return { error: `advance 失败: ${err.message}` };
    }
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
