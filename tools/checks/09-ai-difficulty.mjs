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


check('AI 一点费用都不多给（作者 2026-09 明确要求；手牌/国王血量可以给）', () => {
  api.__go('home');
  api.__newGame();
  const st = api.__game();
  const before = {
    manaCap: st.players[1].manaCap,
    mana: st.players[1].mana,
    flat: st.players[1].flatManaBonus || 0,
  };
  // 四个难度逐个试：**费用上限与当前费用都必须原样不变**。
  // 多手牌 / 多国王血量是允许的（作者说「其他条件还可以加」），唯独费用不能加。
  for (const key of ['easy', 'normal', 'hard', 'nightmare']) {
    const after = api.__applyBonus(st, 1, key);
    if (after.manaCap !== before.manaCap) {
      throw new Error(key + ' 难度给了费用上限加成：' + before.manaCap + ' → ' + after.manaCap);
    }
    if (after.mana !== before.mana) {
      throw new Error(key + ' 难度给了即时费用：' + before.mana + ' → ' + after.mana);
    }
    if ((after.flatManaBonus || 0) !== before.flat) {
      throw new Error(key + ' 难度设了固定费用加成：' + before.flat + ' → ' + after.flatManaBonus);
    }
  }
});
