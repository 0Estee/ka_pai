/**
 * 局域网联机：进入大厅并建立会话、主机地址规范化与手动连接、
 * 开房 / 扫描房间 / 房间内开局 / 退出房间。
 *
 * 与 app/js 其它模块共享同一个打包作用域（见 tools/build-web.mjs）：
 * screen/state/view/session/profile/lanRooms/lanScanning/lanInfo/lanManualError/
 * recordingSeed/recordingDeck/HOME_ASSET_URL 等共享状态直接按裸名字读写，
 * 以及 refresh/tick/makeView/settleIfNeeded/goHome 等同作用域函数，都不需要 import。
 */

import * as Net from './multiplayer.js';
import * as Cloud from './cloud.js';
import * as Eco from './economy.js';
import * as Enh from './enhance.js';
import * as RP from './replay.js';
import { TEST_CARD_LIB, buildTestDeck } from '../../engine/cards/test-cards.js';

/**
 * 联机里的显示名：登录了就用账号名，没登录就按座位叫玩家1 / 玩家2。
 * 作为 hello 的 name 发给对面，双方大厅和对局顶栏都用这一份。
 */
function lanPlayerName(mode) {
  try {
    const c = Cloud.cloudStatus();
    if (c && c.user && c.user.username) return String(c.user.username);
  } catch { /* 云存档没初始化：退回座位名 */ }
  return mode === 'host' ? '玩家1' : '玩家2';
}

/** 进入联机大厅并建立会话 */
function enterLobby(mode) {
  const room = Net.currentRoom();
  const myName = lanPlayerName(mode);
  lanInfo = {
    roomName: Net.queryParam('room') || '未命名房间',
    port: Number(globalThis.location.port) || 8765,
    peerName: '',
    myName,
    discoverError: Net.queryParam('discover') === '0' ? '房间已开，但 UDP 发现端口被占用：对方扫不到，只能手输地址' : '',
    status: 'connected',
    gameReady: false,
    // 公网房间：链接是 `站点/?net=guest&room=CODE`，局域网则是 `主机IP:端口/?net=guest`
    online: Net.onlineAvailable(),
    joinUrl: room && Net.onlineAvailable()
      ? `${Net.siteBase()}/?net=guest&room=${room}`
      : '',
    code: room,
  };

  session = new Net.Session({
    who: mode,
    room,
    cardLib: TEST_CARD_LIB,
    onUpdate: () => { refresh(); if (screen === 'game') tick(); },
    onStatus: (s) => {
      lanInfo.status = s;
      refresh();
    },
    onStart: (st) => beginLanMatch(st),
    onAction: (action) => {
      // 收到 start 之前就到达的操作（高延迟下的抢跑）也会走到这里，
      // 那时录制还没建好，别在这里炸掉整局。
      if (recording) RP.recAction(recording, action);
      if (state && state.winner !== null) settleIfNeeded();
    },
  });

  // 开局参数由主机生成，客人从 start 消息里拿到，这里先记下来给 onStart 用
  session.onSeedDeck = (seed, firstPlayer, deck, factions, enhance) => {
    recordingSeed = seed; recordingDeck = deck;
    recordingFactions = (factions || []).slice();
    recordingEnhance = Array.isArray(enhance) ? enhance.map((side) => ({ ...(side || {}) })) : null;
  };

  session.start();
  // 进房间就报一次自己的阵营：主机开局要按两边各自的阵营建局（作者 2026-10-05）
  // 顺便把自己的强化增量报过去：主机开局要把它写进 enhance（见 hostStartMatch）
  session.transport.send({
    t: 'hello',
    name: myName,
    faction: myFaction,
    enhance: Enh.buildSideEnhance(TEST_CARD_LIB, profile),
    // 大厅要提示「两边是不是同一个模式」：不一致时以主机为准，提前让客人知道
    forge: playMode === 'forge',
  });
  screen = 'lobby';
  refresh();
}

function isHostName() {
  return lanPlayerName(Net.netMode() === 'host' ? 'host' : 'guest');
}

/**
 * 收到 start、正式开局那一刻要做的事（主机与客人共用这一条路径）。
 *
 * ⚠ 这里的第一件事必须是 `resetTurnLoop()`。单机开局走 `newGame()`，
 * 那里已经清过回合循环的定时器与 `autoAdvancing`；联机开局走的是这里，
 * 漏了这份清理就会出现 —— 上一局在自动阶段被退出（`autoAdvancing` 停在 true），
 * 新对局 tick() 直接撞上 `if (autoAdvancing) return;`，整个回合循环不启动：
 * 界面显示「回合开始…」、`busy` 恒为 true，**玩家点牌没有任何反应**
 * （作者 2026-10 报的「联机开始后无法出牌」就是这个）。
 */
function beginLanMatch(st) {
  // 模式以主机为准：客人是通过 URL 进房的，本地默认是普通模式，
  // 必须按广播过来的这一份切换，否则界面说一套、引擎跑另一套。
  playMode = session && session.mode === 'forge' ? 'forge' : 'normal';
  resetTurnLoop();
  // 两端各自建立同一个对局，并从此刻开始录制回放
  state = st;
  view = makeView();
  recording = RP.newRecording({
    seed: recordingSeed, firstPlayer: st.firstPlayer, deck: recordingDeck,
    cardSet: RP.cardSetId(TEST_CARD_LIB),
    // 双方阵营由主机广播过来（见 hostStartMatch），不带上客人那侧重建不出超能力
    factions: recordingFactions,
    // 双方强化增量同理：随 start 一起广播下来，两端必须用同一份
    enhance: recordingEnhance,
  });
  lanInfo.gameReady = true;
  screen = 'game';
  refresh();
  tick();   // 联机开局后同样要启动回合循环（主机负责推进自动阶段）
}

/**
 * 把玩家输入的主机地址规范化成 `host:port`。
 *
 * 玩家会怎么输都说不准：`192.168.1.7`、`192.168.1.7:8765`、
 * `http://192.168.1.7:8765/`、带空格的……都得认。
 * 认不出来返回空字符串（由调用方提示，不静默失败）。
 */
function normalizeHostInput(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^[a-zA-Z]+:\/\//, '');   // 去掉 http:// / https://
  s = s.replace(/[/?#].*$/, '');          // 去掉路径、查询、锚点
  s = s.trim();
  const m = s.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/);
  if (!m) return '';
  const parts = m[1].split('.').map(Number);
  if (parts.some((n) => n < 0 || n > 255)) return '';
  const port = m[2] ? Number(m[2]) : 8765;   // 协议默认端口，和主机服务端一致
  if (!(port >= 1 && port <= 65535)) return '';
  return `${m[1]}:${port}`;
}

/**
 * 手动连接。
 *
 * 两种输入都要认，因为玩家手里可能只有其中一种：
 *  · **房间号**（公网）：`K7QM2P`，或整条链接 `https://…/?net=guest&room=K7QM2P`；
 *  · **主机地址**（局域网）：`192.168.1.7` 或 `192.168.1.7:8765`。
 *
 * 先试房间号：如果当前页面本身就是公网站点，那就是在同一站点里换个房间号。
 */
function joinByManualAddress() {
  const el = document.getElementById('lan-manual-ip');
  const raw = String((el && el.value) || '');
  const code = Net.roomCode(raw);

  if (code && Net.onlineAvailable()) {
    lanManualError = '';
    const target = `${Net.siteBase()}/?net=guest&room=${code}`;
    try {
      globalThis.location.href = target;
      return;
    } catch {
      lanManualError = '浏览器不允许跳转，请手动打开：' + target;
      refresh();
      return;
    }
  }

  const addr = normalizeHostInput(raw);
  if (!addr) {
    lanManualError = '没看懂这个输入。公网填房间号（例如 K7QM2P），局域网填 192.168.x.x 或 192.168.x.x:8765。';
    refresh();
    return;
  }
  lanManualError = '';
  Net.navigateTo(`http://${addr}/?net=guest`);
}

// ══════════════════════════════════════════════════════════
// 局域网：开房 / 扫描 / 开局 / 退出
// ══════════════════════════════════════════════════════════

function randomRoomName() {
  return `房间-${Math.floor(Math.random() * 9000 + 1000)}`;
}

/**
 * 创建房间。
 *
 * 两种宿主，一条入口：
 *  · **公网（Cloudflare）**：房间号当场生成，把页面导航到 `?net=host&room=CODE`。
 *    服务端不用预热 —— 房间对象是第一次收到请求时按房间号建出来的。
 *  · **局域网（APK）**：让原生层起 HTTP + UDP 服务，再导航过去。
 *    导航之后页面会**重新加载**（这次是从 http://127.0.0.1:port 加载），
 *    所以这里不需要保留任何内存状态 —— 房间在 Java 侧活着。
 */
function createRoom() {
  const online = Net.onlineAvailable();
  const code = Net.newRoomCode();
  const room = randomRoomName();

  if (online) {
    // 公网：不经过原生层，直接换成带房间号的地址。location 会重载，房间在服务端。
    const target = `${Net.siteBase()}/?net=host&room=${code}`;
    try {
      globalThis.location.href = target;
      return;
    } catch {
      view.hint = '浏览器不允许跳转，请手动打开这个地址：' + target;
      refresh();
      return;
    }
  }

  const r = Net.startHost(room, lanPlayerName('host'));
  if (!r || !r.ok) {
    view.hint = (r && r.error) || '无法创建房间';
    refresh();
    return;
  }
  Net.navigateTo(r.url);
}

/** 扫描同一 Wi-Fi 下的房间 */
function scanLanRooms() {
  // 公网站点没有原生桥：UDP 局域网扫描永远是空列表。
  // 不要再等 1.5 秒给玩家看「找到 0 个房间」—— 直接进「输入房间号」。
  if (!Net.nativeAvailable()) {
    lanScanning = false;
    lanRooms = [];
    screen = 'lanScan';
    refresh();
    return;
  }

  lanScanning = true;
  lanRooms = [];
  screen = 'lanScan';
  refresh();

  // 扫描会阻塞 1.5 秒（走原生桥），延到下一帧再做，先让「正在扫描」画出来
  setTimeout(() => {
    lanRooms = Net.scanRooms(1500);
    lanScanning = false;
    refresh();
  }, 50);
}

/** 主机点「开始对战」：生成开局参数并广播 */
async function hostStartMatch() {
  if (!session || !session.isHost) return;
  // 联机需要金币 > 0（作者裁决：联机没有保底，归零后只能去打 AI 赚回来）。
  // 这里再挡一道，因为按钮的 disabled 只在渲染时生效，挡不住别处调用。
  if (!Eco.canPlayPvp(profile)) {
    view.hint = `金币为 ${profile.gold}，不能和真人对决。先去打 AI 赚金币吧。`;
    refresh();
    return;
  }
  const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  const deck = buildTestDeck(80, seed);
  recordingSeed = seed;
  recordingDeck = deck;
  /**
   * 双方的强化增量：我这侧来自档案，对手那侧来自它进房时报的 hello。
   *
   * 必须先算好再广播 —— 客人的本地档案只对**它自己那一侧**有效，
   * 主机这边要模拟对手的牌，就必须拿到对手的增量表（反之亦然）。
   */
  // 普通模式不读强化：双方都是卡面原值（作者 2026-10-17 的分模式口径）。
  const forgeMode = playMode === 'forge';
  const enhance = forgeMode
    ? [
      Enh.buildSideEnhance(TEST_CARD_LIB, profile),
      (session.peerEnhance && typeof session.peerEnhance === 'object') ? session.peerEnhance : {},
    ]
    : null;
  recordingEnhance = enhance;
  lanInfo.gameReady = true;
  /**
   * 两边各自的阵营（作者 2026-10-05：「联机选不了阵营」）。
   *
   * 以前这里两边都传主机的 myFaction  客人根本没有机会选，而且
   * 就算他在自己的机器上选了，主机也不知道。现在客人的阵营通过
   * hello / faction 消息报过来（见 multiplayer.js）。拿不到就退回主机自己的。
   */
  const guestFaction = session.peerFaction || myFaction;
  try {
    await session.beginGame({
      seed,
      // 联机固定主机（玩家1）先手、客人（玩家2）后手 —— 界面上的「玩家1（先手）」
      // 与座位一致，不用再让玩家算「我这个座位是先手还是后手」。
      firstPlayer: 0,
      deck,
      factions: [myFaction, guestFaction],
      enhance,
      mode: forgeMode ? 'forge' : 'normal',
    });
  } catch (err) {
    // start 没发出去就**不要**开打：只会有一个人在这局里跑（见 multiplayer.js 的
    // beginGame 注释）。留在大厅，让玩家重来一次。
    lanInfo.gameReady = false;
    view.hint = '开局失败：' + ((err && err.message) || '连不上房间服务，请重试');
    refresh();
  }
}

/** 退出房间：告诉对方、停服务、回首页 */
async function quitRoom() {
  // 退出房间要把回合循环也停掉：不然 autoAdvancing 会停在 true，
  // 下一次联机开局就会一直卡在「回合开始…」（见 beginLanMatch 的说明）。
  resetTurnLoop();
  if (session) {
    await session.leave();
    session = null;
  }
  if (Net.netMode() === 'host') Net.stopHost();

  const online = Net.onlineAvailable();

  // 公网房间：首页就是同一个站点的根路径，换过去即可（房间号从 URL 上消失，
  // 服务端那边的房间两小时没人说话会自己回收）。
  if (online) {
    try {
      globalThis.location.href = `${Net.siteBase()}/`;
      return;
    } catch { /* 非浏览器环境，往下走 goHome() */ }
  }

  // 局域网：页面是从主机的 HTTP 服务加载的，回「首页」只能重新加载本地资产页。
  //
  // ⚠️ 必须走**原生桥**去导航，不能自己改 location.href：
  //    http 源**不允许**跳到 file://（WebView 会把 local resource 拦掉，且是静默的），
  //    所以 `location.href = 'file:///android_asset/index.html'` 什么都不会发生 ——
  //    表现就是「创建完房间之后回不了首页」。
  //    原生侧 loadUrl 不受这条同源限制（见 NativeBridge.navigate）。
  if (Net.netMode()) {
    if (Net.navigateTo(HOME_ASSET_URL)) return;
    // 没有原生桥（比如桌面浏览器里跑开发服务器）：退回直接跳转
    try {
      globalThis.location.href = HOME_ASSET_URL;
      return;
    } catch { /* 非浏览器环境，往下走 goHome() */ }
  }

  goHome();
}

export {
  enterLobby, isHostName, normalizeHostInput, joinByManualAddress,
  randomRoomName, createRoom, scanLanRooms, hostStartMatch, beginLanMatch, quitRoom,
};
