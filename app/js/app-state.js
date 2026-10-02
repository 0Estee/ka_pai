/**
 * 共享可变状态：`app/js/*` 的其它模块都用**裸名字**读写这里的变量。
 *
 * `screen` 的取值（每一屏都渲染进 #stage，屏幕表另见 main.js 顶部）：
 *   home      首页（金币/等级 HUD + 开始游戏 / 回放对局 / 设置）
 *   game      对局
 *   settings  设置
 *   replays   回放列表
 *   replay    回放播放中（复用 game 的棋盘渲染）
 *
 * #menu 是对局中的战报浮层，独立于 #stage，不受重绘影响。
 */

// 与 app/js 其它模块共享同一个打包作用域（见 tools/build-web.mjs）：
// screen/state/session 等共享状态直接按裸名字引用，不需要 import。
//
// ⚠ 读取下方共享状态的模块**只能**用具名 import（`import { refresh } from './render.js'` 那种），
//   不要 `import * as X from './app-state.js'` —— 打包器给命名空间生成的是
//   `const X = { ... }` 快照对象，let 的后续赋值不会同步过去。
//   本文件的 `export {}` 只是让 main.js 能把这个模块拉进打包图。

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

const HUMAN = 0;
const AI = 1;

/**
 * 本地玩家是哪一方。
 * 单机固定是 0 号；联机时客人是 1 号 —— 所以**所有**「我这方」的判断
 * 都必须走这里，不能再直接写 HUMAN。
 */
function me() {
  return session ? session.mySide : HUMAN;
}
/** 对手是哪一方 */
function foe() {
  return 1 - me();
}
/** 对手的显示名（联机时是真人，不叫「AI」） */
function foeName() {
  return session ? '对手' : 'AI';
}

/**
 * 这一问该由哪一方回答。
 *
 * 引擎的每个交互请求（chooseOption / chooseUnit / combatTarget ...）都写了
 * `side` = 该做主的那一方；这里缺字段时按「我这一侧」兜底，免得老回放卡住。
 */
function choiceOwner(rq) {
  return rq && rq.side !== undefined ? rq.side : me();
}

/**
 * 本地能不能替这一问作答。
 *
 *   单机：可以（对面是 AI，请求本来就都是我这侧的）。
 *   联机：**只有归我这一侧的能答**。对手打出的牌在中途要选效果时，两边都会
 *         挂起，但只有对手那台设备该点；本地只显示「等待对手选择」，
 *         答案随后会随锁步的 { k:'c' } 操作传过来（协议里本来就有这种操作）。
 *
 * 不这么挡的话，两台设备谁先点谁说了算  等于替对手做决定。
 */
function canAnswerChoice(rq) {
  return !session || choiceOwner(rq) === session.mySide;
}

/** 当前屏幕 */
let screen = 'home';

let state = null;
let view = null;
let bannerTimer = null;
let autoAdvanceTimer = null;
let paused = false;

/** 玩家存档（金币 / 等级 / 战绩） */
let profile = null;
/** 设置（目前只有主题） */
let settings = null;
/** 回放档案（全部对局） */
let replays = [];
/** 当前对局的录制；null 表示没有在录 */
let recording = null;
/** 上一局的结算结果（首页会显示） */
let lastSettle = null;

/** 回放播放状态 */
let replayCtx = null; // { record, player, playing, speed, timer }

/** 回放列表的临时界面状态 */
const rpUI = { editingNoteId: null, confirmDelId: null };

/** 局域网扫描结果与状态 */
let lanRooms = [];
let lanScanning = false;

/** 联机会话；null = 单机 */
let session = null;
/** 自动阶段是否正在推进：联机时推进是异步的，用它防重入（否则会跳阶段） */
let autoAdvancing = false;
/** 联机房间信息（大厅显示用） */
let lanInfo = { roomName: '', port: 0, hostSide: 0, peerName: '', status: 'connected', gameReady: false };
/** 手动连接时输入框的报错（WebView 里 prompt/alert 是静默失效的，只能内嵌显示） */
let lanManualError = '';
/** AI 难度（持久化在设置里） */
let difficulty = DEFAULT_DIFFICULTY;

/** 本地资产首页。联机模式下「退出房间」要回到它（见 quitRoom）。 */
const HOME_ASSET_URL = 'file:///android_asset/index.html';

let recordingSeed = 0;
let recordingDeck = [];

export {
  HUMAN, AI, me, foe, foeName, choiceOwner, canAnswerChoice,
  screen, state, view, bannerTimer, autoAdvanceTimer, paused,
  profile, settings, replays, recording, lastSettle,
  replayCtx, rpUI, lanRooms, lanScanning, session, autoAdvancing,
  lanInfo, lanManualError, difficulty, HOME_ASSET_URL,
  recordingSeed, recordingDeck,
};