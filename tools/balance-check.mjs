/**
 * 平衡自检：跑 N 局随机对战，看三个健康指标。
 *
 *   node tools/balance-check.mjs [局数] [卡组张数]
 *
 * | 指标 | 健康范围 | 说明 |
 * |---|---|---|
 * | 先手胜率 | 45%~55% | 超出说明先后手严重失衡 |
 * | 平均回合数 | 7~10 | 太短说明快攻过强，太长说明僵持 |
 * | 牌库抽空收场比例 | < 40% | 太高说明对局不是「打到国王」而是「耗到没牌」 |
 *
 * 卡组用应用内实际张数（默认 80），并且**逐局传不同的种子** ——
 * 卡池比卡组大时牌库是按种子抽样的，不换种子就每局都是同一副牌。
 */

import * as G from '../engine/src/engine.js';
import { TEST_CARD_LIB, buildTestDeck, DECKABLE_CARDS } from '../engine/cards/test-cards.js';

const N = Number(process.argv[2] || 300);
const SIZE = Number(process.argv[3] || 80);

/** 确定性的小 PRNG（和引擎无关，只用来替玩家做随机决策） */
function mul(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const tally = { 0: 0, 1: 0, draw: 0 };
let turns = 0, deckOut = 0, kingWin = 0, cardsPlayed = 0, unitsDestroyed = 0;
const seenCards = new Set();
let crashed = 0;

for (let seed = 1; seed <= N; seed++) {
  const deck = buildTestDeck(SIZE, seed);
  for (const id of deck) seenCards.add(id);

  const s = G.createGame({
    seed, firstPlayer: seed % 2, deck, cardLib: TEST_CARD_LIB,
  });
  G.startGame(s);
  /**
   * 「本局没有真人」——把双方都交给引擎自动决策。
   *
   * 强化士兵（拟定目标攻击）会问「打谁」：真人那一侧必须挂起等人答，
   * 而这个脚本没人可问。`humanSide = -1` 表示两侧都不是真人，
   * 于是两侧都由 AI 策略自己挑（见 engine/src/combat.js 的 pickCombatTarget）。
   */
  s.humanSide = -1;
  const r = mul(seed * 7919);
  let guard = 0;
  try {
    while (!G.isOver(s)) {
      if (++guard > 4000) throw new Error('不收敛');
      const a = G.getActor(s);
      if (a === null) { G.advance(s); continue; }
      const p = G.getLegalPlays(s, a);
      if (!p.length) { G.advance(s); continue; }
      const c = p[Math.floor(r() * p.length)];
      const pl = c.places[Math.floor(r() * c.places.length)];
      try { G.playCard(s, a, c.iid, pl ? { lane: pl.lane, row: pl.row } : {}); }
      catch { G.advance(s); }
    }
  } catch (err) {
    crashed++;
    if (crashed <= 3) console.error(`  ✗ 种子 ${seed}: ${err.message}`);
    continue;
  }

  tally[s.winner] = (tally[s.winner] || 0) + 1;
  turns += s.turn;
  cardsPlayed += s.stats.cardsPlayed;
  unitsDestroyed += s.stats.unitsDestroyed;
  if (/牌库抽空/.test(s.winReason || '')) deckOut++; else kingWin++;
}

const pool = DECKABLE_CARDS.map((c) => c.id);
const ok = (label, value, lo, hi) =>
  `${value >= lo && value <= hi ? '✓' : '✗'} ${label}`;

console.log(`\n卡组 ${SIZE} 张 · ${N} 局（卡池 ${pool.length} 张非令牌）`);
console.log('─'.repeat(52));
const firstRate = tally[0] / N * 100;
const avgTurn = turns / N;
const outRate = deckOut / N * 100;
console.log(`  ${ok('先手胜率', firstRate, 45, 55)}  ${firstRate.toFixed(1)}%   （健康 45~55%）`);
console.log(`  ${ok('平均回合数', avgTurn, 7, 10)}  ${avgTurn.toFixed(1)}      （健康 7~10）`);
console.log(`  ${ok('牌库抽空收场', outRate, 0, 40)}  ${outRate.toFixed(1)}%   （健康 <40%）`);
console.log('─'.repeat(52));
console.log(`  先手胜 ${tally[0]}   后手胜 ${tally[1]}   平局 ${tally.draw}`);
console.log(`  打到国王收场 ${kingWin}   牌库抽空收场 ${deckOut}`);
console.log(`  平均出牌 ${(cardsPlayed / N).toFixed(1)}   平均消灭 ${(unitsDestroyed / N).toFixed(1)}`);
console.log(`  卡池覆盖 ${pool.filter((id) => seenCards.has(id)).length}/${pool.length}`
  + (pool.some((id) => !seenCards.has(id)) ? '   ← 还有卡从未进过牌库' : ''));
if (crashed) console.log(`  ⚠ ${crashed} 局出错被跳过`);
process.exit(crashed ? 1 : 0);
