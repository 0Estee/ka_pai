/** § AI 难度：实测站得住的差异 */
import { api, check, softCheck } from './harness.mjs';

// ── AI 难度 ───────────────────────────────────────────────
// 注意：**只断言实测站得住的结论**。这个启发式 AI 已接近上限，
// 「困难」相对「普通」只有 +2 个百分点（噪声内），所以这里不断言它更强 ——
// 断言一个假的东西，比不测更糟。
console.log('\n§ AI 难度：实测站得住的差异');

check('四个难度都在', () => {
  const keys = api.__difficulties();
  for (const k of ['easy', 'normal', 'hard', 'nightmare']) {
    if (!keys.includes(k)) throw new Error(`缺少难度 ${k}`);
  }
});

softCheck('「简单」明显更弱（不会用锦囊）—— 用「普通 vs 普通」做同侧对照', () => {
  // ⚠ 和「困难」那条一样：__aiLeague 的 p0 胜率**不是 50% 基准**，
  // 同侧座位天然带偏置，而且这个偏置会随卡池漂（实测在 39%~54% 之间）。
  // 原来这里写死 62%，是拿旧卡池的一次测量当常数用；卡池涨到 146 张之后就假失败了。
  // 正确做法是和**同侧对照组**比差值。
  const n = 100;
  const ctrl = api.__aiLeague('normal', 'normal', n);
  const base = ctrl.p0 / n;
  const r = api.__aiLeague('normal', 'easy', n);
  const win = r.p0 / n;
  if (win < base + 0.08) {
    throw new Error(`普通打简单 ${(win * 100).toFixed(0)}%，同侧对照（普通打普通）是 `
      + `${(base * 100).toFixed(0)}% —— 差距不足 8 个百分点，简单难度没拉开`);
  }
});

// 作者 2026-09 要求削弱人机之后，困难/噩梦**按设计不再比普通强**（拿掉了资源优势），
// 所以「噩梦明显更强」「困难明显更强」这两条断言已不成立，整条删掉。
// 只保留「简单明显更弱」那条 —— 简单是真的不会用锦囊，与资源优势无关。


// 作者 2026-10 重新定了两档的资源优势，这一条按新口径逐档对账：
//   困难 = 起手多 1 张 + 国王生命上限 +6（**不加费**）
//   噩梦 = 起手多 1 张 + 每回合多 1 费 + 国王生命上限 +8
// 这些优势会由 screens.js 从 bonus 逐条渲染到选难度界面上，所以必须是明码、可对账的。
check('难度增益与界面口径一致：困难只加手牌/国王血，噩梦才多 1 费', () => {
  const want = {
    easy: { hand: 0, hp: 0, mana: 0 },
    normal: { hand: 0, hp: 0, mana: 0 },
    hard: { hand: 1, hp: 6, mana: 0 },
    nightmare: { hand: 1, hp: 8, mana: 1 },
  };
  for (const key of ['easy', 'normal', 'hard', 'nightmare']) {
    api.__go('home');
    api.__newGame();
    const st = api.__game();
    const p = () => st.players[1];
    const before = { hand: p().hand.length, hp: p().kingHp, manaCap: p().manaCap, mana: p().mana, flat: p().flatManaBonus || 0 };
    const a = api.__applyBonus(st, 1, key);
    const got = { hand: a.hand - before.hand, hp: a.hp - before.hp, mana: a.flatManaBonus - before.flat };
    if (got.hand !== want[key].hand) throw new Error(key + ' 起手多 ' + got.hand + ' 张，应为 ' + want[key].hand);
    if (got.hp !== want[key].hp) throw new Error(key + ' 国王生命上限 +' + got.hp + '，应为 +' + want[key].hp);
    if (got.mana !== want[key].mana) throw new Error(key + ' 每回合多 ' + got.mana + ' 费，应为 ' + want[key].mana);
    if (a.manaCap - before.manaCap !== want[key].mana) {
      throw new Error(key + ' 的固定费用加成没有同步到当回合费用上限（' + before.manaCap + ' -> ' + a.manaCap + '）');
    }
    if (a.mana - before.mana !== want[key].mana) {
      throw new Error(key + ' 的固定费用加成没有同步到当回合可用费用（' + before.mana + ' -> ' + a.mana + '）');
    }
  }
});
