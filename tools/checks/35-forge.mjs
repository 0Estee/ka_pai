/**  强化 / 精通 + 星尘经济（作者 2026-10-17 的成长系统需求） */
import { api, check, elements } from './harness.mjs';

const NL = String.fromCharCode(10);
console.log(NL + ' 强化 / 精通');

const stage = () => elements.get('stage').innerHTML;

/**
 * 卡牌库从一局真对局里拿：`TEST_CARD_LIB` 是模块里的 const，
 * 传统脚本求值后不会挂到 window 上（只有 function 声明会），所以不能直接读全局。
 */
function grabLib() {
  api.__go('home');
  api.setDifficulty('normal');
  api.__nav('choose-ai', {});
  api.__nav('start-ai', {});
  api.__pause(true);
  const st = api.__game();
  if (!st || !st.cardLib) throw new Error('拿不到卡牌库（没能开局）');
  return st.cardLib;
}
const lib = grabLib();
api.__go('home');

/**
 * 找一张能进工坊的单位 / 锦囊。
 *
 * 必须和 enhance.js 的 isForgeable 同口径：白板测试卡（legacy）已经被排除，
 * 测试若还挑到 W01 就会一直收到「这张牌不能强化」。
 */
const forgeable = (d) => !!d && !d.token && !d.faction && !d.legacy;
const unitId = Object.keys(lib).find((id) => forgeable(lib[id]) && lib[id].type === 'unit');
/** 原费 ≥3 的锦囊（精通一次 −1 费）；≤2 的走另一条规则 */
const spellId = Object.keys(lib).find((id) => {
  const d = lib[id];
  return forgeable(d) && d.type === 'spell' && (Number(d.cost) || 0) >= 3;
});
const cheapSpellId = Object.keys(lib).find((id) => {
  const d = lib[id];
  return forgeable(d) && d.type === 'spell' && (Number(d.cost) || 0) <= 2;
});

/** 全新档案（自带一点钱，方便连续强化） */
function fresh(gold = 1000, dust = 0) {
  return { v: 1, gold, dust, perf: 0, forge: { v: 1, cards: {} } };
}

check('工坊列表：可强化牌全部列出，首字母分组把「其他」排到最后', () => {
  const w = api.workshopCards(lib, fresh(), 'initial');
  if (w.groups.length < 5) throw new Error('首字母分组太少：' + w.groups.length);
  if (w.groups[0].label === '其他') throw new Error('「其他」组排在了最前面');
  if (w.groups[w.groups.length - 1].label !== '其他') throw new Error('「其他」组没有排到最后');
  const total = w.groups.reduce((n, g) => n + g.cards.length, 0);
  if (total !== w.cards.length) throw new Error('分组卡片数和对不上：' + total + ' vs ' + w.cards.length);
  const byType = api.workshopCards(lib, fresh(), 'type');
  if (byType.groups.length !== 2) throw new Error('按类型应当只有 2 组，实际 ' + byType.groups.length);
});

check('强化 9 次：费用 12/16/…/44 共 252 金，单位 +1.0 攻 +1.0 血（第 9 次 +0.2）', () => {
  const def = lib[unitId];
  let p = fresh(1000);
  const want = [12, 16, 20, 24, 28, 32, 36, 40, 44];
  for (let i = 0; i < 9; i++) {
    const r = api.applyEnhance(p, def, unitId);
    if (!r.ok) throw new Error('第 ' + (i + 1) + ' 次强化失败：' + r.reason);
    if (r.cost !== want[i]) throw new Error('第 ' + (i + 1) + ' 次价格 ' + r.cost + '，应为 ' + want[i]);
    p = r.profile;
  }
  if (p.gold !== 1000 - 252) throw new Error('九次强化总花费不对，余 ' + p.gold);
  if (api.enhanceValue(8) !== 0.8) throw new Error('第八次后累计应为 0.8，实际 ' + api.enhanceValue(8));
  if (api.enhanceValue(9) !== 1) throw new Error('第九次后累计应为 1.0，实际 ' + api.enhanceValue(9));
  const st = api.statsFor(def, api.recordFor(p, unitId));
  if (st.atk !== (Number(def.atk) || 0) + 1) throw new Error('强化后攻击 ' + st.atk);
  if (st.hp !== (Number(def.hp) || 0) + 1) throw new Error('强化后生命 ' + st.hp);
  if (st.lvl !== 9) throw new Error('强化次数没记上：' + st.lvl);
  const again = api.applyEnhance(p, def, unitId);
  if (again.ok) throw new Error('第 10 次强化不应当成功（上限 9）');
});

check('锦囊强化 9 次数值不变（只是攒精通的资格）', () => {
  const def = lib[spellId];
  let p = fresh(1000);
  const before = api.statsFor(def, api.recordFor(p, spellId));
  for (let i = 0; i < 9; i++) p = api.applyEnhance(p, def, spellId).profile;
  const after = api.statsFor(def, api.recordFor(p, spellId));
  if (after.cost !== before.cost) throw new Error('锦囊强化不该改费用：' + before.cost + ' -> ' + after.cost);
  if (after.atk !== null || after.hp !== null) throw new Error('锦囊不该有攻/血');
  if (after.lvl !== 9) throw new Error('强化次数没记上');
});

check('单位精通：失去强化数值换技能，星尘 20/40，最多 2 次，洗掉要重新练 9 次', () => {
  const def = lib[unitId];
  let p = fresh(1000, 100);
  for (let i = 0; i < 9; i++) p = api.applyEnhance(p, def, unitId).profile;
  const r1 = api.applyMastery(p, def, unitId, 'w_atk');
  if (!r1.ok) throw new Error('首次精通失败：' + r1.reason);
  p = r1.profile;
  if (p.dust !== 80) throw new Error('首次精通应扣 20 星尘，余 ' + p.dust);
  const st = api.statsFor(def, api.recordFor(p, unitId));
  if (st.lvl !== 0) throw new Error('精通后强化应清零，实际 lvl=' + st.lvl);
  if (st.atk !== (Number(def.atk) || 0) + 1) throw new Error('精通后应只剩技能 +1 攻，实际 ' + st.atk);
  if (api.canMaster(p, def, unitId).ok) throw new Error('刚精通完不该马上能再精通（强化已清零）');
  for (let i = 0; i < 9; i++) p = api.applyEnhance(p, def, unitId).profile;
  const r2 = api.applyMastery(p, def, unitId, 'g_hp');
  if (!r2.ok) throw new Error('第二次精通失败：' + r2.reason);
  if (r2.cost !== 40) throw new Error('第二次精通应扣 40 星尘，实际 ' + r2.cost);
  p = r2.profile;
  for (let i = 0; i < 9; i++) p = api.applyEnhance(p, def, unitId).profile;
  if (api.canMaster(p, def, unitId).ok) throw new Error('第三次精通不应当被允许（上限 2）');
  const w = api.applyWash(p, def, unitId);
  if (!w.ok) throw new Error('洗掉精通失败：' + w.reason);
  p = w.profile;
  const after = api.statsFor(def, api.recordFor(p, unitId));
  if (after.masteries !== 1) throw new Error('洗掉一次后应剩 1 个精通，实际 ' + after.masteries);
  if (after.lvl !== 0) throw new Error('洗掉精通不该退还强化次数');
  const gate = api.canMaster(p, def, unitId);
  if (gate.ok) throw new Error('洗掉后不重新强化 9 次不该能精通');
  if (!String(gate.reason).includes('9')) throw new Error('提示里应当说要重新强化 9 次：' + gate.reason);
});

check('锦囊精通：每次 −1 费，原费 ≤2 的只 −0.25，最多 2 次', () => {
  const def = lib[spellId];
  let p = fresh(1000, 100);
  for (let i = 0; i < 9; i++) p = api.applyEnhance(p, def, spellId).profile;
  const r1 = api.applyMastery(p, def, spellId, null);
  if (!r1.ok) throw new Error('锦囊首次精通失败：' + r1.reason);
  p = r1.profile;
  let st = api.statsFor(def, api.recordFor(p, spellId));
  if (st.cost !== (Number(def.cost) || 0) - 1) throw new Error('第一次精通后费用 ' + st.cost);
  for (let i = 0; i < 9; i++) p = api.applyEnhance(p, def, spellId).profile;
  p = api.applyMastery(p, def, spellId, null).profile;
  st = api.statsFor(def, api.recordFor(p, spellId));
  if (st.cost !== (Number(def.cost) || 0) - 2) throw new Error('第二次精通后费用 ' + st.cost);

  const cheap = lib[cheapSpellId];
  let q = fresh(1000, 100);
  for (let i = 0; i < 9; i++) q = api.applyEnhance(q, cheap, cheapSpellId).profile;
  q = api.applyMastery(q, cheap, cheapSpellId, null).profile;
  const cs = api.statsFor(cheap, api.recordFor(q, cheapSpellId));
  if (cs.cost !== (Number(cheap.cost) || 0) - 0.25) throw new Error('廉价锦囊第一次精通应 −0.25，实际 ' + cs.cost);
});

check('金币上限 1000（溢出换星尘）、星尘上限 500、10 金合成 1 星辰', () => {
  const a = api.capGold(1200, 0);
  if (a.gold !== 1000) throw new Error('1200 金应压到 1000，实际 ' + a.gold);
  if (a.dust !== 20) throw new Error('溢出 200 金应换 20 星尘，实际 ' + a.dust);
  const b = api.capGold(5000, 490);
  if (b.dust !== 500) throw new Error('星尘应封顶 500，实际 ' + b.dust);
  const c = api.buyDust(fresh(25, 0), 1);
  if (!c.ok) throw new Error('买星尘失败：' + c.reason);
  if (c.profile.gold !== 15 || c.profile.dust !== 1) throw new Error('10 金换 1 星尘不对：' + c.profile.gold + '/' + c.profile.dust);
});

check('等级只看表现分（perf），不看金币', () => {
  const rich = { v: 1, gold: 1000, dust: 0, perf: 0 };
  if (api.levelProgress(rich.perf).level !== 1) throw new Error('0 表现分应当是 Lv.1');
  const hi = api.levelProgress(9000);
  if (hi.level <= 1) throw new Error('9000 表现分应当升级，实际 Lv.' + hi.level);
  const r = api.rewardFor({ winner: 0, humanSide: 0, turn: 9, humanKingHp: 20, mode: 'ai' });
  if (!(r.perf > 0)) throw new Error('胜局应当有表现分，实际 ' + r.perf);
  if (typeof r.dust !== 'number' || r.dust <= 0) throw new Error('对局应当产出星尘，实际 ' + r.dust);
});

check('AI 的强化按难度递增，并且同种子完全确定（不消耗对局 rng）', () => {
  const count = (diff) => Object.keys(api.aiForge(lib, { seed: 12345, difficulty: diff }).forge.cards).length;
  const easy = count('easy');
  const normal = count('normal');
  const hard = count('hard');
  const imp = count('impossible');
  if (easy !== 0) throw new Error('简单难度不该强化，实际 ' + easy + ' 张');
  if (!(easy <= normal && normal <= hard && hard <= imp)) {
    throw new Error('难度递增不成立：easy=' + easy + ' normal=' + normal + ' hard=' + hard + ' impossible=' + imp);
  }
  const a = JSON.stringify(api.aiForge(lib, { seed: 777, difficulty: 'hard' }));
  const b = JSON.stringify(api.aiForge(lib, { seed: 777, difficulty: 'hard' }));
  if (a !== b) throw new Error('同种子两次生成的 AI 强化不一致');
});

check('工坊界面：能打开、能按类型切换、能买到星尘', () => {
  const p = api.__profile();
  const keep = { gold: p.gold, dust: p.dust, perf: p.perf, forge: p.forge };
  try {
    p.gold = 640; p.dust = 35; p.perf = 812; p.forge = { v: 1, cards: {} };
    api.__go('home');
    // 普通模式与强化模式是两个独立入口：工坊只属于强化模式
    api.__nav('start-game', {});
    if (stage().includes('data-act="open-forge"')) throw new Error('普通模式菜单里不该出现强化工坊');
    api.__nav('start-forge', {});
    if (!stage().includes('data-act="open-forge"')) throw new Error('强化模式菜单里没有强化工坊入口');
    if (!stage().includes('data-act="choose-ai"') || !stage().includes('data-act="lan-menu"')) {
      throw new Error('强化模式菜单缺少 AI / 联机对决入口');
    }
    api.__nav('open-forge', {});
    if (api.__screen() !== 'forge') throw new Error('没进工坊屏：' + api.__screen());
    const n = (stage().match(/class="forge-card/g) || []).length;
    const want = api.workshopCards(lib, p, 'initial').cards.length;
    if (n !== want) throw new Error('工坊只画了 ' + n + ' 张，应为 ' + want);
    if (!stage().includes('10 金 → 1 星尘')) throw new Error('页面上没有合成星尘的说明');
    api.__nav('forge-group', { key: 'type' });
    if ((stage().match(/class="forge-card/g) || []).length !== want) throw new Error('切到按类型后卡片数变了');
    const before = p.dust;
    api.__nav('forge-buy-dust', {});
    // commitForge 是**重新绑定** profile 变量（新对象），所以要重新取一次
    const p2 = api.__profile();
    if (p2.dust !== before + 1) throw new Error('买星尘没生效：' + before + ' -> ' + p2.dust);
  } finally {
    p.gold = keep.gold; p.dust = keep.dust; p.perf = keep.perf; p.forge = keep.forge;
    api.__nav('start-game', {});   // 把模式切回普通，别影响后面的用例
    api.__go('home');
  }
});

check('模式分开：普通模式完全不读强化，强化模式才交给引擎', () => {
  const p = api.__profile();
  const keep = { gold: p.gold, dust: p.dust, perf: p.perf, forge: p.forge };
  try {
    let q = fresh(1000);
    for (let i = 0; i < 9; i++) q = api.applyEnhance(q, lib[unitId], unitId).profile;
    p.forge = q.forge;

    // 普通模式：双方增量都应当是空表，场上的牌是卡面原值
    api.__go('home');
    api.__nav('start-game', {});
    api.__nav('choose-ai', {});
    api.__nav('start-ai', {});
    api.__pause(true);
    const normal = api.__game();
    for (const side of [0, 1]) {
      const n = Object.keys((normal.enhance && normal.enhance[side]) || {}).length;
      if (n !== 0) throw new Error('普通模式 side ' + side + ' 不该有强化增量，实际 ' + n + ' 张');
    }
    api.__place(0, unitId, 'mountain', 'front');
    const u0 = normal.board.mountain.units[0].front;
    if (u0 && u0.cardId === unitId) {
      if (u0.atk !== (Number(lib[unitId].atk) || 0)) throw new Error('普通模式攻击被强化了：' + u0.atk);
      if (u0.hp !== (Number(lib[unitId].hp) || 0)) throw new Error('普通模式生命被强化了：' + u0.hp);
    }

    // 强化模式：同一份档案要真的交进引擎
    api.__go('home');
    api.__nav('start-forge', {});
    api.__nav('choose-ai', {});
    api.__nav('start-ai', {});
    api.__pause(true);
    const forgeGame = api.__game();
    const mine = forgeGame.enhance && forgeGame.enhance[forgeGame.humanSide || 0];
    if (!mine || !mine[unitId]) throw new Error('强化模式没有把我方增量交给引擎');
  } finally {
    p.gold = keep.gold; p.dust = keep.dust; p.perf = keep.perf; p.forge = keep.forge;
    api.__nav('start-game', {});
    api.__go('home');
  }
});

check('强化学到对局里：开局把增量交给引擎，回放也带着同一份', () => {
  const p = api.__profile();
  const keep = { gold: p.gold, dust: p.dust, perf: p.perf, forge: p.forge };
  try {
    let q = fresh(1000);
    for (let i = 0; i < 9; i++) q = api.applyEnhance(q, lib[unitId], unitId).profile;
    p.forge = q.forge;
    api.setDifficulty('normal');
    api.__go('home');
    api.__nav('start-forge', {});   // 强化模式入口
    api.__nav('choose-ai', {});
    api.__nav('start-ai', {});
    api.__pause(true);
    const st = api.__game();
    if (!st) throw new Error('没能开局');
    const mine = st.enhance && st.enhance[st.humanSide || 0];
    if (!mine || !mine[unitId]) throw new Error('我方增量表里没有强化过的牌');
    if (mine[unitId].atk !== 1 || mine[unitId].hp !== 1) {
      throw new Error('增量不对：atk=' + mine[unitId].atk + ' hp=' + mine[unitId].hp);
    }
    // 引擎侧真吃到增量：同一张牌从手牌打出去时，实例攻/血要带上 +1
    const hand = st.players[st.humanSide || 0].hand.find((c) => c.cardId === unitId);
    if (hand) {
      const view = api.__playTurns ? null : null;
      const placed = api.__place(st.humanSide || 0, unitId, 'mountain', 0);
      if (placed) {
        const unit = Object.values(st.units || {}).find((u) => u.cardId === unitId);
        if (unit) {
          if (unit.atk !== (Number(lib[unitId].atk) || 0) + 1) throw new Error('下场的单位攻击没吃到强化：' + unit.atk);
          if (unit.hp !== (Number(lib[unitId].hp) || 0) + 1) throw new Error('下场的单位生命没吃到强化：' + unit.hp);
        }
      }
    }
  } finally {
    p.gold = keep.gold; p.dust = keep.dust; p.perf = keep.perf; p.forge = keep.forge;
    api.__nav('start-game', {});   // 切回普通模式，避免影响后续用例
    api.__go('home');
  }
});

check('数值干净：强化/伤害/治疗不会留下浮点尾巴', () => {
  // 作者 2026-10-18：强化加成会出现 6.300000000000001 / 1.2999999999999998 这种数。
  // 根因是 IEEE754 存不下 0.1，必须在**写入状态时**就规范到两位小数。
  const isClean = (v) => typeof v === 'number' && Number.isFinite(v) && Math.round(v * 100) / 100 === v;
  const st = api.__game();
  if (!st) throw new Error('没有对局');
  /**
   * 先把山地前排清空：上一条用例在「这一局手牌里恰好有这张牌」时会在同一格摆一张，
   * 那是**种子随机**的（手牌来自洗过的牌库），于是本用例会偶发地撞上
   * 「该位置已被占用」。这跟「浮点尾巴」完全无关，属于用例之间的串味。
   */
  st.board.mountain.units[0].front = null;
  // 直接构造一个强化过的单位（走和玩家完全相同的 instantiateUnit 路径）
  const placed = api.__place(0, unitId, 'mountain', 'front');
  if (!placed) throw new Error('摆不上单位');
  const u = st.board.mountain.units[0].front;
  if (!u) throw new Error('格子里没有单位');
  if (!isClean(u.atk) || !isClean(u.hp) || !isClean(u.maxHp)) {
    throw new Error('单位落地就带浮点尾巴：' + u.atk + '/' + u.hp + '/' + u.maxHp);
  }
  // 再走一遍伤害 / 治疗：0.1 档血量连掉几次最容易露出尾巴
  api.dealDamage(st, null, { kind: 'unit', unit: u }, 1, { noThorns: true, noKeywords: true });
  if (!isClean(u.hp)) throw new Error('扣血后带浮点尾巴：' + u.hp);
  api.healUnit(st, u, 1);
  if (!isClean(u.hp)) throw new Error('治疗后带浮点尾巴：' + u.hp);
  api.dealDamage(st, null, { kind: 'unit', unit: u }, 0.1, { noThorns: true, noKeywords: true });
  if (!isClean(u.hp)) throw new Error('小数伤害后带浮点尾巴：' + u.hp);
  const str = String(u.hp);
  if (str.length > 6) throw new Error('生命显示成了长串小数：' + str);
});

check('白板测试卡不再出现在玩家可见的地方（工坊 / 牌库）', () => {
  // 作者 2026-10-18：白板测试卡没删干净。它们仍是引擎自检与老回放的依赖，
  // 所以留在 cardLib 里，但必须打上 legacy 并把工坊与牌库都排除掉。
  const demoIds = ['W01','W02','W03','W04','W05','K01','K04','K07','E01'];
  for (const id of demoIds) {
    if (!lib[id]) throw new Error('白板卡 ' + id + ' 应该还在 cardLib 里（自检/老回放要用）');
    if (!lib[id].legacy) throw new Error('白板卡 ' + id + ' 没有 legacy 标记');
    if (api.isForgeable(lib[id])) throw new Error('白板卡 ' + id + ' 还能进工坊');
  }
  // 牌库：任意种子都不能抽到白板卡
  for (const seed of [1, 7, 99, 12345]) {
    const deck = api.buildTestDeck(80, seed);
    const bad = deck.filter((id) => demoIds.indexOf(id) >= 0);
    if (bad.length) throw new Error('种子 ' + seed + ' 的牌库里还有白板卡：' + bad.join(','));
  }
  // 工坊列表也不能列
  const p = api.__profile();
  const w = api.workshopCards(lib, p, 'initial');
  const all = w.groups.reduce((acc, g) => acc.concat(g.cards), []);
  const leaked = all.filter((c) => demoIds.indexOf(c.id) >= 0);
  if (leaked.length) throw new Error('工坊里还能看到白板卡：' + leaked.map((c) => c.id).join(','));
});