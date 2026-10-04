/**  召唤落点与上帝阵营（作者 2026-10-04：召唤时直接在场上的格子里选一个） */
import { api, check, elements } from './harness.mjs';

console.log('\n 召唤落点与上帝阵营');

const stage = () => elements.get('stage').innerHTML;

/** 从首页走真实路由开一局（阵营取当前选中的那一个） */
function freshGame(faction) {
  api.__go('home');
  api.setDifficulty('normal');
  api.__nav('choose-ai', {});
  if (faction) api.__nav('set-faction', { key: faction });
  api.__nav('start-ai', {});
  api.__pause(true);
  return api.__game();
}

check('难度页能选上帝阵营，选中的带进对局，双方各抽一张本阵营非令牌超能力', () => {
  api.__go('home');
  api.setDifficulty('normal');
  api.__nav('choose-ai', {});
  if (!stage().includes('data-act="set-faction"')) throw new Error('难度页没有阵营可选项');
  if (!stage().includes('data-key="god"')) throw new Error('难度页里没有上帝阵营');
  api.__nav('set-faction', { key: 'god' });
  api.__nav('start-ai', {});
  api.__pause(true);
  const st = api.__game();
  if (!st) throw new Error('选完阵营没能开局');
  for (const p of st.players) {
    if (p.faction !== 'god') throw new Error('阵营没写进对局：side ' + p.side + ' = ' + p.faction);
    const list = p.superpowers || [];
    if (list.length !== 1) throw new Error('开局应当各抽 1 张超能力，side ' + p.side + ' 实际 ' + list.length);
    const def = st.cardLib[list[0]];
    if (!def || def.faction !== 'god') throw new Error('抽到的不是本阵营超能力：' + list[0]);
    if (def.token) throw new Error('令牌不该被抽到：' + list[0]);
  }
});

check('传教（U403）：打出后挂起选落点，棋盘不被遮住，选完信徒落在那一格并录进回放', () => {
  freshGame('god');
  api.__demoHand(['U403']);
  const st = api.__game();
  const hc = st.players[0].hand.find((c) => c.cardId === 'U403');
  if (!hc) throw new Error('手牌里没有传教');
  api.selectCard(hc.iid);
  const live = api.__game();
  const rq = live.pending && live.pending.request;
  if (!rq || rq.type !== 'summonCell') throw new Error('打出传教没有挂起选落点（pending=' + (rq && rq.type) + '）');
  if (rq.side !== 0) throw new Error('挂起问的不是我方：side ' + rq.side);
  api.refresh();
  const html = stage();
  if (!html.includes('choice-bar')) throw new Error('没有渲染出选落点的格子条');
  if (html.includes('choice-mask')) throw new Error('选落点用了遮罩面板，会挡住棋盘点不到格子');
  if (!html.includes('choose-option')) throw new Error('格子条上没有可点的按钮');
  const idx = (rq.options || []).findIndex((o) => o.lane === 'plainL' && o.row === 'front');
  if (idx < 0) throw new Error('落点选项里没有 平地(左)-前排');
  const before = api.__recordingActions().filter((a) => a.k === 'c').length;
  api.__nav('choose-option', { idx });
  const after = api.__game();
  const u = after.board.plainL.units[0].front;
  if (!u || u.cardId !== 'U407') throw new Error('信徒没有落在选好的格子上');
  if (after.pending) throw new Error('选完落点还挂着请求：' + after.pending.request.type);
  const cs = api.__recordingActions().filter((a) => a.k === 'c');
  if (cs.length !== before + 1) throw new Error('选落点没录进回放（回放/联机都会错位）');
  const last = cs[cs.length - 1];
  if (!last.v || last.v.lane !== 'plainL' || last.v.row !== 'front') {
    throw new Error('录进回放的答案不是选中的格子：' + JSON.stringify(last));
  }
});

// 留一个干净局面给后面的检查
api.__pause(false);
api.__go('home');
api.__newGame();