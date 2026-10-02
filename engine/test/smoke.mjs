/**
 * 规则引擎回归测试
 *
 *  这个文件在 2026-10 的一次编辑事故里被误写为空、且没有版本控制与副本，
 *   原 245 条测试无法找回。现在这份是**按规则文档重建**的：
 *   依据 = docs/规则书-v0.2.md 的 0 裁决记录（D1~D66）+ 各章结算细节、
 *          docs/裁决清单.md 的「引擎实现状态」、engine/README.md 的速查表、engine/src 源码本身。
 *   重建是分批进行的：每条测试名后面标注它守的是哪一条裁决/词条，方便对照补漏。
 *
 * 跑法：node engine/test/smoke.mjs
 */
import * as G from '../src/engine.js';
import * as M from '../src/mechanics.js';
import { instantiateUnit } from '../src/setup.js';
import { matchesTargetFilter, isFrozen } from '../src/keywords.js';
import { filterCtx, effectiveAtk, hasRooted } from '../src/auras.js';
import { trapsOf, visibleMana } from '../src/board.js';
import { LANES, ROWS } from '../src/constants.js';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { TEST_CARD_LIB, buildTestDeck } from '../cards/test-cards.js';

const CHK = String.fromCharCode(0x2713);   // 对勾
const CROSS = String.fromCharCode(0x2717);
const BAR = String.fromCharCode(0x2500).repeat(56);
const OK_ALL = String.fromCharCode(0x2705);
const BAD = String.fromCharCode(0x274C);

//  迷你测试框架 
let passed = 0;
const failures = [];
let groupName = '';

function group(name) {
  groupName = name;
  console.log('\n' + name);
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ' + CHK + ' ' + name);
  } catch (err) {
    failures.push({ group: groupName, name, message: err.message });
    console.log('  ' + CROSS + ' ' + name);
    console.log('      ' + err.message);
  }
}

const assert = {
  ok(v, msg) {
    if (!v) throw new Error((msg || '期望为真') + '，实际 ' + JSON.stringify(v));
  },
  equal(a, b, msg) {
    if (a !== b) throw new Error((msg || '值不相等') + '：期望 ' + b + '，实际 ' + a);
  },
  notEqual(a, b, msg) {
    if (a === b) throw new Error((msg || '值不该相等') + '：都是 ' + a);
  },
  deepEqual(a, b, msg) {
    const x = JSON.stringify(a);
    const y = JSON.stringify(b);
    if (x !== y) throw new Error((msg || '深比较不等') + '：期望 ' + y + '，实际 ' + x);
  },
  throws(fn, msg) {
    let threw = false;
    try { fn(); } catch (e) { threw = true; }
    if (!threw) throw new Error(msg || '期望抛错，但没有抛');
  },
};

//  辅助函数 
const DEFAULT_SEED = 20240501;

/** 建一局：默认 80 张牌库（够抽很久，不会因抽空收场）；autoResolveChoices 打开免去真人交互 */
function game(cfg = {}) {
  const seed = cfg.seed === undefined ? DEFAULT_SEED : cfg.seed;
  const state = G.createGame({
    seed,
    firstPlayer: cfg.firstPlayer === undefined ? 0 : cfg.firstPlayer,
    deck: cfg.deck || buildTestDeck(80, seed),
    cardLib: cfg.cardLib || TEST_CARD_LIB,
  });
  G.startGame(state);
  state.autoResolveChoices = true;
  return state;
}

/** 直接塞一张牌进手牌（不走抽牌），返回手牌实例 */
function give(state, side, cardId, extra = {}) {
  const hc = Object.assign({ iid: state.nextIid++, cardId }, extra);
  state.players[side].hand.push(hc);
  return hc;
}

/** 把阶段强制切到某方行动的阶段（deploy=单位回合 / spell=锦囊回合），并给足费用 */
function forcePhase(state, side, kind = 'spell') {
  const first = state.firstPlayer === side;
  const phase = kind === 'spell'
    ? (first ? 'SPELL_FIRST' : 'SPELL_SECOND')
    : (first ? 'DEPLOY_FIRST' : 'DEPLOY_SECOND');
  G.enterPhase(state, phase);
  const p = state.players[side];
  p.manaCap = Math.max(p.manaCap, 99);
  p.mana = 99;
  return state;
}

/** 走真实出牌路径打一张锦囊 */
function cast(state, side, cardId, opts = {}) {
  forcePhase(state, side, 'spell');
  const hc = give(state, side, cardId);
  G.playCard(state, side, hc.iid, opts);
  return state;
}

/** 走真实出牌路径打一个单位（会触发「打出」异能） */
function playUnit(state, side, cardId, lane, row) {
  forcePhase(state, side, 'deploy');
  const hc = give(state, side, cardId);
  G.playCard(state, side, hc.iid, { lane, row });
  return state.board[lane].units[side][row];
}

/** 直接把单位摆上场（静默：不花费用、不触发「打出」），用于搭场面 */
function deploy(state, side, cardId, lane, row) {
  const u = instantiateUnit(state, state.cardLib[cardId], side, lane, row);
  state.board[lane].units[side][row] = u;
  return u;
}

/** 场上某个位置上的单位 */
function at(state, lane, side, row) {
  return state.board[lane].units[side][row] || null;
}

/** 国王血量 */
function king(state, side) {
  return state.players[side].kingHp;
}

/** 结算一次开战：推进到 COMBAT 并走完它 */
function combat(state) {
  let guard = 0;
  while (state.phase !== 'COMBAT' && !G.isOver(state) && guard++ < 20) G.advance(state);
  if (state.phase === 'COMBAT' && !G.isOver(state)) G.advance(state);
  return state;
}

/** 推进到下一个回合 */
function nextTurn(state) {
  const t = state.turn;
  let guard = 0;
  while (state.turn === t && !G.isOver(state) && guard++ < 40) G.advance(state);
  return state;
}

// 
group('1 建局与回合流程');
// 

test('开局手牌 6/5 = 起手 5/4（D1）+ 第 1 回合开始各抽 1（D1, DRAW_ON_FIRST_TURN）', () => {
  const s = game();
  // startGame 先发「起手」：先手 5、后手 4（规则书 2）；
  // 紧接着 enterPhase(TURN_START) 会执行「每回合开始双方各抽 1 张」，第 1 回合也不例外
  //（constants.js 的 DRAW_ON_FIRST_TURN = true），所以 observable 的开局手牌是 6/5。
  assert.equal(s.players[0].hand.length, 6, '先手 = 5 起手 + 1 抽牌');
  assert.equal(s.players[1].hand.length, 5, '后手 = 4 起手 + 1 抽牌');
});

test('共享牌库：双方抽同一个牌库，开局共发掉 11 张（D1）', () => {
  const s = game();
  // 9 张起手 + 第 1 回合开始的 2 张。双方共用同一个 deck（D1），
  // 所以「我抽到强牌」=「对手少一张强牌」。
  assert.equal(s.deck.length, 80 - 11, '80 张牌库开局后应剩 69');
  const ids = s.players[0].hand.concat(s.players[1].hand).map((c) => c.cardId);
  assert.equal(new Set(ids).size > 0, true, '双方手牌来自同一个牌库实例');
});

test('费用上限 = 回合数（规则书 6）', () => {
  const s = game();
  assert.equal(s.players[0].manaCap, 1, '第 1 回合');
  nextTurn(s);
  assert.equal(s.players[0].manaCap, 2, '第 2 回合');
});

test('阶段顺序固定：TURN_START / DEPLOY_FIRST / DEPLOY_SECOND / SPELL_FIRST / SPELL_SECOND / COMBAT / TURN_END', () => {
  const s = game();
  const seen = [s.phase];
  let guard = 0;
  while (s.turn === 1 && guard++ < 12) {
    G.advance(s);
    if (s.turn === 1) seen.push(s.phase);
  }
  assert.deepEqual(seen, [
    'TURN_START', 'DEPLOY_FIRST', 'DEPLOY_SECOND', 'SPELL_FIRST', 'SPELL_SECOND', 'COMBAT', 'TURN_END',
  ]);
});

test('先后手：firstPlayer=1 时 DEPLOY_FIRST 由 1 号行动（规则书 4）', () => {
  const s = game({ firstPlayer: 1 });
  G.advance(s);
  assert.equal(s.phase, 'DEPLOY_FIRST');
  assert.equal(G.getActor(s), 1, '先手应该是 1 号');
});

test('每回合开始双方各抽 1 张（D1）', () => {
  const s = game();
  const before = [s.players[0].hand.length, s.players[1].hand.length];
  nextTurn(s);
  assert.equal(s.players[0].hand.length, before[0] + 1);
  assert.equal(s.players[1].hand.length, before[1] + 1);
});

test('国王初始 20 血（D15 / C4）', () => {
  const s = game();
  assert.equal(king(s, 0), 20);
  assert.equal(king(s, 1), 20);
});

test('同种子 = 完全相同的对局（回放与联机确定性的地基）', () => {
  const a = game({ seed: 777 });
  const b = game({ seed: 777 });
  assert.deepEqual(a.players[0].hand.map((c) => c.cardId), b.players[0].hand.map((c) => c.cardId));
  assert.deepEqual(a.deck.slice(0, 10).map((c) => c.cardId), b.deck.slice(0, 10).map((c) => c.cardId));
});

// 
group('2 放置与占位（D3 / D4 / K07~K09）');
// 

test('默认单位不能放在水路（DEFAULT_FORBIDDEN_LANES）', () => {
  const s = game();
  const places = G.legalPlacements(s, 0, s.cardLib.W03);
  assert.ok(places.every((p) => p.lane !== 'water'), '水路不该是合法落点');
  assert.ok(places.some((p) => p.lane === 'mountain'), '山地应该能放');
});

test('水生单位只能放在水路（K07）', () => {
  const s = game();
  const places = G.legalPlacements(s, 0, s.cardLib.K07);
  assert.ok(places.length > 0, '水路应该有落点');
  assert.ok(places.every((p) => p.lane === 'water'), '水生只能水路');
});

test('两栖单位可以放在水路也可放在陆地（K08）', () => {
  const s = game();
  const places = G.legalPlacements(s, 0, s.cardLib.K08);
  assert.ok(places.some((p) => p.lane === 'water'), '水路可放');
  assert.ok(places.some((p) => p.lane === 'mountain'), '陆地可放');
});

test('每路每方默认只能站 1 个（D4）', () => {
  const s = game();
  deploy(s, 0, 'W03', 'mountain', 'front');
  const places = G.legalPlacements(s, 0, s.cardLib.W03);
  assert.ok(!places.some((p) => p.lane === 'mountain'), '山地已站一个，不该再有落点');
  assert.ok(places.some((p) => p.lane === 'plainL'), '别的线仍然能放');
});

test('组合解锁同线第 2 个身位（D4 / K14）', () => {
  const s = game();
  deploy(s, 0, 'K14', 'mountain', 'front');
  const places = G.legalPlacements(s, 0, s.cardLib.W03);
  assert.ok(places.some((p) => p.lane === 'mountain' && p.row === 'back'), '组合应解锁同线后排');
  assert.ok(!places.some((p) => p.lane === 'mountain' && p.row === 'front'), '前排已被占');
});

test('轻灵：满血可留水路，掉到半血以下在水路被消灭（K09）', () => {
  const s = game();
  const u = deploy(s, 0, 'K09', 'water', 'front'); // 轻灵风灵 3/4
  M.checkAllNimble(s);
  assert.ok(!u.removed, '满血时不该被消灭');
  M.dealDamage(s, null, { kind: 'unit', unit: u }, 3); // 4 -> 1，低于 ceil(4/2)=2
  M.checkAllNimble(s);
  assert.ok(u.removed, '低于半血且在水路应当被消灭');
});

// 
group('3 开战结算（D7 / D8 / D9 / D17 / D18 / K16 / K18）');
// 

test('前排阻挡：攻击打向敌方前排，不是国王（D17）', () => {
  const s = game();
  const attacker = deploy(s, 0, 'W04', 'mountain', 'front'); // 5/6
  const blocker = deploy(s, 1, 'W02', 'mountain', 'front');  // 2/1
  combat(s);
  assert.ok(blocker.removed, '2/1 的前排会被 5 攻打掉');
  assert.equal(attacker.hp, 6 - 2, '它同时承受对方的 2 点攻击');
  assert.equal(king(s, 1), 20, '有阻挡时不该直接打国王');
});

test('0 攻单位仍然阻挡，只是不造成伤害（D9）', () => {
  const s = game();
  const attacker = deploy(s, 0, 'W04', 'mountain', 'front'); // 5/6
  const wall = deploy(s, 1, 'W05', 'mountain', 'front');     // 0/4
  combat(s);
  assert.ok(wall.removed, '0 攻也会被打掉');
  assert.equal(attacker.hp, 6, '0 攻不造成伤害');
  assert.equal(king(s, 0), 20, '有阻挡时不该打国王');
});

test('这条线没有敌方单位时，攻击直接打国王（D17）', () => {
  const s = game();
  deploy(s, 0, 'W04', 'mountain', 'front'); // 5 攻
  combat(s);
  assert.equal(king(s, 1), 20 - 5);
});

test('同线前后排同时攻击，伤害叠加（D7 / D8）', () => {
  const s = game();
  deploy(s, 0, 'K14', 'mountain', 'front'); // 阵列队长 2/3 组合
  deploy(s, 0, 'W03', 'mountain', 'back');  // 2/4
  const blocker = deploy(s, 1, 'W04', 'mountain', 'front'); // 5/6
  combat(s);
  assert.equal(blocker.hp, 6 - 2 - 2, '同线两个单位都打它，2+2 叠加');
});

test('交战优先级：先打前排，一次攻击不会顺手波及后排（D17）', () => {
  const s = game();
  deploy(s, 1, 'K14', 'mountain', 'front');  // 组合，解锁后排
  const back = deploy(s, 1, 'W02', 'mountain', 'back'); // 2/1
  deploy(s, 0, 'W04', 'mountain', 'front');  // 5/6
  combat(s);
  assert.ok(!back.removed, '这次攻击的目标是前排，不该顺手把后排也打了');
});

test('穿透 X：主要目标之外额外命中 X 个（K18）', () => {
  const s = game();
  deploy(s, 0, 'K18', 'mountain', 'front');  // 破阵枪骑 3/3 穿透1
  deploy(s, 1, 'K14', 'mountain', 'front');  // 组合，让同线有后排
  const back = deploy(s, 1, 'W02', 'mountain', 'back'); // 2/1
  combat(s);
  assert.ok(back.removed, '穿透 1 应该额外命中后排那个 2/1');
});

test('溅射 X：对相邻左右线路各造成 X 点（K16）', () => {
  const s = game();
  deploy(s, 0, 'K16', 'plainL', 'front');    // 投石车 3/3 溅射1
  const left = deploy(s, 1, 'W04', 'mountain', 'front');  // 5/6 相邻
  const right = deploy(s, 1, 'W04', 'plainR', 'front');   // 5/6 相邻
  combat(s);
  assert.equal(left.hp, 5, '左侧溅射 1 点');
  assert.equal(right.hp, 5, '右侧溅射 1 点');
});

// 
group('4 伤害管线与替代式词条（K04 / K05 / K06 / K13 / K17 / K03 / K22）');
// 

test('装甲 X：受到的伤害减少 X（K04）', () => {
  const s = game();
  const u = deploy(s, 0, 'K04', 'mountain', 'front'); // 铁甲卫士 2/4 装甲1
  const src = deploy(s, 1, 'W04', 'plainL', 'front');
  M.dealDamage(s, src, { kind: 'unit', unit: u }, 3);
  assert.equal(u.hp, 4 - (3 - 1), '3 点伤害先减 1 再扣血');
});

test('祝福 X：超过 X 的伤害被封顶为 X（K06）', () => {
  const s = game();
  const u = deploy(s, 0, 'K06', 'mountain', 'front'); // 圣光庇护者 2/4 祝福2
  const src = deploy(s, 1, 'W04', 'plainL', 'front');
  M.dealDamage(s, src, { kind: 'unit', unit: u }, 5);
  assert.equal(u.hp, 4 - 2, '5 点被祝福封顶成 2');
});

test('结算链顺序：祝福先封顶、装甲再减伤（B6）', () => {
  const s = game();
  const u = deploy(s, 0, 'K06b', 'mountain', 'front'); // 圣盾铁卫 2/4 祝福2 + 装甲1
  const src = deploy(s, 1, 'W04', 'plainL', 'front');
  M.dealDamage(s, src, { kind: 'unit', unit: u }, 5);
  // 原始 5 -> 祝福封顶 2 -> 装甲减 1 -> 最终 1
  assert.equal(u.hp, 4 - 1, '最终应该只掉 1 点');
});

test('荆棘 X：按最终伤害反弹给来源（K05）；反弹不再触发荆棘', () => {
  const s = game();
  const thorn = deploy(s, 0, 'K05', 'mountain', 'front'); // 荆棘藤蔓 1/3 荆棘2
  const src = deploy(s, 1, 'W04', 'plainL', 'front');     // 5/6
  M.dealDamage(s, src, { kind: 'unit', unit: thorn }, 2);
  assert.equal(thorn.hp, 3 - 2, '荆棘单位挨了 2 点');
  assert.equal(src.hp, 6 - 2, '来源应被反弹 2 点（按最终伤害）');
});

test('无敌：免疫伤害，但不免疫「消灭」（K13 / B7）', () => {
  const s = game();
  const inv = deploy(s, 0, 'K13', 'mountain', 'front'); // 不灭圣灵 1/3 无敌
  const src = deploy(s, 1, 'W04', 'plainL', 'front');
  assert.equal(M.dealDamage(s, src, { kind: 'unit', unit: inv }, 5), 0, '无敌不吃伤害');
  assert.equal(inv.hp, 3, '血量不该变');
  M.destroyUnit(s, inv, 'test');
  G.flushTriggers(s);
  assert.ok(inv.removed, '无敌不免疫消灭');
});

test('淬毒 X：下个回合开始时额外受 X 点，且无视装甲与祝福（K17）', () => {
  const s = game();
  const src = deploy(s, 0, 'K17', 'mountain', 'front');   // 毒刃刺客 2/3 淬毒2
  const victim = deploy(s, 1, 'K06b', 'plainL', 'front'); // 祝福2 + 装甲1
  // 打 3 点：祝福把 >2 的封到 2，装甲再减 1 -> 实际造成 1 点（>0，所以淬毒会挂上）
  M.dealDamage(s, src, { kind: 'unit', unit: victim }, 3);
  assert.equal(victim.hp, 4 - 1, '3 点经「祝福封顶 2 -> 装甲减 1」后实际掉 1');
  nextTurn(s);
  // 毒伤 2 点走 ignoreMechanisms：装甲与祝福都不参与，所以是 3 - 2 = 1
  //（若毒被装甲减 1，结果会是 2  这条断言正是在抓那个）
  assert.equal(victim.hp, 3 - 2, '毒伤无视装甲与祝福');
});

test('疾病：目标在下个回合开始时被消灭（K03）', () => {
  const s = game();
  const src = deploy(s, 0, 'K03', 'mountain', 'front');   // 瘟疫使者 2/3 疾病
  const victim = deploy(s, 1, 'W04', 'plainL', 'front');  // 5/6
  M.dealDamage(s, src, { kind: 'unit', unit: victim }, 1);
  assert.ok(!victim.removed, '当下不该死');
  nextTurn(s);
  assert.ok(victim.removed, '下个回合开始时应被疾病消灭');
});

test('必中：忽略阻挡直接打国王，且伤害不可被免疫（K22）', () => {
  const s = game();
  s.cardLib.T90 = { id: 'T90', name: '测试必中', type: 'unit', cost: 4, atk: 3, hp: 3, keywords: ['trueStrike'] };
  const a = deploy(s, 0, 'T90', 'mountain', 'front');
  const blocker = deploy(s, 1, 'W04', 'mountain', 'front'); // 5/6 挡在前面
  combat(s);
  assert.equal(king(s, 1), 20 - 3, '必中应当直接打国王');
  assert.ok(!blocker.removed || blocker.hp === 6, '阻挡者不该被这次攻击打到');
});

// 
group('5 战斗词条（K01 / K02 / K25 / K20）');
// 

test('双重打击：同一次交战攻击两次（K01）', () => {
  const s = game();
  deploy(s, 0, 'K01', 'mountain', 'front'); // 双刃剑客 2/3 双重打击
  const wall = deploy(s, 1, 'W05', 'mountain', 'front'); // 石墙 0/4
  combat(s);
  assert.ok(wall.removed, '2 攻打两次 = 4 点，0/4 的石墙应当被打掉');
});

test('对照：没有双重打击的 2/4 单位打不死 0/4 的石墙', () => {
  const s = game();
  deploy(s, 0, 'W03', 'mountain', 'front'); // 白板重装 2/4
  const wall = deploy(s, 1, 'W05', 'mountain', 'front'); // 石墙 0/4
  combat(s);
  assert.ok(!wall.removed, '只打一次 2 点，石墙应当活着');
  assert.equal(wall.hp, 2);
});

test('狂热：交战消灭敌人且自身存活后，额外攻击一次（K02）', () => {
  const s = game();
  deploy(s, 0, 'K02', 'mountain', 'front'); // 嗜血狂徒 3/3 狂热
  deploy(s, 1, 'W02', 'mountain', 'front'); // 白板卫士 2/1
  combat(s);
  assert.equal(king(s, 1), 20 - 3, '打死阻挡者后额外那一次应当打国王（这条线已清空）');
});

test('无法攻击：开战时不出手，但照样会被打（K25）', () => {
  const s = game();
  s.cardLib.T91 = { id: 'T91', name: '测试卫兵', type: 'unit', cost: 3, atk: 4, hp: 4, keywords: ['cannotAttack'] };
  const guard = deploy(s, 0, 'T91', 'mountain', 'front');
  deploy(s, 1, 'W04', 'mountain', 'front'); // 5/6
  combat(s);
  assert.equal(king(s, 1), 20, '它不该对敌方国王造成伤害');
  assert.equal(guard.hp, 4 - 5, '但它自己照样挨打');
});

test('冻结：下一次攻击不进行并解除冻结（K20）', () => {
  const s = game();
  const u = deploy(s, 0, 'W03', 'mountain', 'front'); // 2/4
  deploy(s, 1, 'W05', 'mountain', 'front');           // 0/4 只挨打不还手
  M.freezeUnit(s, u);
  assert.ok(isFrozen(u), '冻结标记应当挂上');
  combat(s);
  assert.ok(!isFrozen(u), '攻击被跳过之后应当解冻');
  assert.equal(king(s, 1), 20, '被冻结的这次不攻击，国王不该掉血');
});

// 
group('6 胜负与终局（A3 / D13 / D19）');
// 

test('国王归零：对方获胜', () => {
  const s = game();
  const src = deploy(s, 0, 'W04', 'mountain', 'front');
  M.dealDamage(s, src, { kind: 'king', side: 1 }, 20);
  G.checkGameOver(s);
  assert.equal(s.winner, 0, '1 号国王被打到 0，0 号应当获胜');
});

test('双方国王同时归零：判平局（A3）', () => {
  const s = game();
  const src = deploy(s, 0, 'W04', 'mountain', 'front');
  s.players[0].kingHp = 0;
  s.players[1].kingHp = 0;
  G.checkGameOver(s);
  assert.equal(s.winner, 'draw', '同时归零应当平局');
});

test('牌库抽空：该回合结束时国王血量高者获胜（D13 / D19）', () => {
  const s = game();
  s.players[0].kingHp = 20;
  s.players[1].kingHp = 11;
  s.deck = [];
  // deckEmpty 是在「抽牌失败」那一刻才置位的（stats.js），所以必须让一次抽牌真的落空：
  // 推进到下一回合的 TURN_START 就会发生。
  nextTurn(s);
  assert.ok(s.deckEmpty, '抽牌落空后应当置上 deckEmpty');
  // 再到这个回合的 TURN_END，onTurnEnd 按 D13 判胜
  let guard = 0;
  while (s.phase !== 'TURN_END' && !G.isOver(s) && guard++ < 20) G.advance(s);
  if (s.phase === 'TURN_END' && !G.isOver(s)) G.advance(s);
  assert.equal(s.winner, 0, '牌库空了，回合结束时血高的 0 号获胜');
});

// 
group('7 触发式异能与观察者（D20 / D21 / D22）');
// 

test('「打出:」异能：斥候打出时抽一张（E01）', () => {
  const s = game();
  const deckBefore = s.deck.length;
  const handBefore = s.players[0].hand.length;
  playUnit(s, 0, 'E01', 'mountain', 'front'); // 走真实出牌路径才会触发 onPlay
  assert.equal(s.players[0].hand.length, handBefore + 1, 'give 进 1 张、打出用掉 1 张、异能再抽 1 张');
  assert.equal(s.deck.length, deckBefore - 1, '牌库少了一张');
});

test('「被消灭:」异能：复仇亡魂阵亡时对敌方国王造成 2 点（E02）', () => {
  const s = game();
  const u = deploy(s, 0, 'E02', 'mountain', 'front'); // 2/2
  M.destroyUnit(s, u, 'test');
  G.flushTriggers(s);
  assert.equal(king(s, 1), 20 - 2, '遗言应当打到敌方国王');
});

test('「造成伤害:」异能：淬毒蜘蛛命中后再补 1 点（E03）', () => {
  const s = game();
  const spider = deploy(s, 0, 'E03', 'mountain', 'front'); // 1/4
  const victim = deploy(s, 1, 'W04', 'plainL', 'front');   // 5/6（场上唯一的敌人，自动代答会选中它）
  M.dealDamage(s, spider, { kind: 'unit', unit: victim }, 1);
  G.flushTriggers(s);
  assert.equal(victim.hp, 6 - 1 - 1, '普通伤害 1 点 + 异能追加 1 点');
});

test('观察者：有敌人受到伤害时对其追加 1 点（D20，鲨鱼 U07）', () => {
  const s = game();
  deploy(s, 0, 'U07', 'mountain', 'front');  // 鲨鱼 3/4 观察者
  const src = deploy(s, 0, 'W03', 'plainR', 'front');
  const victim = deploy(s, 1, 'W04', 'plainL', 'front'); // 5/6
  M.dealDamage(s, src, { kind: 'unit', unit: victim }, 1);
  G.flushTriggers(s);
  assert.equal(victim.hp, 6 - 1 - 1, '观察者再打它 1 点');
});

test('观察者不追击国王（D21，国王不是单位）', () => {
  const s = game();
  deploy(s, 0, 'U07', 'mountain', 'front');
  const src = deploy(s, 0, 'W03', 'plainR', 'front');
  M.dealDamage(s, src, { kind: 'king', side: 1 }, 3);
  G.flushTriggers(s);
  assert.equal(king(s, 1), 20 - 3, '打国王不该惊动观察者，否则伤害会被放大一遍');
});

test('观察者不连锁（D22）：两个鲨鱼在场，一次伤害只追加确定的 2 点', () => {
  const s = game();
  deploy(s, 0, 'U07', 'mountain', 'front');
  deploy(s, 0, 'U07', 'plainL', 'front');
  const src = deploy(s, 0, 'W03', 'plainR', 'front');
  const victim = deploy(s, 1, 'W04', 'plainL', 'back'); // 5/6
  M.dealDamage(s, src, { kind: 'unit', unit: victim }, 1);
  G.flushTriggers(s);
  assert.equal(victim.hp, 6 - 1 - 1 - 1, '两个观察者各追加 1 点；它们自己造成的伤害不再惊动彼此');
});

// 
group('8 光环与国王附着被动（D24 / D26 / D27 / D62）');
// 

test('光环是「读取时叠加」，不改单位的裸攻击力（D26，老鼠 U74）', () => {
  const s = game();
  deploy(s, 0, 'U74', 'mountain', 'front');                // 老鼠：自己线上的敌人 -1 攻
  const enemy = deploy(s, 1, 'W04', 'mountain', 'front');  // 5/6
  assert.equal(effectiveAtk(s, enemy), 4, '同线敌人的有效攻击力 -1');
  assert.equal(enemy.atk, 5, '裸攻击力不该被改（光环只在读取时叠加）');
});

test('光环范围：自身线路 + 相邻线路（战棋 U102）', () => {
  const s = game();
  const same = deploy(s, 0, 'W03', 'mountain', 'front');
  const adj = deploy(s, 0, 'W03', 'plainL', 'front');
  const far = deploy(s, 0, 'W03', 'water', 'front');
  deploy(s, 0, 'U102', 'plainL', 'back'); // 战棋放在 plainL
  assert.equal(effectiveAtk(s, same), 3, '战棋在 plainL，山地是相邻线 +1');
  assert.equal(effectiveAtk(s, adj), 3, '同线 +1');
  assert.equal(effectiveAtk(s, far), 2, '水路不相邻，不加');
});

test('光环可以授予词条：拷问官让本线敌人获「扎根」，再对所有扎根的敌人 -3 攻（D24）', () => {
  const s = game();
  deploy(s, 0, 'U12', 'mountain', 'front');                 // 拷问官
  const inLane = deploy(s, 1, 'W04', 'mountain', 'front');  // 同线 -> 获扎根
  const other = deploy(s, 1, 'W04', 'plainL', 'front');     // 不同线 -> 不获扎根
  assert.ok(hasRooted(s, inLane), '同线敌人应当获得扎根');
  assert.ok(!hasRooted(s, other), '别的线不该获得扎根');
  assert.equal(effectiveAtk(s, inLane), 5 - 3, '扎根的敌人 -3 攻');
  assert.equal(effectiveAtk(s, other), 5, '没扎根的敌人不受第二条光环影响');
});

test('封印光环：大封印碑在场时，敌方被封印的单位连自己的光环也停掉（D62 / U370）', () => {
  const s = game();
  deploy(s, 0, 'U370', 'mountain', 'front');               // 大封印碑：封印敌方全体
  const banner = deploy(s, 1, 'U102', 'plainL', 'back');   // 敌方战棋：给同线队友 +1 攻
  const mate = deploy(s, 1, 'W03', 'plainL', 'front');     // 它的队友 2/4
  assert.equal(effectiveAtk(s, mate), 2, '战棋被大封印碑罩住，光环不该再给队友加攻');
  assert.ok(banner, '（战棋本身仍在场，只是它的光环失效）');
});

test('封印：一次性封印同样停掉被封印单位的光环（D62）', () => {
  const s = game();
  const mate = deploy(s, 0, 'W03', 'mountain', 'front');
  const banner = deploy(s, 0, 'U102', 'mountain', 'back'); // 给同线 +1 攻
  assert.equal(effectiveAtk(s, mate), 3, '没封印时同线 +1');
  M.sealUnit(s, banner);
  G.flushTriggers(s);
  assert.equal(effectiveAtk(s, mate), 2, '战棋被封印后，它的光环应当消失');
});

test('封印：被封印单位的「祝福 / 装甲 / 无敌」都不再生效（D62）', () => {
  const s = game();
  const src = deploy(s, 0, 'W04', 'plainR', 'front');
  // 一次性封印：祝福与装甲都要停
  const blessed = deploy(s, 1, 'K06b', 'plainL', 'front'); // 2/4 祝福2 + 装甲1
  M.sealUnit(s, blessed);
  G.flushTriggers(s);
  M.dealDamage(s, src, { kind: 'unit', unit: blessed }, 5);
  assert.ok(blessed.removed, '封印后祝福与装甲都失效：5 点应当直接打掉 2/4');
  // 光环式封印（大封印碑）：同样要停
  const s2 = game();
  deploy(s2, 0, 'U370', 'mountain', 'front');              // 大封印碑：封印敌方全体
  const enemy = deploy(s2, 1, 'K06', 'plainL', 'front');   // 2/4 祝福2
  const src2 = deploy(s2, 0, 'W04', 'plainR', 'front');
  M.dealDamage(s2, src2, { kind: 'unit', unit: enemy }, 5);
  assert.ok(enemy.removed, '被光环封印时祝福也应当失效');
  // 对照：没被封印时祝福照常封顶
  const s3 = game();
  const okOne = deploy(s3, 1, 'K06', 'plainL', 'front');
  M.dealDamage(s3, deploy(s3, 0, 'W04', 'plainR', 'front'), { kind: 'unit', unit: okOne }, 5);
  assert.equal(okOne.hp, 4 - 2, '没封印时祝福仍然把 5 封成 2');
});
//   不反向依赖的模块（例如 board.js 或新增一个纯函数模块），再让两边都引用它。

test('国王附着被动：战略纵深让友方单位被消灭时抽一张（D27 / U09）', () => {
  const s = game();
  cast(s, 0, 'U09'); // 使友方国王获：友方单位被消灭时抽一张牌
  const before = s.players[0].hand.length;
  const u = deploy(s, 0, 'W03', 'mountain', 'front');
  M.destroyUnit(s, u, 'test');
  G.flushTriggers(s);
  assert.equal(s.players[0].hand.length, before + 1, '友方单位被消灭应当抽 1 张');
});

// 
group('9 第三批机制甲（封印动作 / 变形 / 抉择 / 在手牌被动 / 动态数值 / perOwnEntry）');
// 

test('封印动作：禁军打出时封印一个敌方单位，连它的遗言也一起封掉（U284 / D62）', () => {
  const s = game();
  const ghost = deploy(s, 1, 'E02', 'plainL', 'front'); // 场上唯一的敌方单位（2/2，遗言打国王 2 点）
  playUnit(s, 0, 'U284', 'mountain', 'front');          // 禁军 4/2，autoResolveChoices 会自动选中它
  assert.ok(M.isSealed(ghost), '应当被封印');
  M.destroyUnit(s, ghost, 'test');
  G.flushTriggers(s);
  assert.equal(king(s, 0), 20, '被封印的遗言不该发动');
});

test('变形：魔术师把敌人变成兔子，卡 id / 词条全换（U208 / D64）', () => {
  const s = game();
  const victim = deploy(s, 1, 'K06', 'plainL', 'front'); // 圣光庇护者 2/4 祝福2
  playUnit(s, 0, 'U208', 'mountain', 'front');           // 魔术师
  assert.equal(victim.cardId, 'U329', '应当被换成兔子那张卡');
  assert.equal(victim.keywords.length, 0, '词条（祝福）应当被清空');
});

test('抉择：打出歼-10 时自动选第一支（少花 4 费 + 穿透1）（U393）', () => {
  const s = game();
  forcePhase(s, 0, 'deploy');
  const p = s.players[0];
  p.mana = 8; // 刚好够 8 费，便于观察「返还 4 费」
  const hc = give(s, 0, 'U393');
  G.playCard(s, 0, hc.iid, { lane: 'mountain', row: 'front' });
  const u = s.board.mountain.units[0].front;
  assert.equal(s.players[0].mana, 4, '选 A：花 8 再返还 4');
  assert.ok(u.keywords.some((k) => k.id === 'pierce'), '选 A 还要给穿透1');
});

test('在手牌被动：黑龙每被打出一张牌就长大，超过 6 攻之后改为降费（U390）', () => {
  const s = game();
  const dragon = give(s, 0, 'U390'); // 13 费 3/3
  assert.equal(G.costOf(s, dragon), 13, '初始 13 费');
  // 打出 6 张（用组合卡解锁后排，凑够落点）
  playUnit(s, 0, 'K14', 'mountain', 'front');
  playUnit(s, 0, 'W01', 'mountain', 'back');
  playUnit(s, 0, 'K14', 'plainL', 'front');
  playUnit(s, 0, 'W01', 'plainL', 'back');
  playUnit(s, 0, 'K14', 'plainR', 'front');
  playUnit(s, 0, 'W01', 'plainR', 'back');
  assert.ok(G.costOf(s, dragon) < 13, '超过 6 攻之后应当开始降费，现在是 ' + G.costOf(s, dragon));
});

test('动态数值：力量光波打「己方场上单位数 x 2」（U203）', () => {
  const s = game();
  deploy(s, 0, 'W03', 'mountain', 'front');
  deploy(s, 0, 'W03', 'plainL', 'front');                 // 己方场上 2 个单位
  const victim = deploy(s, 1, 'W04', 'plainR', 'front');  // 5/6
  cast(s, 0, 'U203', { targetUid: victim.uid });
  assert.equal(victim.hp, 6 - 4, '2 个队友 x 2 = 4 点');
});

test('perOwnEntry：扫地僧的加成按「本局进入战场的次数」算（U392）', () => {
  const s = game();
  const monk = playUnit(s, 0, 'U392', 'mountain', 'front'); // 1/4，第一次进场应当 +1/+1
  assert.equal(monk.atk, 2, '攻击力 1 + 1');
  assert.equal(monk.hp, 5, '生命 4 + 1');
});

// 
group('10 第三批机制乙（伤害封顶 / 锦囊溅射 / 条件分支）');
// 

test('伤害封顶：是「单次伤害」封顶，不是本回合累计（Q1b / U371）', () => {
  const s = game();
  cast(s, 0, 'U371'); // 本回合敌方造成的伤害至多为 2
  const mine = deploy(s, 0, 'W04', 'mountain', 'front');  // 5/6
  const foe = deploy(s, 1, 'W04', 'plainL', 'front');     // 5/6
  assert.equal(M.dealDamage(s, foe, { kind: 'unit', unit: mine }, 5), 2, '第一次 5 点被封到 2');
  assert.equal(M.dealDamage(s, foe, { kind: 'unit', unit: mine }, 3), 2,
    '同一回合第二次也各自封到 2（若是累计封顶，第二次就该是 0）');
  assert.equal(M.dealDamage(s, mine, { kind: 'unit', unit: foe }, 3), 3, '自己这边的伤害不受影响');
});

test('锦囊溅射：带「溅射」的锦囊也算一次攻击，对相邻线路各 X 点（U375）', () => {
  const s = game();
  const victim = deploy(s, 1, 'W04', 'plainL', 'front');  // 主目标 5/6
  const left = deploy(s, 1, 'W04', 'mountain', 'front');
  const right = deploy(s, 1, 'W04', 'plainR', 'front');
  cast(s, 0, 'U375', { targetUid: victim.uid });          // 橄榄球：2 点伤害 + 溅射1
  assert.equal(victim.hp, 6 - 2, '主目标 2 点');
  assert.equal(left.hp, 5, '左邻溅射 1 点');
  assert.equal(right.hp, 5, '右邻溅射 1 点');
});

test('条件分支：敌方单位数 <= 我方时获双重打击（U373 正支）', () => {
  const s = game();
  const tank = playUnit(s, 0, 'U373', 'mountain', 'front'); // 打出时我方 1 个、敌方 0 个
  assert.ok(tank.keywords.some((k) => k.id === 'doubleStrike'), '应当获得双重打击');
});

test('条件分支：敌方更多时走 else（U373 反支）', () => {
  const s = game();
  deploy(s, 1, 'W03', 'plainL', 'front');
  deploy(s, 1, 'W03', 'plainR', 'front');                   // 敌方场上 2 个，我方只有即将打出的这 1 个
  const tank = playUnit(s, 0, 'U373', 'mountain', 'front');
  assert.ok(!tank.keywords.some((k) => k.id === 'doubleStrike'), '敌多我少不该给双重打击');
});

// 
group('11 无法选中与其余口径（作者 2026-10 / 蜜蜂 / 伪装土堆 / 强化士兵）');
// 

test('无法选中：除它自己的效果外，任何效果都不能影响它（作者 2026-10）', () => {
  const s = game();
  const u = deploy(s, 0, 'W03', 'mountain', 'front');
  const foeUnit = deploy(s, 1, 'W03', 'plainL', 'front');
  cast(s, 0, 'U374', { targetUid: u.uid }); // 神威：令一名队友无法选中一回合
  const f = { spellTargetable: true };
  assert.equal(matchesTargetFilter(u, f, filterCtx(s, foeUnit)), false, '敌方来源选不中它');
  assert.equal(matchesTargetFilter(u, f, filterCtx(s, u)), true,
    '它自己的效果放行（口径写的是「除自身效果以外」）');
  assert.equal(matchesTargetFilter(u, f, filterCtx(s)), false, '拿不到来源时保守拒绝');
});

test('无法选中：敌方的范围伤害也打不到它', () => {
  const s = game();
  s.cardLib.T80 = {
    id: 'T80', name: '测试虫群', type: 'spell', spellKind: 'attack', cost: 4,
    actions: [{ op: 'damage', amount: 3, target: { kind: 'allEnemyUnits' } }],
  };
  const shielded = deploy(s, 1, 'W03', 'plainL', 'front');
  const other = deploy(s, 1, 'W03', 'mountain', 'front');
  cast(s, 1, 'U374', { targetUid: shielded.uid });
  cast(s, 0, 'T80');
  assert.equal(at(s, 'plainL', 1, 'front').hp, 4, '被保护的应当毫发无伤');
  assert.equal(at(s, 'mountain', 1, 'front').hp, 1, '同批里没被保护的照常掉 3 点');
});

test('无法选中：不经过选择的伤害也拦得住，但自伤放行', () => {
  const s = game();
  const shielded = deploy(s, 1, 'W03', 'plainL', 'front');
  const foeUnit = deploy(s, 0, 'W04', 'mountain', 'front');
  cast(s, 1, 'U374', { targetUid: shielded.uid });
  assert.equal(M.dealDamage(s, foeUnit, { kind: 'unit', unit: shielded }, 3), 0, '敌方来源的伤害不生效');
  assert.equal(M.dealDamage(s, null, { kind: 'unit', unit: shielded }, 3), 0, '来源不明也拦');
  assert.equal(M.dealDamage(s, shielded, { kind: 'unit', unit: shielded }, 1), 1, '自伤放行');
});

test('无法选中：开战时这条线上敌方单位的攻击略过它', () => {
  const s = game();
  const shielded = deploy(s, 0, 'W03', 'mountain', 'front');
  deploy(s, 1, 'W04', 'mountain', 'front'); // 5/6 的对手
  cast(s, 0, 'U374', { targetUid: shielded.uid });
  combat(s);
  assert.equal(shielded.hp, 4, '攻击应当略过它');
  assert.equal(king(s, 0), 20 - 5, '略过它之后这条线没有别的目标，按规则改打国王');
});

test('略过这张牌：蜜蜂不挡枪，攻击穿过去打它后面的单位（U380）', () => {
  const s = game();
  const bee = deploy(s, 1, 'U380', 'mountain', 'front');   // 2/2，bypassInCombat
  const back = deploy(s, 1, 'W04', 'mountain', 'back');    // 5/6，躲在蜜蜂后面
  deploy(s, 0, 'W04', 'mountain', 'front');                // 5/6 的对手
  combat(s);
  // 蜜蜂自己不挨那 5 点（攻击略过它）；它掉的那 1 点是它自己的卡面效果
  //「造成伤害:受到1点伤害」（U380 的 onDealDamage 自伤）。
  assert.equal(bee.hp, 2 - 1, '蜜蜂不掉对手的伤害，只吃自己那 1 点自伤');
  assert.equal(back.hp, 6 - 5, '攻击穿过蜜蜂，打到了后排的 5/6');
});

test('伪装土堆：替同线路后排的友军承受伤害（U27）', () => {
  const s = game();
  const pile = deploy(s, 0, 'U27', 'mountain', 'front'); // 0/7 bodyguard
  const back = deploy(s, 0, 'W04', 'mountain', 'back');  // 5/6 被保护
  const src = deploy(s, 1, 'W03', 'plainL', 'front');
  M.dealDamage(s, src, { kind: 'unit', unit: back }, 3);
  assert.equal(back.hp, 6, '后排应当毫发无伤');
  assert.equal(pile.hp, 7 - 3, '伤害改由前排的伪装土堆承受');
});

test('拟定目标攻击：自动结算时按策略挑目标，不会留下挂起请求（U396）', () => {
  const s = game();
  s.humanSide = -1;                                          // 没有真人 -> 请求全部自动答
  deploy(s, 0, 'U396', 'mountain', 'front');                 // 强化士兵 2/3，choosesTarget
  const killable = deploy(s, 1, 'W02', 'mountain', 'front');  // 白板卫士 2/1：能被一击打死
  combat(s);
  assert.ok(!s.pending, '不该留下挂起的交互请求');
  // 引擎自带的挑目标策略：能一击杀死就打，否则打国王
  assert.ok(killable.removed, '策略应当挑「能一击杀死」的那个目标');
});

// 
group('12 第三批单卡抽查（真卡真效果）');
// 

test('人间大炮：有队友被打出时对敌方国王造成 1 点（U384 / onAllyPlayed）', () => {
  const s = game();
  deploy(s, 0, 'U384', 'mountain', 'front'); // 人间大炮先在场
  playUnit(s, 0, 'W01', 'plainL', 'front');  // 再打出队友 -> 触发
  assert.equal(king(s, 1), 20 - 1, '每打出一个队友就打国王 1 点');
});

test('双嵴龙：只有「在水池线上打出」才 +1/+1（U386 / effect.when 落点条件）', () => {
  const inWater = playUnit(game(), 0, 'U386', 'water', 'front');
  assert.equal(inWater.atk, 3, '水里打出：2+1 攻');
  assert.equal(inWater.hp, 3, '水里打出：2+1 血');
  const onLand = playUnit(game(), 0, 'U386', 'mountain', 'front');
  assert.equal(onLand.atk, 2, '陆地打出：不触发');
  assert.equal(onLand.hp, 2, '陆地打出：不触发');
});

test('雷龙：打出时把平地上的所有敌人弹回手牌，山地的不动（U381 / D11）', () => {
  const s = game();
  deploy(s, 1, 'W03', 'plainL', 'front');
  deploy(s, 1, 'W03', 'plainR', 'front');
  deploy(s, 1, 'W03', 'mountain', 'front');
  const handBefore = s.players[1].hand.length;
  playUnit(s, 0, 'U381', 'mountain', 'front'); // 雷龙 7 费 5/7
  assert.equal(at(s, 'plainL', 1, 'front'), null, '平地(左)的敌人被弹走');
  assert.equal(at(s, 'plainR', 1, 'front'), null, '平地(右)的敌人被弹走');
  assert.ok(at(s, 'mountain', 1, 'front'), '山地的敌人不受影响');
  assert.equal(s.players[1].hand.length, handBefore + 2, '弹射 = 返回拥有者手牌（不是消灭）');
});

test('感染：一名队友 +3/+3 并清空它本身的异能（U209）', () => {
  const s = game();
  const mate = deploy(s, 0, 'E02', 'mountain', 'front'); // 复仇亡魂 2/2（遗言打国王 2 点）
  cast(s, 0, 'U209', { targetUid: mate.uid });
  assert.equal(mate.atk, 2 + 3, '攻击力 +3');
  assert.equal(mate.hp, 2 + 3, '生命 +3');
  M.destroyUnit(s, mate, 'test');
  G.flushTriggers(s);
  assert.equal(king(s, 1), 20, '它本身的异能应当被清空（遗言不再发动）');
});

// 
group('13 确定性与锁步（回放与联机的地基）');
// 

/** 局面指纹：把「会分叉的东西」都压成一行，便于逐条比较 */
function summary(state) {
  const one = (u) => (u ? u.cardId + u.atk + '/' + u.hp : '-');
  const board = LANES.map((l) => {
    const t = state.board[l].units;
    return l + '[' + one(t[0].front) + ',' + one(t[0].back) + '|' + one(t[1].front) + ',' + one(t[1].back) + ']';
  }).join('');
  const hand = (p) => p.hand.map((c) => c.cardId + '#' + c.iid).join(',');
  return [
    't' + state.turn, state.phase, 'w' + state.winner,
    'k' + state.players[0].kingHp + '/' + state.players[1].kingHp,
    'm' + state.players[0].mana + '/' + state.players[1].mana,
    'h0=' + hand(state.players[0]), 'h1=' + hand(state.players[1]),
    'rng' + state.rng.state, 'b=' + board,
  ].join('|');
}

/** 走一步「最笨的自动操作」：能出第一张合法的牌就出，否则推进阶段。
 *  返回一个描述串（出错也照样返回，好让两边能**比较**是不是一致）。 */
function autoStep(state) {
  try {
    const actor = G.getActor(state);
    if (actor !== null) {
      const plays = G.getLegalPlays(state, actor);
      if (plays.length) {
        const p = plays[0];
        const place = p.places && p.places[0];
        G.playCard(state, actor, p.iid, place ? { lane: place.lane, row: place.row } : {});
        return 'play:' + p.iid;
      }
    }
    if (state.pending) return 'pending';
    G.advance(state);
    return 'advance';
  } catch (e) {
    return 'err:' + e.message;
  }
}

test('锁步：两个引擎喂同一串操作，每一步的状态都完全一致（联机只同步操作的地基）', () => {
  const a = game({ seed: 4242 });
  const b = game({ seed: 4242 });
  assert.equal(summary(a), summary(b), '同种子的开局状态应当一致');
  for (let i = 0; i < 24; i++) {
    const ra = autoStep(a);
    const rb = autoStep(b);
    assert.equal(ra, rb, '第 ' + (i + 1) + ' 步两边的「做了什么」应当一致');
    assert.equal(summary(a), summary(b), '第 ' + (i + 1) + ' 步两边的状态应当一致');
  }
});

test('重演：把录下来的操作流喂给同种子的新引擎，结果完全一致', () => {
  const src = game({ seed: 777 });
  const ops = [];
  for (let i = 0; i < 20; i++) {
    const actor = G.getActor(src);
    if (actor !== null) {
      const plays = G.getLegalPlays(src, actor);
      if (plays.length) {
        const p = plays[0];
        const place = p.places && p.places[0];
        const opts = place ? { lane: place.lane, row: place.row } : {};
        ops.push({ k: 'p', s: actor, i: p.iid, o: opts });
        G.playCard(src, actor, p.iid, opts);
        continue;
      }
    }
    if (src.pending) break;
    ops.push({ k: 'a' });
    G.advance(src);
  }
  // 换个新引擎，只喂这串操作（不跑 AI、不重新决策）
  const replay = game({ seed: 777 });
  for (const op of ops) {
    if (op.k === 'a') G.advance(replay);
    else G.playCard(replay, op.s, op.i, op.o);
  }
  assert.equal(summary(replay), summary(src), '同一串操作应当走出同一个局面');
  assert.ok(ops.length > 5, '这串操作不该是空的（实际 ' + ops.length + ' 条）');
});

test('引擎源码里不出现 Math.random（随机数必须全部来自 state.rng，否则回放/锁步会散）', () => {
  const dir = path.resolve(url.fileURLToPath(new URL('../src', import.meta.url)));
  const bad = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    // 只认「调用形式」，避免把注释里那句「为什么不用 Math.random」也算进来
    if (/Math[.]random\s*\(/.test(fs.readFileSync(path.join(dir, f), 'utf8'))) bad.push(f);
  }
  assert.deepEqual(bad, [], '这些文件里出现了 Math.random：' + bad.join(', '));
});

// 
group('14 陷阱（作者 2026-10 口径）');
// 

test('陷阱是「埋伏」不是「打出」：进陷阱格、不结算卡面效果（U371）', () => {
  const s = game();
  cast(s, 0, 'U371'); // 反应装甲：本回合敌方伤害至多 2
  assert.equal(trapsOf(s, 0).length, 1, '应当埋进陷阱格');
  assert.equal(trapsOf(s, 0)[0].trap.revealed, false, '还没触发 -> 敌方看不见');
  const mine = deploy(s, 0, 'W04', 'mountain', 'front');
  const foe = deploy(s, 1, 'W04', 'plainL', 'front');
  // 没踩到之前，陷阱不该有任何效果
  assert.equal(M.dealDamage(s, foe, { kind: 'unit', unit: mine }, 1), 1, '这一下按真值走');
});

test('陷阱的使用不算「打出卡牌」（人间大炮不该响）（作者口径）', () => {
  const s = game();
  deploy(s, 0, 'U384', 'mountain', 'front'); // 人间大炮：有队友被打出时打国王 1 点
  cast(s, 0, 'U371');                        // 打出一个陷阱
  assert.equal(king(s, 1), 20, '陷阱不算打出卡牌，不该触发「有队友被打出时」');
});

test('陷阱格每方两个，填满之后不能再用（作者口径）', () => {
  const s = game();
  cast(s, 0, 'U371');
  cast(s, 0, 'U371');
  assert.equal(trapsOf(s, 0).length, 2, '应当埋满两个');
  assert.throws(() => cast(s, 0, 'U371'), '第三个应当被拒（陷阱格已满）');
});

test('未触发的陷阱只在「下一回合的同一类阶段」回手（作者口径）', () => {
  const s = game();
  forcePhase(s, 0, 'deploy');          // 单位回合
  const hc = give(s, 0, 'U371');
  G.playCard(s, 0, hc.iid, {});        // 陷阱不需要落点
  assert.equal(trapsOf(s, 0).length, 1, '单位回合也能埋陷阱（阶段类型不受限）');
  // 本回合的锦囊阶段：类型不同，不该回手
  let g = 0;
  while (!(s.phase === 'SPELL_FIRST' || s.phase === 'SPELL_SECOND') && g++ < 10) G.advance(s);
  assert.equal(trapsOf(s, 0).length, 1, '锦囊阶段不该收走单位回合埋的陷阱');
  // 下一回合的单位阶段：这时才回手
  nextTurn(s);
  g = 0;
  while (!(s.phase === 'DEPLOY_FIRST' || s.phase === 'DEPLOY_SECOND') && g++ < 10) G.advance(s);
  assert.equal(trapsOf(s, 0).length, 0, '下一回合的单位阶段一到就回手');
  assert.ok(s.players[0].hand.some((c) => c.cardId === 'U371'), '回的是它主人的手牌');
});

test('陷阱触发：揭示 + 本回合每次敌方伤害封顶 2 + 回合末消失（U371 / Q1b）', () => {
  const s = game();
  cast(s, 0, 'U371');
  const mine = deploy(s, 0, 'W04', 'mountain', 'front');
  const foe = deploy(s, 1, 'W04', 'plainL', 'front');
  assert.equal(M.dealDamage(s, foe, { kind: 'unit', unit: mine }, 5), 2, '踩中：封顶到 2');
  assert.equal(trapsOf(s, 0)[0].trap.revealed, true, '触发后应当揭示给双方');
  assert.equal(trapsOf(s, 0).length, 1, '本回合内它还留在陷阱格里（效果结束才消失）');
  assert.equal(M.dealDamage(s, foe, { kind: 'unit', unit: mine }, 3), 2,
    '同一回合第二次也各自封到 2（单次封顶，不是累计）');
  nextTurn(s);
  assert.equal(trapsOf(s, 0).length, 0, '回合结束、效果结束，陷阱消失');
});

test('陷阱费用：真花钱，但敌方视角里看不见这笔变化（作者口径）', () => {
  const s = game();
  forcePhase(s, 0, 'spell');
  s.players[0].mana = 10;
  const hc = give(s, 0, 'U371');
  G.playCard(s, 0, hc.iid, {});
  assert.equal(s.players[0].mana, 8, '引擎里 2 费是真扣的');
  assert.equal(visibleMana(s, 0), 10, '但敌方视角里看不出少了 2 费');
  // 触发（揭示）之后，这笔花费就不再藏着了
  const mine = deploy(s, 0, 'W04', 'mountain', 'front');
  const foe = deploy(s, 1, 'W04', 'plainL', 'front');
  M.dealDamage(s, foe, { kind: 'unit', unit: mine }, 1);
  assert.equal(visibleMana(s, 0), 8, '揭示之后费用变化就看得见了');
});

//  汇总 
console.log('\n' + BAR);
if (failures.length === 0) {
  console.log(OK_ALL + ' 全部通过：' + passed + ' 个测试');
  process.exit(0);
} else {
  console.log(BAD + ' ' + failures.length + ' 个失败 / 共 ' + (passed + failures.length) + ' 个');
  for (const f of failures) {
    console.log('    [' + f.group + '] ' + f.name);
    console.log('     ' + f.message);
  }
  process.exit(1);
}
