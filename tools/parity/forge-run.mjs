/**
 * 强化 / 经济规则的基准数据（给 godot/tests/forge.gd 对拍用）。
 *
 * 直接调用旧版 app/js/enhance.js 与 app/js/economy.js，把结果写进
 * godot/data/parity/forge-golden.json；GDScript 侧跑同一组输入，
 * 数值必须逐项一致（容差 1e-9）。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as E from '../../app/js/enhance.js';
import * as Eco from '../../app/js/economy.js';
import { TEST_CARD_LIB } from '../../engine/cards/test-cards.js';

const lib = TEST_CARD_LIB;
const out = { generatedAt: new Date().toISOString(), libSize: Object.keys(lib).length };

// 1. 价格与累计值
out.costs = {
  enhanceGold: Array.from({ length: 10 }, (_, i) => E.enhanceGoldCost(i)),
  masteryDust: [0, 1, 2, 3].map((n) => E.masteryDustCost(n)),
  enhanceValue: Array.from({ length: 11 }, (_, i) => E.enhanceValue(i)),
};

// 2. 卡面数值：挑几张有代表性的牌，覆盖不同强化等级与技能组合
const pick = Object.keys(lib).filter((id) => E.isForgeable(lib[id])).slice(0, 40);
const cases = [];
const recs = [
  { lvl: 0, masteries: [] },
  { lvl: 4, masteries: [] },
  { lvl: 9, masteries: [] },
  { lvl: 0, masteries: ['w_temper'] },
  { lvl: 0, masteries: ['w_tough', 'w_fury'] },
  { lvl: 0, masteries: ['o_almighty'] },
  { lvl: 0, masteries: ['g_twist', 'p_undying'] },
  { lvl: 0, masteries: ['p_focus', 'o_sacred'] },
  { lvl: 0, masteries: ['spell_cost'] },
  { lvl: 0, masteries: ['spell_cost', 'spell_cost'] },
];
for (const id of pick) {
  for (const rec of recs) {
    const st = E.statsFor(lib[id], rec);
    cases.push({
      id, rec,
      atk: st.atk, hp: st.hp, cost: st.cost,
      kw: (st.keywords || []).map((k) => [k.id, k.x ?? 0]),
      fxCount: (st.fx || []).length,
      flagKeys: Object.keys(st.flags || {}).sort(),
      kingAura: st.kingAura || null,
    });
  }
}
out.stats = cases;

// 3. 增量表：一份覆盖多种记录形状的档案
const forgeProfile = { forge: { v: 1, cards: {} } };
const sample = pick.slice(0, 24);
sample.forEach((id, i) => {
  forgeProfile.forge.cards[id] = recs[i % recs.length];
});
out.forgeProfile = forgeProfile;
out.sideEnhance = E.buildSideEnhance(lib, forgeProfile);

// 4. AI 强化：同 seed + 难度必须完全一样
out.aiForge = {};
for (const difficulty of ['easy', 'normal', 'hard', 'nightmare', 'impossible']) {
  for (const seed of [1001, 2024]) {
    const p = E.aiForge(lib, { seed, difficulty });
    const cards = p.forge.cards;
    const ids = Object.keys(cards).sort();
    out.aiForge[`${difficulty}:${seed}`] = {
      count: ids.length,
      sample: ids.slice(0, 12).map((id) => ({ id, ...cards[id] })),
    };
  }
}

// 5. 抽技能：确定性随机源下的结果（LCG 与 GDScript 侧同算法）
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
out.drawSkills = [];
for (const seed of [1, 7, 42, 999]) {
  out.drawSkills.push(E.drawSkills(lcg(seed), 3).map((s) => s.id));
}
out.skills = E.SKILLS.map((s) => ({ id: s.id, rarity: s.rarity, name: s.name, text: s.text }));

// 6. 经济：等级曲线、单局奖励、结算、买星尘、上限熔炼
out.economy = {
  perfForLevel: Array.from({ length: 12 }, (_, i) => Eco.perfForLevel(i + 1)),
  levelFor: [0, 199, 200, 449, 450, 1100, 5000, 123456].map((p) => Eco.levelFor(p)),
  rewards: [],
  results: [],
};
const rewardCases = [
  { winner: 0, humanSide: 0, turn: 6, humanKingHp: 12, kills: 3, mode: 'ai' },
  { winner: 1, humanSide: 0, turn: 20, humanKingHp: 0, kills: 0, mode: 'ai' },
  { winner: 'draw', humanSide: 0, turn: 30, humanKingHp: 4, kills: 2, mode: 'ai' },
  { winner: 0, humanSide: 1, turn: 9, humanKingHp: 7, kills: 5, mode: 'pvp' },
  { winner: 1, humanSide: 1, turn: 9, humanKingHp: 7, kills: 1, mode: 'pvp' },
];
for (const c of rewardCases) out.economy.rewards.push(Eco.rewardFor(c));
const base = { gold: 990, dust: 490, perf: 380, games: 3, wins: 1, losses: 2, draws: 0, forge: { v: 1, cards: {} } };
for (const c of rewardCases) {
  const r = Eco.applyResult(base, c);
  out.economy.results.push({
    gold: r.profile.gold, dust: r.profile.dust, perf: r.profile.perf,
    games: r.profile.games, wins: r.profile.wins, losses: r.profile.losses, draws: r.profile.draws,
    leveledUp: r.leveledUp, levelBefore: r.levelBefore, levelAfter: r.levelAfter,
  });
}
out.economy.buyDust = [
  Eco.buyDust({ gold: 100, dust: 60 }, 1),
  Eco.buyDust({ gold: 5, dust: 60 }, 1),
  Eco.buyDust({ gold: 100, dust: 500 }, 1),
];
out.economy.capGold = [
  Eco.capGold(1200, 10),
  Eco.capGold(1005, 500),
  Eco.capGold(-5, -5),
];

const dest = process.argv[2] || 'godot/data/parity/forge-golden.json';
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 1));
console.log(`[forge-golden] ${dest}  stats=${out.stats.length}  aiForge=${Object.keys(out.aiForge).length}  ${(fs.statSync(dest).size / 1024).toFixed(0)}KB`);
