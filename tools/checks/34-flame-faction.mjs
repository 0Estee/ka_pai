/**  炎帝阵营（作者 2026-10-12 的第五批超能力：异火堆 + U467~U477） */
import { api, check, elements, ROOT } from './harness.mjs';
import fs from 'node:fs';

const NL = String.fromCharCode(10);
console.log(NL + ' 炎帝阵营');

const stage = () => elements.get('stage').innerHTML;

/** 异火（令牌、只能靠超能力效果获得） */
const FLAME_IDS = ['U467', 'U468', 'U469', 'U470', 'U471'];
/** 炎帝牌里不是异火的：U472 焰分噬浪尺 / U473 大天造化掌 / U474 焚决 / U475 天火三玄变 / U476 六合游身尺 / U477 佛怒火莲 */
const OTHER_IDS = ['U472', 'U473', 'U474', 'U475', 'U476', 'U477'];
const ALL_IDS = FLAME_IDS.concat(OTHER_IDS);
/** 令牌：五种异火 + 六合游身尺 + 佛怒火莲 */
const TOKEN_IDS = FLAME_IDS.concat(['U476', 'U477']);

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

check('难度页能选炎帝，卡库里有 11 张炎帝牌（异火与两张牌是令牌）', () => {
  api.__go('home');
  api.setDifficulty('normal');
  api.__nav('choose-ai', {});
  const html = stage();
  if (!html.includes('data-key="flame"')) throw new Error('难度页里没有炎帝阵营');

  const st = aiGame('flame');
  if (!st) throw new Error('选完炎帝没能开局');
  const missing = ALL_IDS.filter((id) => !st.cardLib[id]);
  if (missing.length) throw new Error('卡库里缺炎帝牌：' + missing.join(' '));
  for (const id of ALL_IDS) {
    const want = TOKEN_IDS.indexOf(id) >= 0;
    if (!!st.cardLib[id].token !== want) throw new Error(id + ' 的令牌标记不对：token=' + !!st.cardLib[id].token);
    if (st.cardLib[id].faction !== 'flame') throw new Error(id + ' 的阵营不是 flame');
  }
  for (const p of st.players) {
    if (p.side === 0 && p.faction !== 'flame') throw new Error('我方阵营没写进对局 side 0 = ' + p.faction);
    if (!p.faction) throw new Error('side ' + p.side + ' 没有阵营');
    const list = p.superpowers || [];
    if (list.length !== 1) throw new Error('开局应当各抽 1 张超能力，side ' + p.side + ' 实际 ' + list.length);
    if (st.cardLib[list[0]].token) throw new Error('令牌不该被超能力池抽到 ' + list[0]);
  }
});

check('炎帝开局就有 5 张异火堆（五种各 1），界面显示张数', () => {
  const st = aiGame('flame');
  const me = st.players[0];
  const pile = me.flamePile || [];
  if (pile.length !== 5) throw new Error('异火堆应当是 5 张，实际 ' + pile.length);
  for (const id of FLAME_IDS) {
    const n = pile.filter((cid) => cid === id).length;
    if (n !== 1) throw new Error(id + ' 在异火堆里应当是 1 张，实际 ' + n);
  }
  if (st.players[0].hand.some((c) => FLAME_IDS.indexOf(c.cardId) >= 0)) throw new Error('开局手牌不该有异火');
  if (!stage().includes('异火 5')) throw new Error('棋盘上没有显示异火堆张数');
});

check('异火堆抽完不会自动补（作者：所有异火都是令牌，抽完不自动补）', () => {
  const src = fs.readFileSync(ROOT + '/engine/src/factions.js', 'utf8');
  if (!src.includes('flame-empty')) throw new Error('抽空异火堆时没有留痕（flame-empty）');
  const st = aiGame('flame');
  const me = st.players[0];
  me.flamePile.length = 0;
  api.__pause(false);
  const r = api.__autoPlay(1200);
  if (r && r.error) throw new Error('自走失败 ' + r.error);
  const now = api.__game().players[0].flamePile || [];
  if (now.length !== 0) throw new Error('抽空的异火堆被自动补上了：' + now.length + ' 张');
});

check('炎帝整局自走能终局，不卡死', () => {
  aiGame('flame');
  api.__pause(false);
  const r = api.__autoPlay(3000);
  if (r && r.error) throw new Error('自走失败 ' + r.error);
  if (r && r.stalled) throw new Error('自走没能结束（卡住了）');
  const st = api.__game();
  if (!st || st.winner === null) throw new Error('整局自走没有结果');
});

// 留一个干净局面给后面的检查
api.__pause(false);
api.__go('home');
api.__newGame();
