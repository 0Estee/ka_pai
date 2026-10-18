/**
 * 测试卡牌库（占位用，即用即弃）
 *
 * ⚠️ 这不是正式卡牌设计。它的唯一目的是让规则引擎能跑起来并被验证。
 *    每个词条尽量各出一张卡，方便单独测试该词条的结算。
 *    你出正式卡牌时，直接替换本文件即可，引擎代码不用改。
 *
 * ── 卡牌定义 schema ──────────────────────────────────────
 * 单位：
 *   id        唯一编号（字符串）
 *   name      卡名
 *   type      'unit'
 *   cost      费用
 *   atk       攻击力
 *   hp        生命
 *   keywords  词条数组，支持三种写法：
 *               'armor:1'           字符串带参
 *               'aquatic'           字符串无参
 *               { id:'armor', x:1 } 对象（推荐）
 *   effects   触发式异能数组：
 *               [{ trigger:'onPlay'|'onDeath'|'onDealDamage', actions:[...] }]
 *
 * 锦囊：
 *   id, name, type:'spell', spellKind:'attack'|'item', cost,
 *   actions   [效果动作数组]，效果发动后卡牌进入弃牌堆
 *
 * ── 效果动作（action）───────────��────────────────────────
 *   { op:'damage',    amount:N, target:{kind:...} }
 *   { op:'destroy',   target:{kind:...} }
 *   { op:'sacrifice', target:{kind:'chosenOwnUnit'} }   不可献祭自身
 *   { op:'draw',      amount:N, side:'controller'|'opponent' }
 *   { op:'gainMana',  amount:N, side:... }
 *   { op:'gainManaCap', amount:N, side:... }             费用上限增长
 *   { op:'heal'|'buffAtk'|'buffMaxHp', amount:N, target:{kind:...} }
 *   { op:'summon',    cardId:'XXX', lane, row, side }
 *
 * ── 目标选择器（target.kind）─────────────────────────────
 *   self / controller / ownKing / enemyKing
 *   chosenEnemyUnit / chosenOwnUnit / chosenEnemyFront
 *   allEnemyUnits / allOwnUnits
 *   allEnemyUnitsInLane / adjacentEnemyUnits
 *   （selector.filter:'spellTargetable' 会排除「锦囊免疫」单位）
 */

import { createRng, shuffle } from '../src/rng.js';
import { USER_CARDS } from './user-cards.js';
import { USER_CARDS_B3 } from './user-cards-b3.js';

/** 作者设计的全部卡牌（第二批 U01~U17 + 第三批 U20~） */
export const AUTHOR_CARDS = [...USER_CARDS, ...USER_CARDS_B3];

/**
 * ⚠️ 这些是**引擎自检用的白板测试卡**（W01~W05 / K* / E*），不是正式卡牌。
 * 作者 2026-10-18 要求把白板测试卡从游戏里清干净 —— 但它们仍留在 cardLib 里，
 * 只为两件事：
 *   1. engine/test/smoke.mjs 用它们做「基础战斗数学」的基准对照；
 *   2. 老回放的 cardSetId 里含这些 id，删掉会让历史回放全部判成「卡牌库已变动」。
 * 所以给它们打上 legacy 标记：**不进工坊、不进牌库、不进 AI 强化池**，
 * 玩家在游戏里再也见不到它们（见 enhance.js 的 isForgeable 与 buildTestDeck）。
 */
export const DEMO_CARDS = [
  // ── 白板（用于验证基础战斗数学）─────────────────────────
  { id: 'W01', name: '白板新兵', type: 'unit', cost: 1, atk: 1, hp: 2, keywords: [] },
  { id: 'W02', name: '白板卫士', type: 'unit', cost: 1, atk: 2, hp: 1, keywords: [] },
  { id: 'W03', name: '白板重装', type: 'unit', cost: 3, atk: 2, hp: 4, keywords: [] },
  { id: 'W04', name: '白板巨兽', type: 'unit', cost: 6, atk: 5, hp: 6, keywords: [] },
  { id: 'W05', name: '石墙', type: 'unit', cost: 1, atk: 0, hp: 4, keywords: [] },

  // ── 触发式词条 ───────────────────────────────────────────
  {
    id: 'K01', name: '双刃剑客', type: 'unit', cost: 3, atk: 2, hp: 3,
    keywords: ['doubleStrike'],
  },
  {
    id: 'K02', name: '嗜血狂徒', type: 'unit', cost: 4, atk: 3, hp: 3,
    keywords: ['frenzy'],
  },
  {
    id: 'K03', name: '瘟疫使者', type: 'unit', cost: 3, atk: 2, hp: 3,
    keywords: ['disease'],
  },
  {
    id: 'K16', name: '投石车', type: 'unit', cost: 4, atk: 3, hp: 3,
    keywords: ['splash:1'],
  },
  {
    id: 'K17', name: '毒刃刺客', type: 'unit', cost: 3, atk: 2, hp: 3,
    keywords: ['poison:2'],
  },
  {
    id: 'K18', name: '破阵枪骑', type: 'unit', cost: 4, atk: 3, hp: 3,
    keywords: ['pierce:1'],
  },

  // ── 替代式词条（受伤修正）────────────────────────────────
  {
    id: 'K04', name: '铁甲卫士', type: 'unit', cost: 2, atk: 2, hp: 4,
    keywords: ['armor:1'],
  },
  {
    id: 'K05', name: '荆棘藤蔓', type: 'unit', cost: 2, atk: 1, hp: 3,
    keywords: ['thorns:2'],
  },
  {
    id: 'K06', name: '圣光庇护者', type: 'unit', cost: 3, atk: 2, hp: 4,
    keywords: ['blessing:2'],
  },
  {
    id: 'K06b', name: '圣盾铁卫', type: 'unit', cost: 4, atk: 2, hp: 4,
    keywords: ['blessing:2', 'armor:1'], // 用于验证结算链顺序
  },

  // ── 静态 / 打出限制 ─────────────────────────────────────
  {
    id: 'K07', name: '水路鲛人', type: 'unit', cost: 2, atk: 2, hp: 2,
    keywords: ['aquatic'],
  },
  {
    id: 'K08', name: '两栖蛙人', type: 'unit', cost: 2, atk: 2, hp: 2,
    keywords: ['amphibious'],
  },
  {
    id: 'K09', name: '轻灵风灵', type: 'unit', cost: 3, atk: 3, hp: 4,
    keywords: ['nimble'], // 原「飞行」
  },
  {
    id: 'K13', name: '不灭圣灵', type: 'unit', cost: 5, atk: 1, hp: 3,
    keywords: ['invincible'],
  },
  {
    id: 'K14', name: '阵列队长', type: 'unit', cost: 3, atk: 2, hp: 3,
    keywords: ['combo'],
  },

  // ── 带异能的单位（验证 onPlay / onDeath / onDealDamage）──
  {
    id: 'E01', name: '斥候', type: 'unit', cost: 2, atk: 1, hp: 1,
    keywords: [],
    effects: [{ trigger: 'onPlay', actions: [{ op: 'draw', amount: 1 }] }],
  },
  {
    id: 'E02', name: '复仇亡魂', type: 'unit', cost: 3, atk: 2, hp: 2,
    keywords: [],
    effects: [{
      trigger: 'onDeath',
      actions: [{ op: 'damage', amount: 2, target: { kind: 'enemyKing' } }],
    }],
  },
  {
    id: 'E03', name: '淬毒蜘蛛', type: 'unit', cost: 3, atk: 1, hp: 4,
    keywords: [],
    effects: [{
      trigger: 'onDealDamage',
      actions: [{ op: 'damage', amount: 1, target: { kind: 'chosenEnemyUnit' } }],
    }],
  },
];

/**
 * 给白板测试卡打上 legacy 标记。
 *
 * 打上之后：工坊不列（enhance.js 的 isForgeable）、AI 不强化、
 * 牌库不抽（buildTestDeck 只从 AUTHOR_CARDS 里取）—— 玩家在游戏里见不到它们。
 * 但 TEST_CARD_LIB 里仍然保留，engine/test/smoke.mjs 的白板基准与
 * 老回放的 cardSetId 都还要靠它们。
 */
for (const c of DEMO_CARDS) c.legacy = true;

/**
 * 最终卡牌库 = 引擎自检用的演示卡 + 作者设计的卡牌（user-cards.js）。
 * 界面与 AI 只认 TEST_CARDS，所以两边都能自动用上。
 */
export const TEST_CARDS = [...DEMO_CARDS, ...AUTHOR_CARDS];

/** 卡牌库：{ [id]: CardDef } */
export const TEST_CARD_LIB = Object.fromEntries(TEST_CARDS.map((c) => [c.id, c]));

/**
 * 把种子打散。
 *
 * ⚠️ 为什么需要：xorshift32 用**相邻的种子**初始化时，头几个输出高度相关，
 * 而 Fisher-Yates 的头几轮恰好决定数组尾部—— 也就是**被切掉的那 `pool-size` 张**。
 * 后果不是「随机性略差」，而是**某几张卡会连续几十局都进不了牌库**
 * （实测：40 个连续种子跑下来，U62 一次都没被抽中）。
 * 用一个整数雪崩函数混一下就好了。
 */
function mixSeed(x) {
  let v = (x >>> 0) || 0x9e3779b9;
  v = Math.imul(v ^ (v >>> 16), 0x45d9f3b) >>> 0;
  v = Math.imul(v ^ (v >>> 16), 0x45d9f3b) >>> 0;
  return (v ^ (v >>> 16)) >>> 0;
}

/**
 * 生成一副用于模拟 / 实战的卡组。
 *
 * ── 令牌不进牌库 ──────────────────────────────────────────
 * 卡面类型下方带「令」的是**令牌**（`token: true`）：不可从牌库中抽得，
 * 只能被特定卡牌召唤到场上或手牌（作者补充规则）。所以这里先把它们滤掉。
 *
 * ── 卡池比卡组大的情况（作者已裁决）────────────────────────
 * 作者卡现在有一百多张，而卡组 80 张 —— 装不下。
 * 早期版本是「每张放 N 份然后 slice(0,size)」，卡一多就变成
 * **永远只有前 80 张能出现**（U11 之后整批进不了卡组，作者报过这个 bug）。
 *
 * 现在的做法（作者裁决）：**从全部卡里随机抽 80 张**。
 * 抽取用传入的种子，所以同一局永远拿到同一副牌 —— 回放与联机的确定性靠这个；
 * 不同对局则换一批卡，多打几局就能把所有卡都试到。
 *
 * @param {number} size 卡组张数（应用内传 80）
 * @param {number} seed 抽子集用的种子（应用内传当局种子）
 */
export function buildTestDeck(size = 30, seed = 0) {
  // 「令」= 令牌，带阵营的 = 超能力，都不进普通牌库。
  // **白板测试卡（DEMO_CARDS）也不再进牌库**（作者 2026-10-18：清干净）。
  const pool = AUTHOR_CARDS.filter((c) => !c.token && !c.faction);
  if (pool.length === 0) return [];

  const ids = pool.map((c) => c.id);
  const rng = createRng(mixSeed(seed));
  shuffle(rng, ids);

  // 卡池比卡组大 → 取洗好的前 size 张（每张 1 份）
  if (ids.length >= size) return ids.slice(0, size);

  // 卡池比卡组小时按洗好的顺序循环补足 —— 只补卡池里的牌，不掺白板卡
  const deck = [];
  while (deck.length < size) deck.push(ids[deck.length % ids.length]);
  return deck;
}

/**
 * 卡池里所有能进牌库的卡：非令牌、且没有阵营。
 * 带阵营的是「超能力」（作者 2026-10-03），只能靠阵营系统抽到，不进普通牌库。
 */
export const DECKABLE_CARDS = AUTHOR_CARDS.filter((c) => !c.token && !c.faction);

/** 所有令牌卡（只能被召唤） */
export const TOKEN_CARDS = AUTHOR_CARDS.filter((c) => c.token);
