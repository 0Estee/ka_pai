/**  炼金阵营（作者 2026-10-07：原料 / 炼药 / 令牌） */
import { api, check, elements } from './harness.mjs';

console.log('\n 炼金阵营（原料与炼药）');

const stage = () => elements.get('stage').innerHTML;

/** 走难度页的真实路由开一局炼金（AI 对手，暂停回合驱动） */
function alchemyGame() {
  api.__go('home');
  api.setDifficulty('normal');
  api.__nav('choose-ai', {});
  api.__nav('set-faction', { key: 'alchemy' });
  api.__nav('start-ai', {});
  api.__pause(true);
  return api.__game();
}

/** 把手牌换成指定的几张（mana 10、锦囊阶段），方便稳定地测炼药界面 */
function hand(ids) {
  api.__demoHand(ids);
  return api.__game();
}

check('难度页能选炼金阵营，带进对局，抽到本阵营非令牌超能力，界面显示原料堆', () => {
  api.__go('home');
  api.setDifficulty('normal');
  api.__nav('choose-ai', {});
  if (!stage().includes('data-act="set-faction"')) throw new Error('难度页没有阵营可选项');
  if (!stage().includes('data-key="alchemy"')) throw new Error('难度页里没有炼金阵营');
  api.__nav('set-faction', { key: 'alchemy' });
  api.__nav('start-ai', {});
  api.__pause(true);
  const st = api.__game();
  if (!st) throw new Error('选完炼金没能开局');
  for (const p of st.players) {
    if (p.faction !== 'alchemy') throw new Error('阵营没写进对局：side ' + p.side + ' = ' + p.faction);
    const list = p.superpowers || [];
    if (list.length !== 1) throw new Error('开局应当各抽 1 张超能力，side ' + p.side + ' 实际 ' + list.length);
    const def = st.cardLib[list[0]];
    if (!def || def.faction !== 'alchemy') throw new Error('抽到的不是炼金超能力：' + list[0]);
    if (def.token) throw new Error('令牌不该被抽到：' + list[0]);
  }
  const pile = st.players[0].rawPile || [];
  if (pile.length !== 13) throw new Error('开局原料堆应当是 13（14 减去回合开始抽的 1 张），实际 ' + pile.length);
  if (!stage().includes('原料 13')) throw new Error('对局里没有显示原料堆张数');
});

check('手牌里的原料带「原料」角标；手里原料够两张才出现「炼药」按钮', () => {
  alchemyGame();
  hand(['U426', 'U426', 'U428']);
  api.refresh();
  const html = stage();
  if (!html.includes('is-raw')) throw new Error('原料在手牌里没有标记');
  if (!html.includes('原料</div>')) throw new Error('原料卡面没有「原料」角标');
  if (!html.includes('data-act="brew"')) throw new Error('手里有 3 张原料却没有「炼药」按钮');
  hand(['U426', 'U05', 'U07']);
  api.refresh();
  if (stage().includes('data-act="brew"')) throw new Error('手里只有 1 张原料也出现了「炼药」按钮');
});

check('点原料进入炼药模式：可多选、点第二次取消、提示花费与令牌名', () => {
  const st = alchemyGame();
  hand(['U426', 'U428']);
  const p = st.players[0];
  const a = p.hand.find((h) => h.cardId === 'U426');
  const b = p.hand.find((h) => h.cardId === 'U428');
  if (!a || !b) throw new Error('演示手牌没塞进去');
  api.selectCard(a.iid);
  api.refresh();
  if (!stage().includes('brew-picked')) throw new Error('选中的原料没有高亮');
  if (!stage().includes('已选 1 张')) throw new Error('没有给出炼药提示');
  api.selectCard(b.iid);
  api.refresh();
  if (!stage().includes('已选 2 张')) throw new Error('多选之后提示没更新');
  if (!stage().includes('精致金甲')) throw new Error('没有提示这次会炼出什么（金沙 + 陨铁 = 精致金甲）');
  api.selectCard(b.iid);
  api.refresh();
  if (!stage().includes('已选 1 张')) throw new Error('再点一次没有取消选中');
  api.selectCard(a.iid);
  api.refresh();
  if (stage().includes('brew-picked')) throw new Error('取消全部选中之后还留着高亮');
});

check('炼药结算：原料离开手牌、令牌进手牌、原料回堆、动作录进回放', () => {
  const st = alchemyGame();
  hand(['U426', 'U426', 'U428']);
  const p = st.players[0];
  const before = api.__recordingActions().filter((a) => a.k === 'b').length;
  const pile0 = (p.rawPile || []).length;
  const mats = p.hand.filter((h) => h.cardId === 'U426');
  api.refresh();
  api.selectCard(mats[0].iid);
  api.selectCard(mats[1].iid);
  api.__nav('brew', {});
  const after = api.__game();
  const h2 = after.players[0].hand;
  if (!h2.some((h) => h.cardId === 'U435')) throw new Error('两张金沙应当炼出财富药水 U435');
  if (h2.some((h) => h.iid === mats[0].iid || h.iid === mats[1].iid)) throw new Error('被消耗的原料还留在手里');
  if ((after.players[0].rawPile || []).length !== pile0 + 2) throw new Error('原料没有回到原料堆');
  const recs = api.__recordingActions().filter((a) => a.k === 'b');
  if (recs.length !== before + 1) throw new Error('炼药没有录进回放（回放 / 联机都会错位）');
  const rec = recs[recs.length - 1];
  if (!Array.isArray(rec.i) || rec.i.length !== 2) throw new Error('回放里的炼药动作没带消耗的原料：' + JSON.stringify(rec));
  api.refresh();
  if (stage().includes('data-act="brew"')) throw new Error('炼完之后手里只剩 1 张原料，按钮应当消失');
});

check('炼药的边界：不够两张不记动作；组合对不上不给令牌但照付费用、原料照样回堆', () => {
  const st = alchemyGame();
  hand(['U426', 'U05']);
  api.refresh();
  const n0 = api.__recordingActions().length;
  api.__nav('brew', {});
  if (api.__recordingActions().length !== n0) throw new Error('没选够原料也记了一条动作');

  hand(['U426', 'U428', 'U428']);
  const p = api.__game().players[0];
  const pile0 = (p.rawPile || []).length;
  const mana0 = p.mana;
  const mats = p.hand.filter((h) => st.cardLib[h.cardId].rawMaterial);
  for (const m of mats) api.selectCard(m.iid);
  api.__nav('brew', {});
  const after = api.__game().players[0];
  if (after.hand.some((h) => ['U434', 'U435', 'U436', 'U437', 'U438', 'U439', 'U440', 'U441', 'U442', 'U443', 'U444'].includes(h.cardId))) {
    throw new Error('组合对不上却给了令牌');
  }
  if ((after.rawPile || []).length !== pile0 + 3) throw new Error('原料没有回原料堆');
  if (after.mana !== mana0 - 2) throw new Error('费用没有照付（金沙 0 + 陨铁 1 + 陨铁 1）：' + mana0 + ' -> ' + after.mana);
});

check('AI 走炼金也不卡死：整局自走能结束，且 AI 真的炼过药', () => {
  api.__go('home');
  api.setDifficulty('normal');
  api.__nav('choose-ai', {});
  api.__nav('set-faction', { key: 'alchemy' });
  api.__nav('start-ai', {});
  api.__pause(false);
  const r = api.__autoPlay(1500);
  if (r && r.error) throw new Error('自走失败：' + r.error);
  const st = api.__game();
  if (r && r.stalled) throw new Error('自走没能结束（卡住了）');
  if (!st || st.winner === null) throw new Error('整局自走没有结果');
  if (!(st.log || []).some((e) => e.type === 'brew')) throw new Error('整局里 AI 一次都没炼药（炼药分支没接上）');
});

//  留一个干净局面给后面的检查
api.__pause(false);
api.__go('home');
api.__newGame();
