/**  三阵营:炼狱 / 极寒 / 罪恶(作者 2026-10-10) */
import { api, check, elements } from './harness.mjs';

console.log('\n 三阵营(炼狱 / 极寒 / 罪恶)');

const stage = () => elements.get('stage').innerHTML;

const NEW_FACTIONS = [
  { key: 'inferno', name: '炼狱' },
  { key: 'frost', name: '极寒' },
  { key: 'sin', name: '罪恶' },
];

const NEW_IDS = ['U445', 'U446', 'U447', 'U448', 'U449', 'U450', 'U451', 'U452', 'U453', 'U454', 'U455', 'U456', 'U457', 'U458', 'U459', 'U460', 'U461'];
const NEW_TOKENS = ['U449', 'U450', 'U454', 'U455', 'U459'];

/** 走难度页的真实路由开一局(阵营取传进来的那个) */
function factionGame(key) {
  api.__go('home');
  api.setDifficulty('normal');
  api.__nav('choose-ai', {});
  api.__nav('set-faction', { key });
  api.__nav('start-ai', {});
  api.__pause(true);
  return api.__game();
}

check('难度页能选炼狱 / 极寒 / 罪恶,选中的阵营带进对局,双方各抽一张本阵营非令牌超能力', () => {
  api.__go('home');
  api.setDifficulty('normal');
  api.__nav('choose-ai', {});
  const html = stage();
  if (!html.includes('data-act="set-faction"')) throw new Error('难度页没有阵营可选项');
  const rows = (html.match(/data-act="set-faction"/g) || []).length;
  if (rows !== 10) throw new Error('难度页阵营选项应当是 10 个(7 个旧阵营 + 炼金 + 三阵营),实际 ' + rows);
  for (const f of NEW_FACTIONS) {
    if (!html.includes('data-key="' + f.key + '"')) throw new Error('难度页里没有' + f.name + '阵营');
    if (!html.includes(f.name)) throw new Error('难度页里没有' + f.name + '的名字');
  }
  for (const f of NEW_FACTIONS) {
    const st = factionGame(f.key);
    if (!st) throw new Error(f.name + ':选完阵营没能开局');
    for (const p of st.players) {
      if (p.faction !== f.key) throw new Error(f.name + ':阵营没写进对局 side ' + p.side + ' = ' + p.faction);
      const list = p.superpowers || [];
      if (list.length !== 1) throw new Error(f.name + ':开局应当各抽 1 张超能力,side ' + p.side + ' 实际 ' + list.length);
      const id = list[0];
      const def = st.cardLib[id];
      if (!def || def.faction !== f.key) throw new Error(f.name + ':抽到的不是本阵营超能力 ' + id);
      if (def.token) throw new Error(f.name + ':令牌不该被抽到 ' + id);
      if (!p.hand.some((hc) => hc.cardId === id)) throw new Error(f.name + ':抽到的超能力没进手牌 ' + id);
    }
  }
});

check('17 张新卡都在卡库里,5 张令牌标记正确,每个新阵营至少 4 张非令牌牌', () => {
  const st = factionGame('inferno');
  const missing = NEW_IDS.filter((id) => !st.cardLib[id]);
  if (missing.length) throw new Error('卡库里缺新卡:' + missing.join(' '));
  for (const id of NEW_IDS) {
    const want = NEW_TOKENS.indexOf(id) >= 0;
    if (!!st.cardLib[id].token !== want) throw new Error(id + ' 的令牌标记不对:token=' + !!st.cardLib[id].token);
  }
  for (const f of NEW_FACTIONS) {
    const n = NEW_IDS.filter((id) => st.cardLib[id].faction === f.key && !st.cardLib[id].token).length;
    if (n < 4) throw new Error(f.name + ' 只有 ' + n + ' 张非令牌牌(应当 >= 4)');
  }
});

check('三个新阵营各整局自走都能终局,不卡死', () => {
  for (const f of NEW_FACTIONS) {
    api.__go('home');
    api.setDifficulty('normal');
    api.__nav('choose-ai', {});
    api.__nav('set-faction', { key: f.key });
    api.__nav('start-ai', {});
    api.__pause(false);
    const r = api.__autoPlay(1500);
    if (r && r.error) throw new Error(f.name + ':自走失败 ' + r.error);
    if (r && r.stalled) throw new Error(f.name + ':自走没能结束(卡住了)');
    const st = api.__game();
    if (!st || st.winner === null) throw new Error(f.name + ':整局自走没有结果');
  }
});

// 留一个干净局面给后面的检查
api.__pause(false);
api.__go('home');
api.__newGame();