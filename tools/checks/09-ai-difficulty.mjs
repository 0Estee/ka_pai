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
    api.setDifficulty('normal');   // 基线必须是没有加成的一局（02 号检查会把难度留在 hard）
    api.__newGame();
    const st = api.__game();
    const p = () => st.players[1];
    // 炼金阵营「每抽一张牌抽一张原料」会把难度送的这一张也算成一次抽牌（顺带多给一张原料），
    // 让「起手多几张」对不上；这条检查量的是难度加成本身，先把阵营因素摘掉。
    st.players[1].faction = null;
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

// ── 「不可能」的信息优势：看得到对手手牌 + 双方下一抽（作者 2026-10-24）──
// 这是**信息型**优势，不是数值优势：手牌张数、费用、国王血量和玩家完全一样，
// 它只是多知道了两样玩家看不到的东西。和噩梦的数值优势同一套纪律 —— 必须写在选难度
// 界面上，而且只有这一档有。四条断言分别盯：位置（只开这一档）、界面（逐条写明）、
// 只读（推演与联机锁步都依赖这一点）、以及它真的接进了决策（不是摆设）。
check('「不可能」的信息优势只开在这一档，并且逐条写在选难度界面上', () => {
  const imp = api.difficultyByKey('impossible');
  if (!imp.insight || imp.insight.hand !== true || imp.insight.deck !== true) {
    throw new Error('「不可能」没有打开信息优势（insight 应为 { hand: true, deck: true }）');
  }
  // 数值方面仍然一点不加 —— 两条必须同时成立，否则就成了「拿数值优势冒充信息优势」
  if (imp.bonus !== null) throw new Error('「不可能」的 bonus 不是 null，数值优势和信息优势混在一起了');
  for (const key of api.__difficulties()) {
    if (key === 'impossible') continue;
    if (api.difficultyByKey(key).insight) throw new Error(key + ' 也带上了信息优势（只有「不可能」该有）');
  }
  // 界面：渲染成文字，玩家在选难度时就看得到，不在代码注释里
  const rows = api.__difficulties().map((k) => api.difficultyByKey(k));
  const html = api.difficultyHTML({ current: 'impossible', difficulties: rows, faction: null, factions: [], mode: 'ai' });
  for (const need of ['信息优势', '看得到你的手牌', '双方下一次各抽到什么']) {
    if (!html.includes(need)) throw new Error('选难度界面没有写出信息优势的「' + need + '」');
  }
  // 底下那句总说明也不许再说「不加任何优势」：它现在不加数值，但多看得到东西
  const src = fs.readFileSync(path.join(ROOT, 'app', 'js', 'screens.js'), 'utf8');
  if (!src.includes('不会多一张牌、多一费、多一点血')) {
    throw new Error('screens.js 的难度说明没写清「不可能」不加数值优势、但看得到手牌与下一抽');
  }
});

check('「不可能」看得到双方下一抽：口径与引擎真实抽牌一致', () => {
  // 抽牌顺序是后手先抽、先手后抽（engine/src/turns.js 的 onTurnStart），
  // 所以后手拿 deck[0]、先手拿 deck[1]。这里不抄实现，直接拿引擎的 drawCards
  // 走一遍，把 nextDrawCard 的预测和实际抽到的牌逐张对账 —— 抽牌顺序哪天改了，这条先炸。
  api.__go('home');
  api.__newGame();
  const st = api.__game();
  st.humanSide = -1;
  st.autoResolveChoices = true;
  let ok = 0;
  for (let i = 0; i < 8; i++) {
    if (st.winner !== null || st.deck.length < 3) break;
    let actor = null;
    try { actor = api.getActor(st); } catch { break; }
    if (actor === null) { try { api.advance(st); } catch { break; } continue; }
    try { api.aiTakeTurn(st, actor, { difficulty: 'normal' }); } catch { break; }
    const want = [api.nextDrawCard(st, 0), api.nextDrawCard(st, 1)];
    const before = [st.players[0].hand.map((h) => h.cardId), st.players[1].hand.map((h) => h.cardId)];
    const first = st.firstPlayer;
    api.drawCards(st, 1 - first, 1);
    api.drawCards(st, first, 1);
    for (const side of [0, 1]) {
      if (!want[side]) continue;
      // 不能只取「手牌最后一张」：炼金阵营抽牌会顺手把原料牌塞进手牌（factions.js 的
      // alchemyOnDraw），最后一张未必就是这一抽抽到的那张。这里按「这一抽新出现的 cardId」
      // 来对账 —— 预测的那张必须在新出现的牌里。
      const prev = before[side].slice();
      const fresh = [];
      for (const h of st.players[side].hand) {
        const idx = prev.indexOf(h.cardId);
        if (idx >= 0) prev.splice(idx, 1);
        else fresh.push(h.cardId);
      }
      if (!fresh.includes(want[side].id)) {
        throw new Error('下一抽预测错了：side' + side + ' 预测 ' + want[side].id
          + '，这一抽实际新到手的牌是 ' + JSON.stringify(fresh));
      }
      ok++;
    }
    try { api.advance(st); } catch { break; }
  }
  if (ok < 6) throw new Error('下一抽只对账了 ' + ok + ' 次，样本太少（这条检查失去意义）');
});

check('信息优势的几个函数是只读的：不改牌序、不推随机源、不改手牌', () => {
  api.__go('home');
  api.__newGame();
  const st = api.__game();
  const fp = () => JSON.stringify({
    deck: st.deck.slice(0, 6),
    rng: st.rng.state,
    hand0: st.players[0].hand.map((h) => h.iid),
    hand1: st.players[1].hand.map((h) => h.iid),
  });
  const before = fp();
  const P = api.difficultyByKey('impossible');
  const unitId = Object.keys(st.cardLib).find((id) => st.cardLib[id] && st.cardLib[id].type === 'unit');
  if (!unitId) throw new Error('卡库里找不到单位牌，这条检查失去意义');
  for (const side of [0, 1]) {
    api.nextDrawCard(st, side);
    api.handValue(st, side);
    api.removalInHand(st, side);
    api.kingDamageInHand(st, side);
    api.incomingThreat(st, side);
    api.myBurst(st, side);
  }
  api.evalPosition(st, 0, P);
  for (const lane of ['mountain', 'plainL', 'plainR', 'water']) {
    api.scoreUnitPlacement(st, 0, st.cardLib[unitId], lane, 'front', P);
  }
  if (fp() !== before) throw new Error('信息优势读着读着把对局状态改了（它必须是纯读的）');
});

check('关掉信息优势会真的改变决策（不是摆设），且默认开着', () => {
  // 判据故意不用胜率：这一档已接近瓶颈，信息优势的可测强度差在 n=240 也只有 ±3 个点，
  // 拿它做门禁只会得到一条随机失败的检查。这里用**可复现的分歧率**：
  // 同一局面跑两次（只差 insight 开关），比对两边实际打出的牌序列。种子写死，任何机器结果一样。
  const src = fs.readFileSync(path.join(ROOT, 'app', 'js', 'ai.js'), 'utf8');
  if (!src.includes('insight: { hand: true, deck: true }')) {
    throw new Error('ai.js 里「不可能」档没有默认打开 insight');
  }
  const lib = api.__game().cardLib;
  let total = 0;
  let diff = 0;
  for (const seed of [1, 4, 6]) {
    const deck = api.buildTestDeck(80, seed);
    const st = api.createGame({ seed, firstPlayer: seed % 2, deck, cardLib: lib });
    api.startGame(st);
    st.humanSide = -1;
    st.autoResolveChoices = true;
    for (let step = 0; step < 34; step++) {
      if (st.winner !== null) break;
      let actor = null;
      try { actor = api.getActor(st); } catch { break; }
      if (actor === null) { try { api.advance(st); } catch { break; } continue; }
      let plays;
      try { plays = api.getLegalPlays(st, actor); } catch { break; }
      if (plays.length > 0) {
        const on = api.aiTakeTurn(api.cloneForSim(st), actor, { difficulty: 'impossible', params: { planBudgetMs: 0 } });
        const off = api.aiTakeTurn(api.cloneForSim(st), actor, { difficulty: 'impossible', params: { planBudgetMs: 0, insight: null } });
        total++;
        if (JSON.stringify(on.actions) !== JSON.stringify(off.actions)) diff++;
      }
      try { api.aiTakeTurn(st, actor, { difficulty: 'impossible', params: { planBudgetMs: 0 } }); } catch { break; }
      try { api.advance(st); } catch { break; }
    }
  }
  if (total < 20) throw new Error('分歧率样本只有 ' + total + ' 个决策点，太少（局面没跑起来）');
  if (diff === 0) throw new Error('关掉信息优势后 ' + total + ' 个决策点一手都没变 —— 它没接进决策');
});

// ── 推演的成本：两份「只写不读」的流水账不再深拷贝 ──────────
// 作者 2026-10：`cloneForSim` 现在把 `log`（战报）与 `choiceLog`（裁定流水）交给
// 克隆体一个**空数组**，而不是递归深拷贝 —— 这两个是只增不减的历史，
// 一局几百条，实测占 cloneForSim 总耗时的 77%（244 条日志的局面：0.192ms → 0.049ms）。
// 这条检查盯住那个优化的**前提**：推演确实没有任何一处读它们。
// 哪天有人让 AI 去「看战报」做判断，克隆就必须改回深拷贝（给空数组会读到假的空历史），
// 这里会先炸 —— 而不是等到胜率莫名其妙变差才发现。
check('推演跳过的两份流水账确实没人读（要改变这一点就得把深拷贝改回来）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'js', 'ai.js'), 'utf8');
  if (!src.includes('JOURNAL_KEYS')) {
    throw new Error('ai.js 里找不到 JOURNAL_KEYS（克隆跳过的那两份流水账）');
  }
  // ① ai.js 自己不许读它们
  src.split('\n').forEach((line, i) => {
    if (line.trim().startsWith('*') || line.trim().startsWith('//')) return;   // 注释里提到没关系
    if (/\bstate\.log\b|\bstate\.choiceLog\b/.test(line)) {
      throw new Error(`app/js/ai.js:${i + 1} 读了流水账（推演读了它就不能再跳过深拷贝）: ${line.trim()}`);
    }
  });
  // ② 引擎侧只许往战报里 push，不许读
  const dir = path.join(ROOT, 'engine', 'src');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/\bstate\.log\b/.test(line) && !/state\.log\.push/.test(line) && !/^\s*[*//]/.test(line)) {
        throw new Error(`engine/src/${f}:${i + 1} 读了 state.log（同上）: ${line.trim()}`);
      }
    });
  }
});

// ── 评估权重必须**可注入**（所有「哪一档更强」的结论都靠它量）──
// 「不可能」的每一条强度结论都是拿 `__aiLeague(..., params)` 扫出来的：
// params 会被并进难度对象，直接覆盖评估函数里那些 `W.wXxx === undefined ? 默认值 : W.wXxx`。
// 一旦哪个权重被写死，扫描会**静默**失效（跑出来的差异全是噪声）—— 那比不测更糟。
// 判据：拿一个必然改变决策的注入值去打同一批种子，战绩必须变。
// 实测（n=12，种子 1-12，写死 0 档）：默认 7/4/1 → 把「单位值」反过来算（wAtk/wHpEval = -5）1/11/0。
check('评估函数的权重可被 params 覆盖（参数扫描的前提）', () => {
  const n = 12;
  const base = api.__aiLeague('impossible', 'nightmare', n, { planLevel: 0 }, null, 1);
  const flip = api.__aiLeague('impossible', 'nightmare', n, { planLevel: 0, wAtk: -5, wHpEval: -5 }, null, 1);
  if (base.p0 === flip.p0 && base.p1 === flip.p1 && base.draw === flip.draw) {
    throw new Error('把 wAtk / wHpEval 反过来算，战绩却一模一样 —— 评估权重没有真的接进推演');
  }
});

// ── 「不可能」的留手判定：交给推演，而不是手调阈值 ──────────
// agent 2026-10 的实测改动。原来 aiTakeTurn 用 `pick.score < P.passThreshold` 决定留手，
// 阈值 -1 是手调的常数，而**它才是这一档最大的短板**：
//   写死第 0 档打噩梦，n=240 种子 1-240：111/128/1（46.3%）→ 117/122/1（48.8%）
//   另取一段互不重叠的种子，n=120 种子 500-619：55/64/1（45.8%）→ 59/60/1（49.2%）
// 现在改成「把『这一手都不出』也推演一遍，和最优出牌用同一把尺子比」（rolloutPass）。
// 为什么不干脆再手调一个更低的阈值：这套游戏里手调阈值**已经被推翻两次**
// （「困难」档的注释里有记录：-100 在旧卡池 +2.3 点，卡池换大后反而变亏）。
// 交给推演就没有这个失效模式。
// 判据：把留手门槛从 -100（几乎每步都留手）翻到 +100（几乎从不留手），战绩必须天差地别 ——
// 参数没接进决策的话两者会一模一样。实测（n=12，种子 1-12，写死 0 档）：默认 7/4/1，门槛 -100 时 0/12/0。
check('「不可能」的留手判定接进了决策，且默认开着', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'js', 'ai.js'), 'utf8');
  if (!src.includes('rolloutPass: true')) {
    throw new Error('「不可能」档没有默认打开 rolloutPass（留手判定又变回手调阈值了）');
  }
  const n = 12;
  const hold = api.__aiLeague('impossible', 'nightmare', n, { planLevel: 0, rolloutPass: true, passMargin: -100 }, null, 1);
  const play = api.__aiLeague('impossible', 'nightmare', n, { planLevel: 0, rolloutPass: true, passMargin: 100 }, null, 1);
  if (hold.p0 === play.p0 && hold.p1 === play.p1) {
    throw new Error('留手门槛 -100 与 +100 的战绩一模一样 —— rolloutPass 没有接进决策');
  }
  if (hold.p0 >= play.p0) {
    throw new Error(`几乎每步都留手（${hold.p0} 胜）没有比几乎从不留手（${play.p0} 胜）更差 —— 留手判定没起作用`);
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
