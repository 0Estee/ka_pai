/**
 * 两件事（作者 2026-10-28）：
 *
 *  1. **回放可以看对方视角** —— 回放播放时顶栏要能翻到对手那一侧，
 *     翻过去之后单步 / 播放都不能被弹回来。
 *  2. **强化联机创建房间不能显示普通数值** —— 开房会重新加载页面，
 *     `playMode` 是内存变量，不带进 URL 就一定退回普通模式；
 *     大厅那一行「房间模式」因此写着「普通模式（卡面原值）」，
 *     开局时 `enhance` 也算成 null，双方都用卡面原值。
 */
import fs from 'node:fs';
import path from 'node:path';
import { api, elements, check, ROOT } from './harness.mjs';

const stage = () => elements.get('stage').innerHTML;
const btnLabel = (html) => (html.match(/data-act="watch-side">([^<]*)</) || [])[1] || '';
const rows = (html) => (html.match(/row-label">([^<]*)</g) || []).map((s) => s.replace(/.*">/, ''));

console.log('\n§ 回放换视角 / 强化联机模式');

/* ── 回放换视角 ───────────────────────────────────────────── */

let hasReplay = false;
api.__go('home');
api.setDifficulty('normal');
api.__nav('choose-ai', {});
api.__nav('start-ai', {});
api.__autoPlay();
hasReplay = api.__replays().length > 0;

check('回放播放页顶栏有「视角」按钮，默认按「你」的视角看', () => {
  if (!hasReplay) throw new Error('没有可用回放，这条用例不成立');
  const d = api.__replayDemo(0, 12);
  if (d.error) throw new Error(d.error);
  const html = stage();
  if (!html.includes('data-act="watch-side"')) throw new Error('回放顶栏没有「视角」按钮');
  if (btnLabel(html) !== '视角：你') throw new Error('默认视角标签不是「视角：你」，拿到：' + btnLabel(html));
  // 行标签要按名字标，不能是「我 / 敌」—— 切过去以后「我」就跟名字打架了
  const r = rows(html).join('|');
  if (/我|敌/.test(r)) throw new Error('回放的行标签还是「我 / 敌」：' + r);
  if (!r.includes('你 前排') || !r.includes('对手 前排')) throw new Error('行标签没按「你 / 对手」标：' + r);
});

check('点「视角」翻到对手那一侧：上下半场对调，说明文字跟着换', () => {
  const before = stage();
  api.__nav('watch-side', {});
  const after = stage();
  if (after === before) throw new Error('点了视角，画面一模一样 —— 棋盘没翻过来');
  if (btnLabel(after) !== '视角：对手') throw new Error('翻过去之后按钮还是：' + btnLabel(after));
  const r = rows(after).join('|');
  // 下半场（后来的那两行）现在应当是「对手」
  const lower = r.split('|').slice(-2).join('|');
  if (!lower.includes('对手')) throw new Error('翻过去之后下半场不是对手：' + r);
});

check('翻过去之后单步 / 倒退都不会把视角弹回来', () => {
  const side = api.__view().humanSide;
  api.__nav('replay-next', {});
  if (api.__view().humanSide !== side) throw new Error('步进之后视角被弹回去了');
  api.__nav('replay-prev', {});
  if (api.__view().humanSide !== side) throw new Error('倒退之后视角被弹回去了');
  if (btnLabel(stage()) !== '视角：对手') throw new Error('步进之后按钮又变回：' + btnLabel(stage()));
});

check('重新打开一条回放 = 重新定一次初始视角（不会把上一条的视角带过来）', () => {
  api.__go('replays');
  api.__replayDemo(0, 5);
  if (api.__view().humanSide !== 0) throw new Error('重新打开后视角还是 ' + api.__view().humanSide);
  if (btnLabel(stage()) !== '视角：你') throw new Error('重新打开后按钮是：' + btnLabel(stage()));
});

/* ── 强化联机模式 ─────────────────────────────────────────── */

check('强化模式下开房的地址必须带 mode=forge（页面重载会把 playMode 冲掉）', () => {
  const q = api.__forgeModeQuery('forge');
  if (q !== '&mode=forge') throw new Error('强化模式没拼出 &mode=forge，拿到：' + JSON.stringify(q));
  const n = api.__forgeModeQuery('normal');
  if (n !== '') throw new Error('普通模式不该带 mode 参数，拿到：' + JSON.stringify(n));
});

check('源码级：开房 / 建房链接那一行真的把这个参数拼进去了', () => {
  // 只断言函数本身是对的还不够 —— 忘了在 createRoom 里调用一样是坏的
  const src = fs.readFileSync(path.join(ROOT, 'app', 'js', 'lan.js'), 'utf8');
  const start = src.indexOf('function createRoom()');
  if (start < 0) throw new Error('找不到 createRoom');
  const body = src.slice(start, start + 1600);
  if (!body.includes('forgeModeQuery()')) {
    throw new Error('createRoom 没有把 mode 拼进房间地址：强化房间重载后会退回普通模式');
  }
  if ((body.match(/forgeModeQuery\(\)/g) || []).length < 2) {
    throw new Error('createRoom 的公网 / 局域网两条路径都要带 mode=forge');
  }
  // 进大厅时要把模式读回来，否则带了参数也白带
  if (!/Net\.queryParam\('mode'\) === 'forge'/.test(src)) {
    throw new Error('enterLobby 没有从 URL 把 mode=forge 读回 playMode');
  }
});

check('大厅「房间模式」：主机按自己的 playMode，客人按主机 hello 报的那份', () => {
  // 主机在强化模式
  const hf = api.__demoLobby({ peer: '张三', playMode: 'forge' });
  if (!hf.forgeShown) throw new Error('主机在强化模式下，大厅却写着普通模式（作者 2026-10-28 报的 bug）');
  // 主机在普通模式（对照）
  const hn = api.__demoLobby({ peer: '张三', playMode: 'normal' });
  if (hn.forgeShown) throw new Error('普通模式的大厅写成了强化模式');
  // 客人本地没有模式信息：必须跟主机说的走
  const gf = api.__demoLobby({ peer: '张三', mode: 'guest', playMode: 'normal', peerForge: true });
  if (!gf.forgeShown) throw new Error('客人进强化房间，大厅却写着普通模式');
  const gn = api.__demoLobby({ peer: '张三', mode: 'guest', playMode: 'forge', peerForge: false });
  if (gn.forgeShown) throw new Error('主机是普通模式，客人却按本地残留的 forge 显示成强化');
});
