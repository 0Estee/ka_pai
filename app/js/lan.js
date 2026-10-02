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
import * as Eco from './economy.js';
import * as RP from './replay.js';
import { TEST_CARD_LIB, buildTestDeck } from '../../engine/cards/test-cards.js';

/** 进入联机大厅并建立会话 */
function enterLobby(mode) {
  lanInfo = {
    roomName: Net.queryParam('room') || '未命名房间',
    port: Number(globalThis.location.port) || 8765,
    peerName: '',
    status: 'connected',
    gameReady: false,
  };

  session = new Net.Session({
    who: mode,
    cardLib: TEST_CARD_LIB,
    onUpdate: () => { refresh(); if (screen === 'game') tick(); },
    onStatus: (s) => {
      lanInfo.status = s;
      if (s === 'closed') lanInfo.peerName = lanInfo.peerName; // 保留名字，界面显示「对方已离开」
      refresh();
    },
    onStart: (st) => {
      // 两端各自建立同一个对局，并从此刻开始录制回放
      state = st;
      view = makeView();
      recording = RP.newRecording({
        seed: recordingSeed, firstPlayer: st.firstPlayer, deck: recordingDeck,
        cardSet: RP.cardSetId(TEST_CARD_LIB),
      });
      lanInfo.gameReady = true;
      screen = 'game';
      refresh();
      tick();   // 联机开局后同样要启动回合循环（主机负责推进自动阶段）
    },
    onAction: (action) => {
      RP.recAction(recording, action);
      if (state && state.winner !== null) settleIfNeeded();
    },
  });

  // 开局参数由主机生成，客人从 start 消息里拿到，这里先记下来给 onStart 用
  session.onSeedDeck = (seed, firstPlayer, deck) => {
    recordingSeed = seed; recordingDeck = deck;
  };

  session.start();
  session.transport.send({ t: 'hello', name: isHostName() });
  screen = 'lobby';
  refresh();
}

function isHostName() {
  return Net.netMode() === 'host' ? '主机' : '客人';
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

/** 手动连接：读输入框 → 校验 → 导航过去 */
function joinByManualAddress() {
  const el = document.getElementById('lan-manual-ip');
  const addr = normalizeHostInput(el && el.value);
  if (!addr) {
    lanManualError = '地址看起来不对。应该是 192.168.x.x 或 192.168.x.x:8765 这样的形式。';
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
 * 创建房间：让原生层起 HTTP + UDP 服务，然后把 WebView 导航过去。
 * 导航之后页面会**重新加载**（这次是从 http://127.0.0.1:port 加载），
 * 所以这里不需要保留任何内存状态 —— 房间在 Java 侧活着。
 */
function createRoom() {
  const room = randomRoomName();
  const r = Net.startHost(room, '主机');
  if (!r || !r.ok) {
    view.hint = (r && r.error) || '无法创建房间';
    refresh();
    return;
  }
  Net.navigateTo(r.url);
}

/** 扫描同一 Wi-Fi 下的房间 */
function scanLanRooms() {
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
  lanInfo.gameReady = true;
  await session.beginGame({ seed, firstPlayer: seed % 2, deck });
}

/** 退出房间：告诉对方、停服务、回首页 */
async function quitRoom() {
  if (session) {
    await session.leave();
    session = null;
  }
  if (Net.netMode() === 'host') Net.stopHost();

  // 联机时页面是从主机的 HTTP 服务加载的，回「首页」只能重新加载本地资产页。
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
  randomRoomName, createRoom, scanLanRooms, hostStartMatch, quitRoom,
};
