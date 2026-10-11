/** § AI 难度：实测站得住的差异 */
import { ROOT, api, check, softCheck } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';

// ── AI 难度 ───────────────────────────────────────────────
// 注意：**只断言实测站得住的结论**。这个启发式 AI 已接近上限，
// 「困难」相对「普通」只有 +2 个百分点（噪声内），所以这里不断言它更强 ——
// 断言一个假的东西，比不测更糟。
console.log('\n§ AI 难度：实测站得住的差异');

check('五个难度都在', () => {
  const keys = api.__difficulties();
  for (const k of ['easy', 'normal', 'hard', 'nightmare', 'impossible']) {
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
check('难度增益与界面口径一致：困难只加手牌/国王血，噩梦才多 1 费，「不可能」一点不加', () => {
  const want = {
    easy: { hand: 0, hp: 0, mana: 0 },
    normal: { hand: 0, hp: 0, mana: 0 },
    hard: { hand: 1, hp: 6, mana: 0 },
    nightmare: { hand: 1, hp: 8, mana: 1 },
    // 作者 2026-10：「不可能」按设计**不加任何优势**，这一行就是那条承诺的对账。
    impossible: { hand: 0, hp: 0, mana: 0 },
  };
  for (const key of ['easy', 'normal', 'hard', 'nightmare', 'impossible']) {
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

//  作者 2026-10：「不可能」不加任何数值优势，只靠推演 
// 这一档的强度全部来自 app/js/ai.js 里的模拟前瞻规划器（planRollout）：
// 把前 K 个候选各自克隆一整局、真推到对手回合结束，再挑局面最好的那个。
// 因为它「读真状态、写克隆体」，必须证明两件事：推演没把共享卡库改脏，
// 也没把别的难度对打的结果带偏。

check('「不可能」的推演是隔离的：克隆自带 rng，且不碰真对局', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'js', 'ai.js'), 'utf8');
  for (const need of [
    'createRng(state.rng',
    'c.humanSide = -1;',
    'c.autoResolveChoices = true;',
    "planner: 'rollout'",
  ]) {
    if (!src.includes(need)) throw new Error('「不可能」的推演缺了关键隔离步骤: ' + need);
  }
  // 克隆必须新造 rng：engine/src/rng.js 的状态藏在闭包里，直接展开对象会把
  // 推演和真对局接到同一个随机源上（真对局的抽牌顺序就被推演吃掉了）。
  if (/rng:\s*state\.rng/.test(src)) throw new Error('推演直接展开了 state.rng，没另造随机源');
});

check('「不可能」的推演不污染共享卡库，也不影响别的难度对打', () => {
  api.__go('home');
  api.__newGame();
  const st = api.__game();
  const lib = st.cardLib;
  const ids = Object.keys(lib).filter((id) => (lib[id].effects || []).length > 0).slice(0, 5);
  if (ids.length === 0) throw new Error('卡库里找不到带 effects 的牌，这条检查失去意义');
  const before = ids.map((id) => JSON.stringify(lib[id]));
  const a1 = api.__aiLeague('hard', 'hard', 20);
  // 这一条只关心「推演有没有把共享状态改脏」，不需要跑满时间预算：
  // 写死 0 档（最省的一档  原来的定档），又快又跟机器快慢无关。
  api.__aiLeague('impossible', 'nightmare', 20, { planBudgetMs: 0 });
  const a2 = api.__aiLeague('hard', 'hard', 20);
  const after = ids.map((id) => JSON.stringify(lib[id]));
  for (let i = 0; i < ids.length; i++) {
    if (before[i] !== after[i]) {
      throw new Error('推演把牌库里的 ' + ids[i] + ' 改掉了（克隆没做干净）');
    }
  }
  if (a1.p0 !== a2.p0 || a1.p1 !== a2.p1) {
    throw new Error('跑过「不可能」之后再打「困难 vs 困难」，结果变了（'
      + a1.p0 + '/' + a1.p1 + ' -> ' + a2.p0 + '/' + a2.p1 + '）');
  }
});

// 强度只用同侧对照比差值（__aiLeague 的 p0 不是 50%）。
// 实测（120 局  两组互不重叠的种子）：不可能打普通 94%，同侧对照普通打普通 49%；
// 这里用 n=40 只做「明显更强」的下限断言，避免门禁跑太久。
softCheck('「不可能」不加任何优势，但强度远超普通', () => {
  const n = 40;
  const ctrl = api.__aiLeague('normal', 'normal', n);
  const base = ctrl.p0 / n;
  const r = api.__aiLeague('impossible', 'normal', n);
  const win = r.p0 / n;
  if (win < base + 0.2) {
    throw new Error('不可能打普通 ' + (win * 100).toFixed(0) + '%，同侧对照（普通打普通）是 '
      + (base * 100).toFixed(0) + '%，优势不足 20 个百分点');
  }
});

// ── 时间预算（作者 2026-10-11：几秒的出牌延迟可以接受，让他算）──
// 「不可能」不再写死一个深度，而是按**一整个回合**的时间预算自己爬档
// （app/js/ai.js 的 PLAN_LEVELS / planBudgetMs / planRollout）。
// 这条检查盯三件事：预算不够要停在最省的一档、预算管够要真的爬上去、写死档位要照办。
// 判据是 ai.js 里的测试钩子 window.__aiLastPlanLevel（上一次规划实际跑到第几档）。
check('「不可能」按时间预算爬档：慢机器停低档，快机器爬高档', () => {
  api.__go('home');
  api.__newGame();
  const runOne = (params) => {
    api.__aiLeague('impossible', 'normal', 2, params, null, 1);
    return api.__aiLastPlanLevel;
  };
  const low = runOne({ planBudgetMs: 1 });
  if (low !== 0) throw new Error('预算 1ms 时爬到了第 ' + low + ' 档，应该停在最省的 0 档');
  const hi = runOne({ planBudgetMs: 60000 });
  if (hi < 1) throw new Error('预算 60s 时仍停在第 0 档，档位没起作用');
  if (runOne({ planLevel: 1 }) !== 1) throw new Error('写死 planLevel=1 时没有照办');
  if (runOne({ planLevel: 99 }) !== 4) throw new Error('planLevel 超出档位表时没有夹到最后一档');
  // 档位表本身：只能加广（K），不能靠加深（实测越深越吵，见 README）
  const src = fs.readFileSync(path.join(ROOT, 'app', 'js', 'ai.js'), 'utf8');
  if (!src.includes('const PLAN_LEVELS = [')) throw new Error('ai.js 里没有档位表 PLAN_LEVELS');
  if (!src.includes('planBudgetMs: 6000')) throw new Error('「不可能」档没有定时间预算（应为 6000ms）');
});
