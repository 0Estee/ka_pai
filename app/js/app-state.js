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

import { DEFAULT_DIFFICULTY } from './ai.js';

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
/** 设置（主题 / AI 难度） */
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
/**
 * 本局玩法模式：'normal' = 普通模式，'forge' = 强化模式。
 *
 * 作者 2026-10-17 口径：**强化是单独一个模式，和普通模式分开**。
 * 普通模式完全不读强化/精通（双方都是卡面原值），只有从「强化模式」入口
 * 开的局才把档案里的增量交给引擎 —— 这样两套玩法分开，强化不会偷偷影响
 * 普通模式的手感与平衡数据。联机时以**主机**为准（模式随开局参数广播）。
 */
let playMode = 'normal';
/**
 * 本局选择的阵营（超能力系统，见 engine/src/factions.js）。
 * 作者 2026-10-03 的规则：对局开始前自选，本局可用该阵营的超能力。
 * 这里只是进难度页之前的初值，玩家一选就被 render.js 的 setFaction 覆盖。
 */
let myFaction = 'demon';

/** 本地资产首页。联机模式下「退出房间」要回到它（见 quitRoom）。 */
const HOME_ASSET_URL = 'file:///android_asset/index.html';

let recordingSeed = 0;
let recordingDeck = [];
/** 联机开局时主机广播过来的双方阵营（客人要靠它录回放） */
let recordingFactions = [];
/** 联机开局时主机广播过来的双方强化增量表（客人要靠它录回放） */
let recordingEnhance = null;

export {
  AI, me, foe, foeName, canAnswerChoice,
  screen, state, view, bannerTimer, autoAdvanceTimer, paused,
  profile, settings, replays, recording, lastSettle,
  replayCtx, rpUI, lanRooms, lanScanning, session, autoAdvancing,
  lanInfo, lanManualError, difficulty, myFaction, playMode, HOME_ASSET_URL,
  recordingSeed, recordingDeck, recordingFactions, recordingEnhance,
};