/**  阵营与超能力（作者 2026-10-03 的规则补充） */
import { api, check, elements } from './harness.mjs';

console.log('\n 阵营与超能力');

const stage = () => elements.get('stage').innerHTML;

/** 从首页走真实路由开一局（阵营取当前选中的那一个） */
function freshGame() {
  api.__go('home');
  api.__nav('choose-ai', {});
  api.__nav('start-ai', {});
  api.__pause(true);
  return api.__game();
}

check('难度页能选阵营，选中的阵营带进对局，双方各抽一张超能力', () => {
  api.__go('home');
  api.setDifficulty('normal');
  api.__nav('choose-ai', {});
  if (!stage().includes('data-act="set-faction"')) throw new Error('难度页没有阵营可选项');
  api.__nav('set-faction', { key: 'demon' });
  api.__nav('start-ai', {});
  api.__pause(true);
  const st = api.__game();
  if (!st) throw new Error('选完阵营没能开局');
  for (const p of st.players) {
    if (p.faction !== 'demon') throw new Error('阵营没写进对局：side ' + p.side + ' = ' + p.faction);
    const list = p.superpowers || [];
    if (list.length !== 1) throw new Error('开局应当各抽 1 张超能力，side ' + p.side + ' 实际 ' + list.length);
    const id = list[0];
    const def = st.cardLib[id];
    if (!def || def.faction !== 'demon') throw new Error('抽到的不是本阵营超能力：' + id);
    if (def.token) throw new Error('令牌不该被抽到：' + id);
    if (!p.hand.some((hc) => hc.cardId === id)) throw new Error('抽到的超能力没进手牌：' + id);
  }
});

check('超能力在手牌上有持久标记（开局那张没有「出牌」时刻，靠它提示玩家）', () => {
  api.refresh();
  const html = stage();
  if (!html.includes('is-superpower')) throw new Error('手牌里没有超能力的高亮标记');
  if (!html.includes('超能力</div>')) throw new Error('手牌里没有「超能力」角标');
});

check('恶魔阵营：结束阶段左边出现「献祭」按钮；不是阵营方就没有', () => {
  const st = freshGame();
  if (!api.__place(0, 'U242', 'mountain', 'front')) throw new Error('没能摆上自己的单位');
  api.refresh();
  if (!stage().includes('data-act="sac"')) throw new Error('恶魔阵营没出现献祭按钮（phase=' + st.phase + '）');
  const fac = st.players[0].faction;
  st.players[0].faction = null;
  api.refresh();
  if (stage().includes('data-act="sac"')) throw new Error('非阵营方也出现了献祭按钮（对照失败）');
  st.players[0].faction = fac;
  api.refresh();
});

check('献祭：点「献祭」再点自己的单位 -> 真的被消灭、进弃牌堆、录进回放', () => {
  const st = freshGame();
  const before = api.__recordingActions().filter((a) => a.k === 'x').length;
  const foe = api.__place(1, 'U242', 'plainR', 'front');
  const mine = api.__place(0, 'U242', 'mountain', 'front');
  if (!mine || !foe) throw new Error('献祭场景没摆好');
  api.refresh();
  if (!stage().includes('data-act="sac"')) throw new Error('献祭场景里没有献祭按钮');
  // 先点对手的单位：不该生效、也不该记一条动作
  api.__nav('sac', {});
  api.__tapUnit(foe.uid);
  if (!api.__game().board.plainR.units[1].front) throw new Error('献祭模式里点对手的单位竟然生效了');
  if (api.__recordingActions().filter((a) => a.k === 'x').length !== before) throw new Error('点对手的单位也记了一条献祭');
  // 再点自己的：应当被消灭
  api.__nav('sac', {});
  api.__tapUnit(mine.uid);
  const after = api.__game();
  if (after.board.mountain.units[0].front) throw new Error('献祭之后自己的单位还在场上');
  if (!after.discard.includes('U242')) throw new Error('被献祭的单位没进弃牌堆');
  if (api.__recordingActions().filter((a) => a.k === 'x').length !== before + 1) {
    throw new Error('献祭没录进回放（回放/联机都会错位）');
  }
});

// 留一个干净局面给后面的检查
api.__pause(false);
api.__go('home');
api.__newGame();