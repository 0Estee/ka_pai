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
import { pickFragileTarget } from '../src/targets.js';
import { filterCtx, effectiveAtk, hasRooted, syncStatAuras } from '../src/auras.js';
import { trapsOf, visibleMana } from '../src/board.js';
import { dealDamage } from '../src/damage.js';
import { LANES, ROWS } from '../src/constants.js';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { TEST_CARD_LIB, buildTestDeck, DECKABLE_CARDS, TOKEN_CARDS } from '../cards/test-cards.js';

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
    factions: cfg.factions || [],
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

/** 应答「召唤落点」挂起（作者 2026-10-04：召唤时直接在场上的格子里选一个） */
function answerSummonCell(state, lane, row) {
  const rq = state.pending && state.pending.request;
  assert.ok(rq && rq.type === 'summonCell', '应当挂起问召唤落点');
  const idx = (rq.options || []).findIndex((o) => o.lane === lane && o.row === row);
  assert.ok(idx >= 0, '这个格子必须是合法落点');
  G.resolveChoice(state, { lane, row });
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


//
group('15 国王中毒与「选择一个单位」跨阵营（作者 2026-10 追加）');
//

test('淬毒打国王：标记记在玩家身上，下一次回合开始时结算一次（作者 2026-10）', () => {
  const s = game();
  const attacker = deploy(s, 0, 'K17', 'mountain', 'front');   // 毒刃刺客 poison:2
  const before = king(s, 1);
  M.dealDamage(s, attacker, { kind: 'king', side: 1 }, 3);
  assert.equal(king(s, 1), before - 3, '对国王的伤害照常结算');
  assert.equal(s.players[1].kingMarks.length, 1, '淬毒给国王挂了一个标记（国王没有 marks，标记记在玩家上）');
  const applied = s.log.filter((e) => e.type === 'poison-applied').pop();
  assert.equal(applied.kingSide, 1, '日志用 kingSide 说明是哪一方国王');
  // 跳过开战：否则这条线路的单位还会再打国王一次、再挂一个标记，掉血量就不是定值了
  G.enterPhase(s, 'TURN_END');
  nextTurn(s);
  assert.equal(king(s, 1), before - 3 - 2, '下回合开始时国王吃 2 点中毒伤害');
  assert.equal(s.players[1].kingMarks.length, 0, '结算过的标记被消费掉');
});

test('疾病不挂国王（它要消灭单位，而国王不是单位）', () => {
  const s = game();
  const attacker = deploy(s, 0, 'K03', 'mountain', 'front');   // 瘟疫使者 disease
  M.dealDamage(s, attacker, { kind: 'king', side: 1 }, 3);
  assert.equal(s.players[1].kingMarks.length, 0, '国王不会挂疾病标记');
  const after = king(s, 1);
  G.enterPhase(s, 'TURN_END');
  nextTurn(s);
  assert.equal(king(s, 1), after, '疾病不会让国王掉血');
});

test('第3补给营「选择一个单位」：友方和敌方都在选项里（作者 2026-10）', () => {
  const s = game();
  s.autoResolveChoices = false;   // 手动答这一问
  const ally = deploy(s, 0, 'U289', 'plainL', 'front');
  const foe = deploy(s, 1, 'W04', 'plainL', 'front');
  forcePhase(s, 0, 'deploy');
  const hc = give(s, 0, 'U289');
  G.playCard(s, 0, hc.iid, { lane: 'mountain', row: 'front' });
  assert.ok(s.pending && s.pending.request, '打出 U289 会挂起「选择一个单位」');
  const options = s.pending.request.options.map((o) => o.uid);
  assert.ok(options.includes(ally.uid), '友方单位在选项里（这正是作者要的）');
  assert.ok(options.includes(foe.uid), '敌方单位也还在');
  const hand = s.players[0].hand.length;
  G.resolveChoice(s, { uid: ally.uid });
  assert.equal(s.pending, null, '答完就不再挂起');
  assert.equal(s.players[0].hand.length, hand + 2, '按目标的词条数抽牌（U289 有 combo / armor:1 两个词条）');
});

//
group('16 狙击手「开战时:造成2点伤害（选择一个目标）」（作者 2026-10 改口径）');
//

test('狙击手：真人那一侧开战时真的问人，只打被选中的那一个（新口径不再限本线路）', () => {
  const s = game();
  s.humanSide = 0;                 // 0 号是真人：它的触发式点选必须真的问它
  const sniper = deploy(s, 0, 'U287', 'mountain', 'front');
  const sameLane = deploy(s, 1, 'W04', 'mountain', 'front');
  const otherLane = deploy(s, 1, 'W04', 'water', 'front');
  M.queueTrigger(s, sniper, 'onCombatStart', { lane: 'mountain' });
  G.flushTriggers(s);
  assert.ok(s.pending && s.pending.request, '开战时应当挂起「选择一个目标」');
  assert.equal(s.pending.request.type, 'chooseEnemyTarget');
  assert.equal(s.pending.request.noAuto, true, '真人这一侧不许被自动代答（askHuman）');
  const opts = s.pending.request.options;
  const uids = opts.filter((o) => o.uid != null).map((o) => o.uid);
  assert.ok(uids.includes(sameLane.uid) && uids.includes(otherLane.uid), '不限本线路：别条线路上的敌人也在选项里');
  assert.ok(opts.some((o) => o.king), '敌方国王也在选项里（与「火箭弹」同口径）');
  G.resolveChoice(s, { uid: otherLane.uid });
  assert.equal(s.pending, null, '答完就不再挂起');
  assert.equal(otherLane.maxHp - otherLane.hp, 2, '被选中的目标吃 2 点伤害');
  assert.equal(sameLane.hp, sameLane.maxHp, '同线路的敌人没有自动挨打（旧口径是打本线路全体）');
});

test('狙击手：没有真人（humanSide = -1）时自动算一个，一共只打 2 点', () => {
  const s = game();
  s.humanSide = -1;                // 平衡自检 / 门禁脚本的口径：没有真人
  const sniper = deploy(s, 0, 'U287', 'mountain', 'front');
  const a = deploy(s, 1, 'W04', 'mountain', 'front');
  const b = deploy(s, 1, 'W04', 'water', 'front');
  M.queueTrigger(s, sniper, 'onCombatStart', { lane: 'mountain' });
  G.flushTriggers(s);
  assert.equal(s.pending, null, 'AI 侧不挂起等人');
  assert.equal((a.maxHp - a.hp) + (b.maxHp - b.hp), 2, '只落在一个目标上，总共 2 点');
});

test('狙击手：不在真人那一边时同样不挂起（判据是 humanSide，不是全局开关）', () => {
  const s = game();
  s.humanSide = 0;                 // 真人在 0 号，狙击手却是 1 号（敌人的）
  const sniper = deploy(s, 1, 'U287', 'mountain', 'front');
  const mine = deploy(s, 0, 'W04', 'water', 'front');
  M.queueTrigger(s, sniper, 'onCombatStart', { lane: 'mountain' });
  G.flushTriggers(s);
  assert.equal(s.pending, null, '敌人的狙击手不会把回合卡住等人');
  assert.equal(mine.maxHp - mine.hp, 2, '它照样打出了 2 点（选项里只有这一个单位）');
});

//
group('15 阵营与超能力');
//

//  阵营与超能力（作者 2026-10-03 规则补充：对局前选阵营，血量 15/9/3 各抽一张）
const DEMON_SUPERPOWERS = ['U398', 'U399', 'U400', 'U401'];

/** 场上某方有没有这张牌（活着的） */
function hasUnit(state, side, cardId) {
  for (const lane of LANES) {
    for (const row of ROWS) {
      const u = state.board[lane].units[side][row];
      if (u && !u.removed && u.cardId === cardId) return true;
    }
  }
  return false;
}

test('对局开始时双方各抽一张本阵营的超能力（非令牌）', () => {
  const s = game({ factions: ['demon', 'demon'] });
  for (const side of [0, 1]) {
    const p = s.players[side];
    assert.equal(p.superpowers.length, 1, '开局应当抽到 1 张');
    const id = p.superpowers[0];
    assert.ok(DEMON_SUPERPOWERS.indexOf(id) >= 0, '抽到的是恶魔阵营的非令牌超能力：' + id);
    assert.ok(p.hand.some((c) => c.cardId === id), '抽到的牌进了手牌');
    assert.equal(s.cardLib[id].faction, 'demon');
    assert.ok(!s.cardLib[id].token, '令牌不进抽取池');
  }
  assert.ok(s.log.some((e) => e.type === 'superpower-draw'), '抽超能力要写日志（界面与回放靠它）');
});

test('国王血量掉过 15 / 9 / 3 各抽一张，抽过的不重复，一共 4 张', () => {
  const s = game({ factions: ['demon', null] });
  const p = s.players[0];
  assert.equal(p.superpowers.length, 1, '开局 1 张');
  const hit = (n) => M.dealDamage(s, null, { kind: 'king', side: 0 }, n);
  hit(6);
  assert.equal(p.superpowers.length, 2, '20 -> 14，掉过 15');
  hit(6);
  assert.equal(p.superpowers.length, 3, '14 -> 8，掉过 9');
  hit(6);
  assert.equal(p.superpowers.length, 4, '8 -> 2，掉过 3');
  hit(1);
  assert.equal(p.superpowers.length, 4, '同一个阈值只生效一次');
  assert.equal(new Set(p.superpowers).size, 4, '不会重复抽到同一张');
  assert.deepEqual(p.superpowers.slice().sort(), DEMON_SUPERPOWERS, '池子正好是这 4 张');
  assert.equal(s.players[1].superpowers.length, 0, '没有阵营就没有超能力');
});

test('超能力不进普通牌库；风神翼龙（无阵营）进牌库', () => {
  assert.ok(!DECKABLE_CARDS.some((c) => c.faction), '带阵营的卡一张都不许进牌库');
  assert.ok(DECKABLE_CARDS.some((c) => c.id === 'U397'), '风神翼龙在牌库里');
  assert.ok(!DECKABLE_CARDS.some((c) => c.id === 'U402'), '恶魔虚影是令牌，不进牌库');
  assert.ok(TOKEN_CARDS.some((c) => c.id === 'U402'), '恶魔虚影确实是个令牌');
  for (const seed of [1, 2, 3, 12345]) {
    const deck = buildTestDeck(80, seed);
    assert.ok(deck.length > 0, '牌库不该是空的');
    assert.ok(!deck.some((id) => (TEST_CARD_LIB[id] || {}).faction), '实际发出的牌库里也不许出现超能力（seed ' + seed + '）');
  }
});

test('下界之风（U398）：敌方所有单位各 2 点，敌方国王也掉 2 点', () => {
  const s = game();
  const a = deploy(s, 1, 'W04', 'mountain', 'front');
  const b = deploy(s, 1, 'W04', 'water', 'front');
  const mine = deploy(s, 0, 'W04', 'mountain', 'back');
  cast(s, 0, 'U398');
  assert.equal(a.maxHp - a.hp, 2);
  assert.equal(b.maxHp - b.hp, 2);
  assert.equal(king(s, 1), 18, '这张牌连敌方国王一起打（作者口径）');
  assert.equal(mine.hp, mine.maxHp, '自己人不挨打');
});

test('鲜血祭典（U399）：回复量 = 被献祭单位的当前攻击力，不超过国王上限', () => {
  const s = game();
  s.players[0].kingHp = 12;
  deploy(s, 0, 'W04', 'mountain', 'front');            // 5 攻
  cast(s, 0, 'U399');
  assert.ok(!at(s, 'mountain', 0, 'front'), '被献祭的单位离场');
  assert.equal(king(s, 0), 17, '按被献祭单位的当前攻击力回复（12 + 5）');

  const s2 = game();
  s2.players[0].kingHp = 19;
  deploy(s2, 0, 'W04', 'mountain', 'front');
  cast(s2, 0, 'U399');
  assert.equal(king(s2, 0), 20, '回复不超过国王血量上限');
});

test('死神（U401）选项 0：不发动献祭，直接打出', () => {
  const s = game();
  const u = playUnit(s, 0, 'U401', 'mountain', 'front');
  assert.equal(u.atk, 2);
  assert.equal(u.maxHp, 2);
  assert.equal(king(s, 0), 20, '不发动就不伤自己的国王');
});

test('死神（U401）选项 1：献祭队友换 +1/+1，自己国王 -3，再对敌方目标 5 点', () => {
  const s = game();
  const fodder = deploy(s, 0, 'W04', 'water', 'front');   // 被献祭的队友
  s.chooser = (req) => {
    if (req.type === 'chooseOption') return { index: 1 };
    const mine = (req.options || []).find((x) => x.uid === fodder.uid);
    if (mine) return { uid: mine.uid };
    const o = (req.options || []).find((x) => x.uid != null);
    if (o) return { uid: o.uid };
    return undefined;
  };
  const target = deploy(s, 1, 'W04', 'mountain', 'front');
  const u = playUnit(s, 0, 'U401', 'mountain', 'front');
  assert.ok(!at(s, 'water', 0, 'front'), '队友被献祭');
  assert.equal(u.atk, 3, '2 + 1');
  assert.equal(u.maxHp, 3, '2 + 1');
  assert.equal(king(s, 0), 17, '自己的国王吃 3 点');
  assert.equal(target.maxHp - target.hp, 5, '敌方目标吃 5 点');
});

test('恶魔虚影（U402）：在场时每献祭一名友方单位 +2 攻击力 +1 生命上限', () => {
  const s = game();
  const demon = deploy(s, 0, 'U402', 'mountain', 'front');
  const fodder = deploy(s, 0, 'W04', 'water', 'front');
  const foe = deploy(s, 1, 'W04', 'mountain', 'back');
  assert.equal(demon.atk, 1);
  assert.equal(demon.maxHp, 4);
  const before = s.stats.unitsDestroyed;
  assert.equal(G.sacrificeUnit(s, 0, fodder.uid), true, '献祭自己场上的单位');
  assert.equal(demon.atk, 3, '+2 攻击力');
  assert.equal(demon.maxHp, 5, '+1 生命上限');
  assert.equal(s.stats.unitsDestroyed, before + 1, '献祭算作被消灭');
  assert.ok(s.log.some((e) => e.type === 'destroy' && e.reason === 'sacrifice'), '日志里写清是献祭');
  assert.equal(G.sacrificeUnit(s, 0, foe.uid), false, '不能献祭对手的单位');
  assert.equal(G.sacrificeUnit(s, 0, fodder.uid), false, '已经死了的单位不能再献祭');
});

test('召唤仪式（U400）选项 0：下个大回合开始时才召唤，落点在打出时就选好', () => {
  const s = game();
  cast(s, 0, 'U400');
  answerSummonCell(s, 'plainL', 'front');
  assert.equal(s.delayedSummons.length, 1, '排队等下个大回合');
  assert.equal(s.delayedSummons[0].cardId, 'U402');
  assert.equal(s.delayedSummons[0].lane, 'plainL', '落点在打出时就选好了');
  assert.ok(!hasUnit(s, 0, 'U402'), '现在还没上场');
  nextTurn(s);
  assert.equal(s.delayedSummons.length, 0, '已经结算过');
  assert.ok(hasUnit(s, 0, 'U402'), '大回合一开始就召唤出来了');
  const u = s.board.plainL.units[0].front;
  assert.ok(u && u.cardId === 'U402', '落在当时选好的格子上');
});

test('召唤仪式（U400）选项 1：国王扣 2 点生命，立刻召唤', () => {
  const s = game();
  s.chooser = (req) => (req.type === 'chooseOption' ? { index: 1 } : undefined);
  cast(s, 0, 'U400');
  answerSummonCell(s, 'mountain', 'front');
  assert.equal(king(s, 0), 18, '国王扣 2 点生命');
  assert.ok(hasUnit(s, 0, 'U402'), '立刻上场');
  assert.equal(s.delayedSummons.length, 0, '没有排队');
});

// 
group('16 上帝阵营与召唤落点（作者 2026-10-04，裁决 D73）');

test('上帝阵营：开局各抽 1 张超能力，4 张非令牌 + 1 张令牌，且不进牌库', () => {
  const s = game({ factions: ['god', 'god'] });
  assert.equal(s.players[0].faction, 'god', '阵营写进玩家状态');
  assert.equal(s.players[0].superpowers.length, 1, '开局抽 1 张');
  assert.equal(s.players[1].superpowers.length, 1, '对手也抽 1 张');
  const drawn = s.cardLib[s.players[0].superpowers[0]];
  assert.equal(drawn.faction, 'god', '抽到的是本阵营的');
  const all = Object.values(s.cardLib).filter((c) => c.faction === 'god');
  assert.equal(all.filter((c) => !c.token).length, 4, '4 张非令牌超能力');
  assert.equal(all.filter((c) => c.token).length, 1, '1 张令牌（上帝的信徒）');
  const deck = buildTestDeck(80, 7);
  assert.ok(!deck.some((id) => s.cardLib[id] && s.cardLib[id].faction), '超能力不进普通牌库');
});

test('传教（U403）：挂起问召唤落点，选中的格子才放人，且遵守地形', () => {
  const s = game({ factions: ['god', 'god'] });
  cast(s, 0, 'U403');
  const rq = s.pending && s.pending.request;
  assert.ok(rq && rq.type === 'summonCell', '应当挂起问落点');
  assert.equal(rq.side, 0, '问的是我方');
  assert.ok(rq.noAuto, '真人这一侧要挂起等点选');
  const cells = rq.options || [];
  assert.ok(cells.some((o) => o.lane === 'plainL' && o.row === 'front'), '含具体格子');
  assert.ok(!cells.some((o) => o.lane === 'water'), '信徒不会游泳，水路不在选项里');
  G.resolveChoice(s, { lane: 'plainL', row: 'front' });
  const u = s.board.plainL.units[0].front;
  assert.ok(u && u.cardId === 'U407', '信徒落在选好的格子上');
  assert.equal(u.atk, 2, '2 点攻击');
  assert.equal(u.hp, 4, '4 点生命');
});

test('上帝的信徒（U407）：回合开始全队 +2 生命上限，并给国王回 2 血', () => {
  const s = game({ factions: ['god', 'god'] });
  cast(s, 0, 'U403');
  G.resolveChoice(s, { lane: 'plainL', row: 'front' });
  const cult = s.board.plainL.units[0].front;
  forcePhase(s, 0, 'deploy');
  const buddy = playUnit(s, 0, 'U242', 'mountain', 'front');
  s.players[0].kingHp = 15;
  nextTurn(s);
  assert.equal(cult.maxHp, 6, '信徒自己也 +2');
  assert.equal(buddy.maxHp, 5, '队友拳击手 3 变 5');
  assert.equal(buddy.hp, 5, '加生命上限时那 2 点也一起加上');
  assert.equal(s.players[0].kingHp, 17, '国王回 2 血');
});

test('圣经（U404）：同一个队友只问一次，给无敌并 +2 生命，再抽一张', () => {
  const s = game({ factions: ['god', 'god'] });
  forcePhase(s, 0, 'deploy');
  const u = playUnit(s, 0, 'U242', 'mountain', 'front');
  forcePhase(s, 0, 'spell');
  let asked = 0;
  const kinds = [];
  s.chooser = (req) => { asked++; kinds.push(req.type); return req.type === 'chooseUnit' ? req.options[0] : undefined; };
  const handBefore = s.players[0].hand.length;
  cast(s, 0, 'U404');
  assert.equal(asked, 1, '同一个队友只问一次');
  assert.deepEqual(kinds, ['chooseUnit'], '问的就是选队友');
  assert.ok(u.keywords.some((k) => k.id === 'invincible'), '获得无敌');
  assert.equal(u.maxHp, 5, '+2 生命上限');
  assert.equal(s.players[0].hand.length, handBefore + 1, '抽一张牌');
});

test('庇佑（U405）：友方单位与国王本回合无敌，下一回合失效', () => {
  const s = game({ factions: ['god', 'god'] });
  forcePhase(s, 0, 'deploy');
  const u = playUnit(s, 0, 'U242', 'mountain', 'front');
  forcePhase(s, 0, 'spell');
  cast(s, 0, 'U405');
  assert.ok(u.keywords.some((k) => k.id === 'invincible'), '队友获得无敌');
  assert.equal(dealDamage(s, null, { kind: 'unit', unit: u }, 3), 0, '无敌期间不掉血');
  assert.equal(dealDamage(s, null, { kind: 'king', side: 0 }, 5), 0, '国王本回合免疫');
  assert.equal(dealDamage(s, null, { kind: 'king', side: 0 }, 5, { unpreventable: true }), 5, '无视机制的伤害照样生效');
  s.turn += 1;
  assert.equal(dealDamage(s, null, { kind: 'king', side: 0 }, 5), 5, '下一回合不再免疫');
});

test('祝福（U406）：目标获得祝福 1，并抽一张', () => {
  const s = game({ factions: ['god', 'god'] });
  forcePhase(s, 0, 'deploy');
  const u = playUnit(s, 0, 'U242', 'mountain', 'front');
  forcePhase(s, 0, 'spell');
  s.chooser = (req) => (req.type === 'chooseUnit' ? req.options[0] : undefined);
  const handBefore = s.players[0].hand.length;
  cast(s, 0, 'U406');
  assert.ok(u.keywords.some((k) => k.id === 'blessing' && k.x === 1), '祝福 1 生效');
  assert.equal(s.players[0].hand.length, handBefore + 1, '抽一张牌');
});
//
group('17 四大阵营：剑道 / 音乐 / 科学 / 神佑（作者 2026-10-04，裁决 D74）');
//

const NEW_FACTIONS = {
  sword: ['U408', 'U409', 'U411', 'U412'],
  music: ['U413', 'U414', 'U415', 'U416'],
  science: ['U417', 'U418', 'U419', 'U420'],
  divine: ['U422', 'U423', 'U424', 'U425'],
};

test('四大阵营：每阵营 4 张非令牌超能力，开局各抽 1 张，不进牌库', () => {
  for (const key of Object.keys(NEW_FACTIONS)) {
    const want = NEW_FACTIONS[key];
    const s = game({ factions: [key, key] });
    for (const side of [0, 1]) {
      const p = s.players[side];
      assert.equal(p.superpowers.length, 1, key + ' 开局抽 1 张');
      assert.ok(want.indexOf(p.superpowers[0]) >= 0, key + ' 抽到本阵营非令牌：' + p.superpowers[0]);
      assert.ok(p.hand.some((c) => c.cardId === p.superpowers[0]), '抽到的牌进手牌');
    }
    const all = Object.values(s.cardLib).filter((c) => c.faction === key);
    assert.equal(all.filter((c) => !c.token).length, 4, key + ' 4 张非令牌');
    assert.ok(!DECKABLE_CARDS.some((c) => c.faction), '带阵营的牌不进牌库');
  }
});

test('新阵营的国王血量掉过 15 / 9 / 3 各抽一张，合计 4 张不重复', () => {
  const s = game({ factions: ['science', null] });
  const p = s.players[0];
  const hit = (n) => dealDamage(s, null, { kind: 'king', side: 0 }, n);
  assert.equal(p.superpowers.length, 1, '开局 1 张');
  hit(6);
  assert.equal(p.superpowers.length, 2, '20 -> 14，掉过 15');
  hit(6);
  assert.equal(p.superpowers.length, 3, '14 -> 8，掉过 9');
  hit(6);
  assert.equal(p.superpowers.length, 4, '8 -> 2，掉过 3');
  hit(1);
  assert.equal(p.superpowers.length, 4, '同一个阈值只生效一次');
  assert.equal(new Set(p.superpowers).size, 4, '不会重复抽');
  assert.equal(s.players[1].superpowers.length, 0, '没有阵营就没有超能力');
});

test('没选阵营就不抽超能力', () => {
  const s = game({ factions: [null, null] });
  assert.equal(s.players[0].superpowers.length, 0);
  assert.equal(s.players[1].superpowers.length, 0);
});

test('U408 刀客：一名队友获得穿透 2 并 +1 攻击力', () => {
  const s = game();
  forcePhase(s, 0, 'deploy');
  const u = playUnit(s, 0, 'U242', 'mountain', 'front');
  forcePhase(s, 0, 'spell');
  const atkBefore = u.atk;
  s.chooser = (req) => (req.type === 'chooseUnit' ? { uid: u.uid } : undefined);
  cast(s, 0, 'U408');
  const pierce = u.keywords.find((k) => k.id === 'pierce');
  assert.ok(pierce && pierce.x === 2, '拿到穿透 2');
  assert.equal(u.atk, atkBefore + 1, '+1 攻击力');
});

test('U409 回刃：把连斩放进手牌，并给自己的国王回 1 点', () => {
  const s = game();
  s.players[0].kingHp = 15;
  const before = s.players[0].hand.length;
  cast(s, 0, 'U409');
  assert.equal(s.players[0].hand.length, before + 1, '手牌里多一张');
  assert.ok(s.players[0].hand.some((c) => c.cardId === 'U410'), '给的是连斩');
  assert.equal(king(s, 0), 16, '国王回 1 点');
});

test('U410 连斩：每用过一张就 +1 花费，打出后召唤一张回刃', () => {
  const s = game();
  forcePhase(s, 0, 'spell');
  const foe = deploy(s, 1, 'W04', 'mountain', 'front');
  s.chooser = (req) => {
    if (req.type !== 'chooseUnit') return undefined;
    const o = (req.options || []).find((x) => x.uid === foe.uid);
    return o ? { uid: o.uid } : undefined;
  };
  const h1 = give(s, 0, 'U410');
  assert.equal(G.costOf(s, h1), 0, '第一张 0 费');
  G.playCard(s, 0, h1.iid);
  assert.equal(foe.maxHp - foe.hp, 2, '造成 2 点伤害');
  assert.ok(s.players[0].hand.some((c) => c.cardId === 'U409'), '召唤一张回刃进手牌');
  const h2 = give(s, 0, 'U410');
  assert.equal(G.costOf(s, h2), 1, '用过一张后 +1 花费');
});

test('U411 剑心：同一个队友只问一次，攻击力设为 4 并额外攻击一次', () => {
  const s = game();
  forcePhase(s, 0, 'deploy');
  const u = playUnit(s, 0, 'U242', 'mountain', 'front');
  const foe = deploy(s, 1, 'W04', 'mountain', 'front');
  forcePhase(s, 0, 'spell');
  let asked = 0;
  s.chooser = (req) => {
    asked++;
    return req.type === 'chooseUnit' ? { uid: u.uid } : undefined;
  };
  const handBefore = s.players[0].hand.length;
  cast(s, 0, 'U411');
  assert.equal(asked, 1, '同一个队友只问一次');
  assert.equal(u.atk, 4, '攻击力设为 4');
  assert.equal(foe.maxHp - foe.hp, 4, '额外攻击一次（用 4 点的攻击力打对面前排）');
  assert.equal(s.players[0].hand.length, handBefore + 1, '抽一张牌');
});

test('U412 万剑归宗：按敌方单位数打全体敌人，按友方单位数打敌方国王', () => {
  const s = game();
  forcePhase(s, 0, 'deploy');
  playUnit(s, 0, 'W04', 'plainR', 'front');
  const a = deploy(s, 1, 'W04', 'mountain', 'front');
  const b = deploy(s, 1, 'W04', 'water', 'front');
  forcePhase(s, 0, 'spell');
  const handBefore = s.players[0].hand.length;
  cast(s, 0, 'U412');
  assert.equal(a.maxHp - a.hp, 2, '敌方 2 个单位，每个吃 2 点');
  assert.equal(b.maxHp - b.hp, 2, '另一条线的也吃 2 点');
  assert.equal(king(s, 1), 19, '友方 1 个单位，敌方国王吃 1 点');
  assert.equal(s.players[0].hand.length, handBefore + 1, '抽一张牌');
});

test('U414 超重低音：点选一个目标打 3 点，所有敌方单位 -2 攻击力 -2 生命', () => {
  const s = game();
  const a = deploy(s, 1, 'W04', 'mountain', 'front');
  const b = deploy(s, 1, 'W04', 'water', 'front');
  forcePhase(s, 0, 'spell');
  s.chooser = (req) => (req.type === 'chooseUnit' ? { uid: a.uid } : undefined);
  cast(s, 0, 'U414');
  assert.equal(a.maxHp - a.hp, 3, '被点名的吃 3 点（再加全体 -2 生命已含在上限里）');
  assert.equal(a.maxHp, 4, '生命上限 -2');
  assert.equal(a.atk, 3, '攻击力 -2');
  assert.equal(b.maxHp, 4, '未被点名的也 -2 生命上限');
  assert.equal(b.hp, 4, '当前生命一起降');
  assert.equal(b.atk, 3, '也 -2 攻击力');
});

test('U415 降噪耳机：在场时所有敌方单位 -1 攻击力 -1 生命上限，1 血单位当场阵亡，离场后还回来', () => {
  const s = game();
  const tough = deploy(s, 1, 'W04', 'mountain', 'front');
  const weak = deploy(s, 1, 'W02', 'plainL', 'front');
  assert.equal(weak.hp, 1, 'W02 是 1 血');
  forcePhase(s, 0, 'deploy');
  const headset = playUnit(s, 0, 'U415', 'plainR', 'front');
  assert.equal(effectiveAtk(s, tough), 4, '敌方 -1 攻击力');
  assert.equal(tough.maxHp, 5, '敌方 -1 生命上限');
  assert.equal(tough.hp, 5, '当前生命一起降');
  assert.equal(at(s, 'plainL', 1, 'front'), null, '1 血单位被压到 0，当场阵亡');
  G.sacrificeUnit(s, 0, headset.uid);
  syncStatAuras(s);
  assert.equal(effectiveAtk(s, tough), 5, '光环撞掉后攻击力还回来');
  assert.equal(tough.maxHp, 6, '生命上限也还回来');
});

test('U416 和弦：在手牌中让被锦囊选中的敌人 -1 攻击力 -1 生命，不花费用', () => {
  const s = game();
  const foe = deploy(s, 1, 'W04', 'mountain', 'front');
  forcePhase(s, 0, 'spell');
  give(s, 0, 'U416');
  s.chooser = (req) => (req.type === 'chooseUnit' ? { uid: foe.uid } : undefined);
  const manaBefore = s.players[0].mana;
  const hc = give(s, 0, 'U410');
  G.playCard(s, 0, hc.iid);
  assert.equal(foe.maxHp - foe.hp, 2, '连斩打出 2 点');
  assert.equal(foe.atk, 4, '手里的和弦跟着 -1 攻击力');
  assert.equal(foe.maxHp, 5, '并 -1 生命上限');
  assert.equal(s.players[0].mana, manaBefore, '和弦在手牌里发动不花费用');
  assert.ok(s.log.some((e) => e.type === 'in-hand-trigger'), '要写日志，界面好弹一样的横幅');
});

test('U417 反应堆：回合开始给友方 +1 费用', () => {
  const s = game();
  forcePhase(s, 0, 'deploy');
  playUnit(s, 0, 'U417', 'mountain', 'front');
  nextTurn(s);
  assert.equal(s.players[0].mana, s.players[0].manaCap + 1, '费用回满后再 +1');
});

test('U417 反应堆：被消灭时对这条线上的敌方单位造成 4 点', () => {
  const s = game();
  forcePhase(s, 0, 'deploy');
  const r = playUnit(s, 0, 'U417', 'mountain', 'front');
  const foe1 = deploy(s, 1, 'W04', 'mountain', 'front');
  const foe2 = deploy(s, 1, 'W04', 'water', 'front');
  assert.equal(dealDamage(s, null, { kind: 'unit', unit: r }, 1), 1, '1 血打死');
  G.flushTriggers(s);
  assert.equal(foe1.maxHp - foe1.hp, 4, '同线路的敌人吃 4 点');
  assert.equal(foe2.maxHp - foe2.hp, 0, '别的线路不挨打');
});

test('U418 博士：带锦囊免疫，回合开始抽一张牌', () => {
  const s = game();
  forcePhase(s, 0, 'deploy');
  const d = playUnit(s, 0, 'U418', 'mountain', 'front');
  assert.ok(d.keywords.some((k) => k.id === 'spellImmune'), '带锦囊免疫');
  const before = s.players[0].hand.length;
  nextTurn(s);
  assert.equal(s.players[0].hand.length, before + 2, '回合开始抽一张');
});

test('U419 克隆：重复你上一张锦囊的效果，并抽一张牌', () => {
  const s = game();
  const a = deploy(s, 1, 'W04', 'mountain', 'front');
  forcePhase(s, 0, 'spell');
  cast(s, 0, 'U398');
  assert.equal(a.maxHp - a.hp, 2, '第一张打 2 点');
  assert.equal(king(s, 1), 18, '敌方国王也 2 点');
  const before = s.players[0].hand.length;
  cast(s, 0, 'U419');
  assert.equal(a.maxHp - a.hp, 4, '克隆又打了一次');
  assert.equal(king(s, 1), 16, '敌方国王又吃 2 点');
  assert.equal(s.players[0].hand.length, before + 1, '克隆自己还要抽一张');
});

test('U419 克隆：上一张也是克隆时不再套娃', () => {
  const s = game();
  forcePhase(s, 0, 'spell');
  cast(s, 0, 'U419');
  const before = s.players[0].hand.length;
  cast(s, 0, 'U419');
  assert.equal(s.players[0].hand.length, before + 1, '只抽自己那一张，没有无限套娃');
});

test('U420 前沿科技：把新兴研究放进手牌，下个回合开始时再抽一张', () => {
  const s = game();
  forcePhase(s, 0, 'spell');
  cast(s, 0, 'U420');
  assert.ok(s.players[0].hand.some((c) => c.cardId === 'U421'), '新兴研究进了手牌');
  assert.ok(!s.players[0].hand.some((c) => c.cardId === 'U420'), '自己已经打出去了');
  const before = s.players[0].hand.length;
  nextTurn(s);
  assert.equal(s.players[0].hand.length, before + 2, '下个回合开始时抽一张');
});

test('U421 新兴研究：友方手牌永久 -1 费用，打出的友方单位随机 +1 攻击力或 +1 生命', () => {
  const s = game();
  forcePhase(s, 0, 'spell');
  const hc = give(s, 0, 'U242');
  const costBefore = G.costOf(s, hc);
  cast(s, 0, 'U421');
  assert.equal(G.costOf(s, hc), Math.max(0, costBefore - 1), '手牌永久 -1 费用');
  forcePhase(s, 0, 'deploy');
  const u = playUnit(s, 0, 'U242', 'mountain', 'front');
  assert.ok(u.atk === 3 || u.maxHp === 4, '随机拿到 +1 攻击力或 +1 生命');
});

test('U422 神使：替国王承受伤害，回合开始装甲 +1', () => {
  const s = game();
  forcePhase(s, 0, 'deploy');
  const g1 = playUnit(s, 0, 'U422', 'mountain', 'front');
  assert.equal(g1.atk, 1);
  assert.equal(g1.maxHp, 4);
  dealDamage(s, null, { kind: 'king', side: 0 }, 3);
  assert.equal(king(s, 0), 20, '国王一点血不掉');
  assert.equal(g1.maxHp - g1.hp, 2, '神使顶上（装甲 1 挡掉 1 点）');
  nextTurn(s);
  assert.equal(g1.keywords.find((k) => k.id === 'armor').x, 2, '回合开始装甲 +1');
});

test('U423 祈祷：本回合国王每次受伤 -2，并回复 3 点，下回合失效', () => {
  const s = game();
  s.players[0].kingHp = 15;
  forcePhase(s, 0, 'spell');
  cast(s, 0, 'U423');
  assert.equal(king(s, 0), 18, '回复 3 点（15 + 3）');
  dealDamage(s, null, { kind: 'king', side: 0 }, 5);
  assert.equal(king(s, 0), 15, '这一下 5 点被减到 3 点');
  s.turn += 1;
  dealDamage(s, null, { kind: 'king', side: 0 }, 5);
  assert.equal(king(s, 0), 10, '下一回合不再减免，实吃 5 点');
});

test('U424 诅咒：一名敌人的攻击力永久设为 0，之后的加成也无效', () => {
  const s = game();
  const foe = deploy(s, 1, 'W04', 'mountain', 'front');
  forcePhase(s, 0, 'spell');
  s.chooser = (req) => (req.type === 'chooseUnit' ? { uid: foe.uid } : undefined);
  cast(s, 0, 'U424');
  assert.equal(foe.atk, 0, '攻击力被设为 0');
  M.buffAtk(s, foe, 3);
  assert.equal(foe.atk, 0, '之后再怎么加也还是 0');
});

test('U425 神罚：攻击力 3 或以上的敌人被永久设为 0，其余不动', () => {
  const s = game();
  const big = deploy(s, 1, 'W04', 'mountain', 'front');
  const small = deploy(s, 1, 'W02', 'water', 'front');
  forcePhase(s, 0, 'spell');
  cast(s, 0, 'U425');
  assert.equal(big.atk, 0, '5 攻的被打成 0');
  assert.equal(small.atk, 2, '2 攻的不受影响');
});

//
group('18 认输与 AI 补刀（作者 2026-10-05）');
//

test('认输：立刻终局、判对方胜、文案两端一致，且重复调用不改结果', () => {
  const s = game({ seed: 31 });
  assert.equal(G.surrender(s, 0), 1);
  assert.equal(s.winner, 1);
  assert.equal(s.winReason, '一方认输');
  const last = s.log[s.log.length - 1];
  assert.equal(last.type, 'game-over');
  assert.equal(G.surrender(s, 0), 1);
  assert.equal(s.winner, 1, '重复认输不该改结果');
});

test('AI 补刀：pickFragileTarget 挑生命最低的敌人，没有单位时退国王', () => {
  const s = game({ seed: 32 });
  const tough = deploy(s, 1, 'W04', 'mountain', 'front');
  const weak = deploy(s, 1, 'U242', 'mountain', 'front');
  const options = [
    { uid: tough.uid, side: 1, label: 'tough' },
    { uid: weak.uid, side: 1, label: 'weak' },
    { king: true, side: 1 },
  ];
  assert.equal(pickFragileTarget(s, options).uid, weak.uid, '应当补刀生命最低的单位');
  const kingOnly = pickFragileTarget(s, [{ king: true, side: 1 }]);
  assert.equal(kingOnly.king, true, '没有单位可选时退回国王');
});

//
group('19 炼金阵营（作者 2026-10-07：原料 / 炼药 / 令牌）');
//

/** 炼金开局：双方都选炼金（autoResolveChoices 已由 game() 打开） */
function alchemyGame(cfg = {}) {
  return game(Object.assign({ factions: ['alchemy', 'alchemy'] }, cfg));
}

/** 往手里塞几张原料（绕过抽牌），返回手牌实例 */
function rawHand(state, side, ids) {
  return ids.map((cardId) => give(state, side, cardId));
}

test('原料堆 14 张：起手抽的牌不产原料（作者口径），第 1 回合开始的抽牌才产', () => {
  const s = alchemyGame();
  assert.equal(s.players[0].faction, 'alchemy', '阵营应当写进对局');
  // 14 张的原料堆，减去第 1 回合开始时「每回合开始各抽 1 张」带出来的那 1 张
  assert.equal(G.rawPileOf(s, 0).length, 13, '先手原料堆 13');
  assert.equal(G.rawPileOf(s, 1).length, 13, '后手原料堆 13');
  assert.equal(s.players[0].hand.filter((h) => s.cardLib[h.cardId].rawMaterial).length, 1, '先手手里 1 张原料');
  assert.equal(s.players[1].hand.filter((h) => s.cardLib[h.cardId].rawMaterial).length, 1, '后手手里 1 张原料');
});

test('每抽一张牌就飞一张原料；抽干不补、也不洗回（作者口径 Q3）', () => {
  const s = alchemyGame();
  const p = s.players[0];
  const pile = G.rawPileOf(s, 0).length;
  M.drawCards(s, 0, 3);
  assert.equal(G.rawPileOf(s, 0).length, pile - 3, '抽 3 张就飞 3 张原料');
  let guard = 0;
  while (G.rawPileOf(s, 0).length > 0 && guard++ < 40) M.drawCards(s, 0, 1);
  const rawNow = p.hand.filter((h) => s.cardLib[h.cardId].rawMaterial).length;
  M.drawCards(s, 0, 2);
  assert.equal(G.rawPileOf(s, 0).length, 0, '原料堆会被抽干');
  assert.equal(p.hand.filter((h) => s.cardLib[h.cardId].rawMaterial).length, rawNow, '抽干之后不再产原料');
});

test('原料不能直接打出：引擎拒绝，也不在合法出牌里', () => {
  const s = alchemyGame();
  const m = give(s, 0, 'U426');
  forcePhase(s, 0, 'spell');
  assert.throws(() => G.playCard(s, 0, m.iid, {}), '直接打原料应当被拒绝');
  assert.ok(!G.getLegalPlays(s, 0).some((pl) => pl.iid === m.iid), '合法出牌里不该有原料');
});

test('炼药：按消耗原料的组合给令牌，原料回堆，费用是各自费用之和（作者口径 Q2.a）', () => {
  const s = alchemyGame();
  const mats = rawHand(s, 0, ['U428', 'U428', 'U426']);
  forcePhase(s, 0, 'spell');
  const hand0 = s.players[0].hand.length;
  const pile0 = G.rawPileOf(s, 0).length;
  const mana0 = s.players[0].mana;
  G.brew(s, 0, [mats[0].iid, mats[1].iid]);
  const hand = s.players[0].hand;
  assert.ok(hand.some((h) => h.cardId === 'U434'), '两张陨铁应当炼出玄剑 U434');
  assert.ok(!hand.some((h) => h.iid === mats[0].iid || h.iid === mats[1].iid), '被消耗的原料应当离开手牌');
  assert.equal(hand.length, hand0 - 1, '两张换一张令牌');
  assert.equal(G.rawPileOf(s, 0).length, pile0 + 2, '原料回到原料堆');
  assert.equal(s.players[0].mana, mana0 - 2, '陨铁 1 + 陨铁 1 = 2 费');
  const ev = s.log.filter((e) => e.type === 'brew').pop();
  assert.equal(ev.cost, 2, '日志里的花费');
  assert.equal(ev.token, 'U434', '日志里的令牌');
});

test('炼药组合表 11 条逐条兑现；组合对不上就不给令牌（原料照样回堆、费用照付）', () => {
  const CASES = [
    [['U426', 'U426'], 'U435'],
    [['U427', 'U427'], 'U437'],
    [['U428', 'U428'], 'U434'],
    [['U429', 'U429'], 'U439'],
    [['U426', 'U427'], 'U442'],
    [['U426', 'U428'], 'U441'],
    [['U426', 'U429'], 'U440'],
    [['U427', 'U428'], 'U438'],
    [['U427', 'U429'], 'U443'],
    [['U428', 'U429'], 'U444'],
    [['U426', 'U427', 'U428', 'U429'], 'U436'],
  ];
  for (const [ids, token] of CASES) assert.equal(G.comboTokenFor(ids), token, ids.join(' + '));
  assert.equal(G.comboTokenFor(['U426', 'U428', 'U428']), null, '没有对应组合就不给令牌');

  const s = alchemyGame();
  const mats = rawHand(s, 0, ['U426', 'U428', 'U428']);
  forcePhase(s, 0, 'spell');
  const hand0 = s.players[0].hand.length;
  const pile0 = G.rawPileOf(s, 0).length;
  const mana0 = s.players[0].mana;
  G.brew(s, 0, mats.map((m) => m.iid));
  assert.equal(s.players[0].hand.length, hand0 - 3, '凑不出组合就不给令牌');
  assert.equal(G.rawPileOf(s, 0).length, pile0 + 3, '原料照样回堆');
  assert.equal(s.players[0].mana, mana0 - 2, '费用照付（金沙 0 + 陨铁 1 + 陨铁 1）');
  assert.equal(s.log.filter((e) => e.type === 'brew').pop().token, null, '日志里记的是没出令牌');
});

test('炼药的合法性：至少两张、必须是手里的原料、费用不足拒绝、非炼金阵营不能炼', () => {
  const s = alchemyGame();
  const mats = rawHand(s, 0, ['U428', 'U428']);
  const other = give(s, 0, 'U05');
  forcePhase(s, 0, 'spell');
  s.players[0].mana = 1;
  assert.throws(() => G.brew(s, 0, [mats[0].iid, mats[1].iid]), '费用不足应当拒绝');
  assert.throws(() => G.brew(s, 0, [mats[0].iid]), '只给一张原料应当拒绝');
  assert.throws(() => G.brew(s, 0, [mats[0].iid, 999999]), '不在手里的 iid 应当拒绝');
  assert.throws(() => G.brew(s, 0, [mats[0].iid, other.iid]), '非原料手牌应当拒绝');
  s.players[0].mana = 5;
  G.brew(s, 0, [mats[0].iid, mats[1].iid]);

  const plain = game();
  const pm = rawHand(plain, 0, ['U426', 'U426']);
  forcePhase(plain, 0, 'spell');
  assert.equal(G.rawPileOf(plain, 0).length, 0, '非炼金阵营没有原料堆');
  assert.throws(() => G.brew(plain, 0, [pm[0].iid, pm[1].iid]), '非炼金阵营不能炼药');
});

test('U444 事故：加入手牌时自动使用（对所有单位 3 点，也打自己人）并结束当前出牌回合', () => {
  const s = alchemyGame();
  deploy(s, 0, 'U242', 'mountain', 'front');
  const foeU = deploy(s, 1, 'W04', 'mountain', 'front');
  const foeHp = foeU.hp;
  const mats = rawHand(s, 0, ['U428', 'U429']);
  forcePhase(s, 0, 'spell');
  G.brew(s, 0, mats.map((m) => m.iid));
  assert.ok(!s.players[0].hand.some((h) => h.cardId === 'U444'), '事故不该留在手里');
  assert.ok(s.log.some((e) => e.type === 'cast' && e.cardId === 'U444' && e.auto), '事故应当被自动打出');
  assert.ok(!at(s, 'mountain', 0, 'front'), '我方单位也被打（作者口径：事故也打自己的单位）');
  assert.equal(at(s, 'mountain', 1, 'front').hp, foeHp - 3, '敌方单位吃 3 点');
  assert.notEqual(s.phase, 'SPELL_FIRST', '打完事故要结束当前出牌回合');
});

test('U433 炼金潮：本回合打出非原料锦囊时抽一张牌（打它自己也触发）', () => {
  const s = alchemyGame();
  forcePhase(s, 0, 'spell');
  const tide = give(s, 0, 'U433');
  const deck0 = s.deck.length;
  const pile0 = G.rawPileOf(s, 0).length;
  G.playCard(s, 0, tide.iid, {});
  assert.equal(s.players[0].alchemyTideTurn, s.turn, '本回合挂着炼金潮');
  assert.equal(s.deck.length, deck0 - 1, '打出炼金潮自己就该抽一张');
  assert.equal(G.rawPileOf(s, 0).length, pile0 - 1, '抽的这张也会带一张原料');
});

test('U431 未收录粉尘：选 2 张原料进手牌，且它们的花费为 0（作者口径）', () => {
  const s = alchemyGame();
  forcePhase(s, 0, 'spell');
  const dust = give(s, 0, 'U431');
  const pile0 = G.rawPileOf(s, 0).length;
  const before = s.players[0].hand.map((h) => h.iid);
  G.playCard(s, 0, dust.iid, {});
  const news = s.players[0].hand.filter((h) => before.indexOf(h.iid) < 0 && s.cardLib[h.cardId].rawMaterial);
  assert.equal(news.length, 2, '应当多两张原料');
  assert.equal(G.rawPileOf(s, 0).length, pile0 - 2, '原料从原料堆里取');
  for (const h of news) assert.equal(G.costOf(s, h), 0, '选中的原料花费为 0');
});

test('U432 解禁：国王获「可在自己的单位回合打出超能力锦囊」', () => {
  const s = alchemyGame();
  forcePhase(s, 0, 'spell');
  const unlock = give(s, 0, 'U432');
  G.playCard(s, 0, unlock.iid, {});
  assert.ok(G.alchemyUnlock(s, 0), '国王应当拿到解禁');

  const plain = alchemyGame();
  forcePhase(plain, 0, 'deploy');
  const d0 = give(plain, 0, 'U431');
  assert.throws(() => G.playCard(plain, 0, d0.iid, {}), '没解禁时单位回合不能打锦囊');

  forcePhase(s, 0, 'deploy');
  const d1 = give(s, 0, 'U431');
  G.playCard(s, 0, d1.iid, {});
});

test('U430 巫毒娃娃：每回合友方国王首次受到的伤害整笔改由敌方国王承受', () => {
  const s = alchemyGame();
  deploy(s, 0, 'U430', 'mountain', 'front');
  const mine0 = king(s, 0);
  const foe0 = king(s, 1);
  dealDamage(s, null, { kind: 'king', side: 0 }, 3);
  assert.equal(king(s, 0), mine0, '我方国王一点没掉');
  assert.equal(king(s, 1), foe0 - 3, '整笔转给敌方国王');
  dealDamage(s, null, { kind: 'king', side: 0 }, 2);
  assert.equal(king(s, 0), mine0 - 2, '同一回合第二次不再转移');
});

//
group('T 三阵营：炼狱 / 极寒 / 罪恶');
//

/** 三阵营对局：双方同阵营（autoResolveChoices 已由 game() 打开） */
function factionGame(faction, cfg = {}) {
  return game(Object.assign({ factions: [faction, faction] }, cfg));
}

/** 取某单位某个词条的层数（没有这个词条返回 -1） */
function kwX(unit, id) {
  const hit = (unit.keywords || []).find((k) => (typeof k === 'string' ? k : k.id) === id);
  if (!hit) return -1;
  return typeof hit === 'string' ? 0 : (hit.x || 0);
}

function hasKw(unit, id) {
  return kwX(unit, id) >= 0;
}

test('三阵营已注册：FACTIONS 有炼狱/极寒/罪恶，T 组 17 张进卡库（含 5 张令牌）', () => {
  assert.ok(G.FACTIONS.inferno && G.FACTIONS.frost && G.FACTIONS.sin, '三个阵营都在 FACTIONS 里');
  const s = factionGame('inferno');
  assert.equal(s.players[0].faction, 'inferno', '阵营写进对局');
  const ids = Object.keys(s.cardLib).filter((id) => {
    const f = s.cardLib[id].faction;
    return f === 'inferno' || f === 'frost' || f === 'sin';
  });
  assert.equal(ids.length, 17, '三阵营合计 17 张');
  assert.equal(ids.filter((id) => s.cardLib[id].token).length, 5, '其中 5 张是令牌');
});

test('U445 燥热难忍：一名队友获得狂热并+2生命，召唤一张怒火', () => {
  const s = factionGame('inferno');
  const ally = deploy(s, 0, 'U461', 'mountain', 'front');
  const hp0 = ally.maxHp;
  cast(s, 0, 'U445', { targetUid: ally.uid });
  assert.ok(hasKw(ally, 'frenzy'), '队友应当获得狂热');
  assert.equal(ally.maxHp, hp0 + 2, '生命上限 +2');
  assert.ok(s.players[0].hand.some((h) => h.cardId === 'U449'), '召唤的怒火应当进手牌');
});

test('U446 活火山：双重打击，出手时同时打全场敌方单位与敌方国王', () => {
  const s = factionGame('inferno');
  playUnit(s, 0, 'U446', 'mountain', 'front');
  const v = at(s, 'mountain', 0, 'front');
  assert.ok(hasKw(v, 'doubleStrike'), '活火山带双重打击');
  // 隔壁线路的高血敌人：撑住两轮，用来数「双重打击 = 出手两次」
  const tank = deploy(s, 1, 'U446', 'plainR', 'front');
  tank.maxHp = 20;
  tank.hp = 20;
  const k0 = king(s, 1);
  combat(s);
  assert.equal(tank.hp, 18, '隔壁线路的敌人也吃两次 1 点');
  assert.equal(king(s, 1), k0 - 2, '敌方国王同样吃两次 1 点');
});

test('U447 黑曜石：一名队友+3生命，并在每回合开始时+1攻击力（还抽一张牌）', () => {
  const s = factionGame('inferno');
  const ally = deploy(s, 0, 'U461', 'mountain', 'front');
  const hp0 = ally.maxHp;
  const deck0 = s.deck.length;
  cast(s, 0, 'U447', { targetUid: ally.uid });
  assert.equal(ally.maxHp, hp0 + 3, '生命上限 +3');
  assert.equal(s.deck.length, deck0 - 1, '抽一张牌');
  assert.ok((ally.effects || []).some((e) => e.trigger === 'onTurnStart'), '挂上每回合开始的异能');
  const atk0 = ally.atk;
  nextTurn(s);
  nextTurn(s);
  assert.ok(ally.atk >= atk0 + 1, '回合开始后攻击力增加（' + atk0 + ' -> ' + ally.atk + '）');
});

test('U448 炽热岩浆：一名队友+3攻击力+1生命，召唤一张余温', () => {
  const s = factionGame('inferno');
  const ally = deploy(s, 0, 'U461', 'mountain', 'front');
  const atk0 = ally.atk;
  const hp0 = ally.maxHp;
  cast(s, 0, 'U448', { targetUid: ally.uid });
  assert.equal(ally.atk, atk0 + 3, '攻击力 +3');
  assert.equal(ally.maxHp, hp0 + 1, '生命上限 +1');
  assert.ok(s.players[0].hand.some((h) => h.cardId === 'U450'), '召唤的余温应当进手牌');
});

test('U449 怒火（令牌）：造成 3 点伤害', () => {
  const s = factionGame('inferno');
  const foe = deploy(s, 1, 'U446', 'mountain', 'front');
  assert.ok(s.cardLib.U449.token, '怒火是令牌');
  cast(s, 0, 'U449', { targetUid: foe.uid });
  assert.equal(foe.hp, 1, '4 生命吃 3 点');
});

test('U450 余温（令牌）：移动一名队友并使其获得溅射2', () => {
  const s = factionGame('inferno');
  const ally = deploy(s, 0, 'U461', 'mountain', 'front');
  cast(s, 0, 'U450', { targetUid: ally.uid });
  assert.ok(!at(s, 'mountain', 0, 'front'), '应当被移出原来的格子');
  assert.equal(kwX(ally, 'splash'), 2, '获得溅射2');
});

test('U451 寒星霜：冻结一名敌人并-2攻击力，召唤一张寒星追', () => {
  const s = factionGame('frost');
  const foe = deploy(s, 1, 'U461', 'mountain', 'front');
  const atk0 = foe.atk;
  cast(s, 0, 'U451', { targetUid: foe.uid });
  assert.ok(isFrozen(foe), '目标应当被冻结');
  assert.equal(foe.atk, atk0 - 2, '攻击力 -2');
  assert.ok(s.players[0].hand.some((h) => h.cardId === 'U455'), '召唤的寒星追应当进手牌');
});

test('U452 冰刃出击：冻结两条相邻线路的敌人并造成 2 点伤害', () => {
  const s = factionGame('frost');
  const a = deploy(s, 1, 'U461', 'mountain', 'front');
  const b = deploy(s, 1, 'U461', 'plainL', 'front');
  const c = deploy(s, 1, 'U461', 'plainR', 'front');
  for (const u of [a, b, c]) { u.maxHp = 10; u.hp = 10; }
  cast(s, 0, 'U452');
  const frozen = [a, b, c].filter((u) => isFrozen(u));
  assert.equal(frozen.length, 2, '正好冻住两条线路上的敌人');
  for (const u of frozen) assert.equal(u.hp, 8, '被冻住的敌人各吃 2 点');
  assert.ok([a, b, c].some((u) => !isFrozen(u) && u.hp === 10), '没被选中的线路不受影响');
});

test('U453 冰轮旋舞：冻结一条线路的敌人，召唤冰轮狂舞并抽一张牌', () => {
  const s = factionGame('frost');
  const a = deploy(s, 1, 'U461', 'mountain', 'front');
  const b = deploy(s, 1, 'U461', 'plainL', 'front');
  for (const u of [a, b]) { u.maxHp = 10; u.hp = 10; }
  const deck0 = s.deck.length;
  cast(s, 0, 'U453');
  assert.equal([a, b].filter((u) => isFrozen(u)).length, 1, '只冻住一条线路');
  assert.ok(s.players[0].hand.some((h) => h.cardId === 'U454'), '召唤的冰轮狂舞应当进手牌');
  assert.equal(s.deck.length, deck0 - 1, '抽一张牌');
});

test('U454 冰轮狂舞（令牌）：对所有被冻结的敌人造成 2 点伤害', () => {
  const s = factionGame('frost');
  const a = deploy(s, 1, 'U461', 'mountain', 'front');
  const b = deploy(s, 1, 'U461', 'plainR', 'front');
  const c = deploy(s, 1, 'U461', 'water', 'front');
  for (const u of [a, b, c]) { u.maxHp = 10; u.hp = 10; }
  cast(s, 0, 'U451', { targetUid: a.uid });
  cast(s, 0, 'U451', { targetUid: b.uid });
  cast(s, 0, 'U454');
  assert.equal(a.hp, 8, '被冻住的敌人吃 2 点（10 - 2）');
  assert.equal(b.hp, 8, '另一条线路被冻住的敌人也吃 2 点（10 - 2）');
  assert.equal(c.hp, 10, '没被冻住的不受影响');
});

test('U455 寒星追（令牌）：对被冻结的敌人造成 4 点伤害，然后解除所有冻结', () => {
  const s = factionGame('frost');
  const a = deploy(s, 1, 'U461', 'mountain', 'front');
  const b = deploy(s, 1, 'U461', 'plainL', 'front');
  for (const u of [a, b]) { u.maxHp = 12; u.hp = 12; }
  cast(s, 0, 'U451', { targetUid: a.uid });
  cast(s, 0, 'U451', { targetUid: b.uid });
  cast(s, 0, 'U455');
  assert.equal(a.hp, 8, '被冻住的敌人吃 4 点');
  assert.equal(b.hp, 8, '另一名被冻住的敌人也吃 4 点');
  assert.ok(!isFrozen(a) && !isFrozen(b), '解除所有单位的冻结');
  assert.ok(s.log.some((e) => e.type === 'clear-freeze' && e.count === 2), '记录了解冻数量');
});

test('U456 雪人：有敌人被冻结时获得+2攻击力+1生命', () => {
  const s = factionGame('frost');
  const snow = deploy(s, 0, 'U456', 'water', 'front');
  const foe = deploy(s, 1, 'U461', 'mountain', 'front');
  const atk0 = snow.atk;
  const hp0 = snow.maxHp;
  cast(s, 0, 'U451', { targetUid: foe.uid });
  assert.ok(isFrozen(foe), '敌人被冻住');
  assert.equal(snow.atk, atk0 + 2, '攻击力 +2');
  assert.equal(snow.maxHp, hp0 + 1, '生命上限 +1');
});

test('U456 雪人：融合进化打出时冻结一个敌方单位', () => {
  const s = factionGame('frost');
  deploy(s, 0, 'U456', 'mountain', 'front');
  const foe = deploy(s, 1, 'U461', 'plainL', 'front');
  playUnit(s, 0, 'U456', 'mountain', 'front');
  assert.ok(isFrozen(foe), '融合进化时冻结一个敌方单位');
});

test('U457 色欲：队友获得捕猎与「攻击时:对敌方国王造成等同攻击力的伤害」', () => {
  const s = factionGame('sin');
  const ally = deploy(s, 0, 'U461', 'mountain', 'front');
  cast(s, 0, 'U457', { targetUid: ally.uid });
  assert.ok(hasKw(ally, 'hunt'), '获得捕猎');
  assert.ok((ally.effects || []).some((e) => e.trigger === 'onAttack'), '挂上攻击时异能');
  const k0 = king(s, 1);
  const foe = deploy(s, 1, 'U446', 'mountain', 'front');
  foe.maxHp = 20;
  foe.hp = 20;
  const atk = ally.atk;
  combat(s);
  assert.equal(king(s, 1), k0 - atk, '敌方国王吃到等同攻击力的伤害');
});

test('U458 妒忌：对攻击力最高的敌人造成 5 点伤害，召唤一张恶意', () => {
  const s = factionGame('sin');
  const weak = deploy(s, 1, 'U461', 'mountain', 'front');
  const strong = deploy(s, 1, 'U461', 'plainL', 'front');
  for (const u of [weak, strong]) { u.maxHp = 10; u.hp = 10; }
  strong.atk = 7;
  cast(s, 0, 'U458');
  assert.equal(strong.hp, 5, '攻击力最高的那个吃 5 点');
  assert.equal(weak.hp, 10, '另一个不受影响');
  assert.ok(s.players[0].hand.some((h) => h.cardId === 'U459'), '召唤的恶意应当进手牌');
});

test('U459 恶意（令牌）：随机弃置敌方一张牌并复制进手牌，再抽一张', () => {
  const s = factionGame('sin');
  forcePhase(s, 1, 'spell');
  s.players[1].hand[0].cardId;
  const foeHand0 = s.players[1].hand.length;
  const myHand0 = s.players[0].hand.length;
  const deck0 = s.deck.length;
  const discard0 = s.discard.length;
  const stolenId = s.players[1].hand.map((h) => h.cardId);
  cast(s, 0, 'U459');
  assert.equal(s.players[1].hand.length, foeHand0 - 1, '敌方少一张手牌');
  assert.equal(s.players[0].hand.length, myHand0 + 2, '复制一张 + 抽一张');
  const ev = s.log.filter((e) => e.type === 'discard' && e.stolen).pop();
  assert.ok(ev, '应当记一条 stolen 弃牌日志');
  assert.ok(ev.iid !== undefined, '弃牌日志要带 iid，界面才能播出飞行动画');
  assert.ok(stolenId.indexOf(ev.cardId) >= 0, '被抢的是敌方原本的手牌');
  assert.ok(s.players[0].hand.some((h) => h.cardId === ev.cardId), '复制的那张进了我方手牌');
  assert.equal(s.discard.length, discard0 + 2, '被弃置的牌进弃牌堆（打出的令牌自己也会进弃牌堆）');
  assert.ok(s.discard.indexOf(ev.cardId) >= 0, '被弃置的那张牌确实在弃牌堆里');
  assert.equal(s.deck.length, deck0 - 1, '抽一张牌');
});

test('U460 暴食：消灭生命最低的敌人，友方国王回复 5 点，抽一张牌', () => {
  const s = factionGame('sin');
  const low = deploy(s, 1, 'U446', 'mountain', 'front');
  const high = deploy(s, 1, 'U446', 'plainL', 'front');
  low.hp = 1;
  s.players[0].kingHp = 10;
  const deck0 = s.deck.length;
  cast(s, 0, 'U460');
  assert.ok(low.removed, '生命最低的被消灭');
  assert.equal(high.hp, 4, '另一个不受影响');
  assert.equal(king(s, 0), 15, '友方国王回复 5 点');
  assert.equal(s.deck.length, deck0 - 1, '抽一张牌');
});

test('U461 贪婪：捕猎+组合；被消灭时友方国王回复 4 点', () => {
  const s = factionGame('sin');
  const greedy = deploy(s, 0, 'U461', 'mountain', 'front');
  assert.ok(hasKw(greedy, 'hunt') && hasKw(greedy, 'combo'), '捕猎 + 组合');
  s.players[0].kingHp = 10;
  const foe = deploy(s, 1, 'U461', 'mountain', 'front');
  foe.atk = 5;
  combat(s);
  assert.ok(greedy.removed, '贪婪应当被消灭');
  assert.equal(king(s, 0), 14, '被消灭时友方国王回复 4 点');
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
