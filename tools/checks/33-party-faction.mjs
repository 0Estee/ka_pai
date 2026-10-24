/**  派对阵营（作者 2026-10-11 的第四批超能力） */
import { api, check, elements } from './harness.mjs';

const NL = String.fromCharCode(10);
console.log(NL + ' 派对阵营');

const stage = () => elements.get('stage').innerHTML;

const IDS = ['U462', 'U463', 'U464', 'U465', 'U466'];
const TOKEN_IDS = ['U466'];

/** 从首页走真实路由，用指定阵营开一局 AI 对局 */
function aiGame(key) {
  api.__go('home');
  api.setDifficulty('normal');
  api.__nav('choose-ai', {});
  api.__nav('set-faction', { key });
  api.__nav('start-ai', {});
  api.__pause(true);
  return api.__game();
}

check('难度页能选派对，卡库里有 5 张派对牌（只有气球是令牌）', () => {
  api.__go('home');
  api.setDifficulty('normal');
  api.__nav('choose-ai', {});
  const html = stage();
  if (!html.includes('data-act="set-faction"')) throw new Error('难度页没有阵营可选项');
  const rows = (html.match(/data-act="set-faction"/g) || []).length;
  // 2026-10-24 加了心驭 → 13 个
  if (rows !== 13) throw new Error('难度页阵营选项应当是 13 个（旧阵营 + 炼金 + 三阵营 + 派对 + 炎帝 + 心驭），实际 ' + rows);
  if (!html.includes('data-key="party"')) throw new Error('难度页里没有派对阵营');

  const st = aiGame('party');
  if (!st) throw new Error('选完派对没能开局');
  const missing = IDS.filter((id) => !st.cardLib[id]);
  if (missing.length) throw new Error('卡库里缺派对牌：' + missing.join(' '));
  for (const id of IDS) {
    const want = TOKEN_IDS.indexOf(id) >= 0;
    if (!!st.cardLib[id].token !== want) throw new Error(id + ' 的令牌标记不对：token=' + !!st.cardLib[id].token);
    if (st.cardLib[id].faction !== 'party') throw new Error(id + ' 的阵营不是 party');
  }
  for (const p of st.players) {
    // 与 AI 对战时 AI 的阵营随机（作者 2026-10-11）：只有我方（side 0）等于所选阵营。
    if (p.side === 0 && p.faction !== 'party') throw new Error('我方阵营没写进对局 side 0 = ' + p.faction);
    if (!p.faction) throw new Error('side ' + p.side + ' 没有阵营');
    const list = p.superpowers || [];
    if (list.length !== 1) throw new Error('开局应当各抽 1 张超能力，side ' + p.side + ' 实际 ' + list.length);
    if (st.cardLib[list[0]].token) throw new Error('令牌不该被超能力池抽到 ' + list[0]);
  }
});

check('派对整局自走能终局，不卡死（小丑会中途「立即进入下个回合」）', () => {
  aiGame('party');
  api.__pause(false);
  const r = api.__autoPlay(2000);
  if (r && r.error) throw new Error('自走失败 ' + r.error);
  if (r && r.stalled) throw new Error('自走没能结束（卡住了）');
  const st = api.__game();
  if (!st || st.winner === null) throw new Error('整局自走没有结果');
});

check('与 AI 对战时 AI 的阵营随机：连开 10 局，AI 阵营不止一种', () => {
  const seen = new Set();
  for (let i = 0; i < 10; i++) {
    const st = aiGame('party');
    if (!st) throw new Error('第 ' + i + ' 局没能开局');
    if (st.players[0].faction !== 'party') throw new Error('我方阵营没写进对局');
    seen.add(st.players[1].faction);
  }
  if (seen.size < 2) throw new Error('连开 10 局 AI 阵营都是 ' + [...seen].join('/') + '，没有随机');
});

// 留一个干净局面给后面的检查
api.__pause(false);
api.__go('home');
api.__newGame();
