/** § 联机「重新开局」（作者 2026-10-22 第 2 条）+ 靶场工具条 */
import fsx from 'node:fs';
import path from 'node:path';
import { api, check, timers, ROOT } from './harness.mjs';

console.log('\n§ 联机重新开局 / 靶场工具条');

/**
 * ⚠ 这一节全部用**同步** check。
 *
 * 假会话（__demoLanStart）的 beginGame 是同步建局的，所以「按一下重新开局」
 * 之后状态已经换好了，不需要 await —— 而一旦写成 await，这一节就会在
 * 「假会话还装着」的时候把控制权交出去，后面所有单机用例都会按联机语义跑，
 * 报出一串看起来毫无关系的失败（实测：战斗特效那两条当场变红）。
 */

check('房主按「重新开局」：重新算一份开局参数并广播 start（带 r:1），两边各自重建对局', () => {
  // 联机要金币 > 0（作者裁决：联机没有保底），先把钱包填上再重开
  const prof = api.__profile();
  const keepGold = prof.gold;
  prof.gold = Math.max(prof.gold, 100);
  try {
    const before = api.__demoLanStart();
    if (before.screen !== 'game') throw new Error('没能进联机对局');
    const oldState = api.__game();
    api.__nav('restart', {});
    const st = api.__game();
    if (st === oldState) throw new Error('「重新开局」没有重建对局（state 还是原来那一份）');
    if (api.__screen() !== 'game') throw new Error('重开之后应该还留在对局屏');
    if (!st || !st.players || st.winner !== null) throw new Error('重开出来的不是一局新棋');
    if (st.phase !== 'TURN_START') throw new Error('重开应该停在开局那一刻，实际 ' + st.phase);
  } finally {
    prof.gold = keepGold;
    timers.clear();
    api.__demoLanEnd();
    timers.clear();
  }
});

check('客人按「重新开局」：只发一条 restart-req，不自己开局（参数只能由房主算）', () => {
  try {
    api.__demoLanStart({ mySide: 1 });
    const oldState = api.__game();
    api.__nav('restart', {});
    if (api.__game() !== oldState) throw new Error('客人不该自己重开（两端各算一份一定分叉）');
  } finally {
    timers.clear();
    api.__demoLanEnd();
    timers.clear();
  }
});

check('协议里认这两种消息：start 的 r:1（重开）与 restart-req（客人请求）', () => {
  const src = fsx.readFileSync(path.join(ROOT, 'app', 'js', 'multiplayer.js'), 'utf8');
  if (!/case 'start':[\s\S]{0,160}msg\.r !== 1/.test(src)) {
    throw new Error('start 没有区分「首次开局」与「重开」：客人会一直停在上一局');
  }
  if (!src.includes("case 'restart-req'")) throw new Error('没有 restart-req 分支：客人按重开没人接');
  if (!src.includes('onRestartRequest')) throw new Error('房主那侧没有收到重开请求的回调');
});

check('靶场工具条：换边 / 换阵营 / 换难度 / AI 开关 / 加牌 / 清空都真的改了状态', () => {
  api.__sandbox();
  timers.clear();
  const st = api.__game();
  // 换边：只换「我在打哪一边」
  const side0 = api.__me();
  api.__nav('sb-side', {});
  if (api.__me() === side0) throw new Error('「控制玩家1/2」没有切过去');
  api.__nav('sb-side', {});
  if (api.__me() !== side0) throw new Error('切回来失败了');

  // 换阵营：阵营真的变了，而且新阵营的超能力立刻到手
  const f0 = st.players[side0].faction;
  api.__nav('sb-faction-mine', {});
  const f1 = api.__game().players[side0].faction;
  if (f1 === f0) throw new Error('我方阵营没有切换');
  const want = Object.keys(st.cardLib).filter((id) => {
    const c = st.cardLib[id];
    return c && c.faction === f1 && !c.token && !c.legacy;
  });
  const have = api.__game().players[side0].hand
    .filter((hc) => st.cardLib[hc.cardId].faction === f1).map((hc) => hc.cardId);
  for (const id of want) {
    if (have.indexOf(id) < 0) throw new Error('换阵营后没有补发 ' + id);
  }

  // 换难度
  const beforeD = api.__settings().difficulty;
  api.__nav('sb-difficulty', {});
  if (api.__settings().difficulty === beforeD) throw new Error('难度没有切换');

  // AI 开关
  const ai0 = api.__view().sandboxAI;
  api.__nav('sb-ai', {});
  if (api.__view().sandboxAI === ai0) throw new Error('AI 开关没反应');
  api.__nav('sb-ai', {});

  // 加牌：面板打开 → 点一张 → 手牌多一张
  const hand0 = api.__game().players[side0].hand.length;
  api.__nav('sb-add', {});
  if (!api.__view().pickOpen) throw new Error('「加牌」没有打开面板');
  const pickId = Object.keys(st.cardLib).find((id) => !st.cardLib[id].legacy && st.cardLib[id].type === 'unit' && !st.cardLib[id].faction);
  api.__nav('sb-give', { id: pickId });
  if (api.__game().players[side0].hand.length !== hand0 + 1) throw new Error('加牌没进手牌');
  api.__nav('sb-pick-close', {});

  // 清空场地
  api.__nav('sb-clear', {});
  for (const lane of ['mountain', 'plainL', 'plainR', 'water']) {
    for (const side of [0, 1]) {
      for (const row of ['front', 'back']) {
        if (api.__game().board[lane].units[side][row]) throw new Error('清空场地后还有单位：' + lane);
      }
    }
  }
  timers.clear();
});

check('开始游戏菜单里有「靶场」入口，点了就进对局（且是靶场而不是普通 AI 局）', () => {
  api.__go('home');
  api.__nav('start-game', {});
  api.__nav('start-sandbox', {});
  const st = api.__game();
  if (api.__screen() !== 'game') throw new Error('点「靶场」没有进对局');
  if (!st || !st.sandbox) throw new Error('进来的不是靶场（state.sandbox 没开）');
  timers.clear();
});
