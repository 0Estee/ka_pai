/**
 * 对手 AI（启发式）与其 5 个难度。
 *
 * ── 设计原则 ──────────────────────────────────────────────
 * 前三个难度**只改决策水平，不碰规则** —— 用的牌、费用、起手都和玩家完全一样。
 * 赢了是赢得干净，输了也输得明白。
 * 只有「噩梦」额外给一点优势，而且**在界面上明说**，不偷偷作弊。
 *
 * ── 难度靠什么拉开 ────────────────────────────────────────
 *   defense      防守意识：会不会补前排挡刀、会不会算换牌
 *   wHp          生命权重：越笨的 AI 越只看攻击力，容易把脆皮送上去
 *   passThreshold 出牌积极性：分数低于它就不出牌（越高越消极、越爱留费用）
 *   jitter       随机噪声：越大越不稳，会出现明显的臭棋
 *   lookahead    会不会算「我放上去之后对面怎么吃掉我」
 *   bonus        额外的开局优势（只有噩梦有；「不可能」不加任何优势）
 *   planner      会不会真的推演：把自己这手牌之后的双方各一个回合模拟一遍再挑
 *
 * 关键行为：会补前排阻挡、会换掉能杀的敌人、会用锦囊解场或抽牌。
 * 随机 AI 完全不防守，会导致对局在 6 回合内崩掉，没法测玩法。
 */

import * as G from '../../engine/src/engine.js';
import { LANES, ROWS } from '../../engine/src/constants.js';
import { matchesTargetFilter } from '../../engine/src/keywords.js';
import { filterCtx, effectiveAtk } from '../../engine/src/auras.js';
// 「控制」类效果要判断「我这边放不放得下」—— 与引擎同一个判据（心驭，作者 2026-10-24）
import { findControlSpot } from '../../engine/src/mechanics.js';
// allUnits 直接用引擎的实现 —— 这里**不能**再自己写一份：
// 打包器把所有模块拼进同一个作用域，重名的函数会互相覆盖，
// 连 mechanics.js 内部的调用都会被顶掉。build-web.mjs 会拦截这种情况。
import { allUnits, drawCards } from '../../engine/src/mechanics.js';
import { createRng } from '../../engine/src/rng.js';

/** 取词条的数值参数 */
const kwX = (unit, id) => {
  const k = (unit.keywords || []).find((x) => x.id === id);
  return k ? k.x : 0;
};

// ══════════════════════════════════════════════════════════
// 难度表
// ══════════════════════════════════════════════════════════

/**
 * 五个难度。**调难度只改这张表。**
 *
 * 数值不是拍脑袋定的 —— 是拿 `tools/` 里的参数扫描脚本
 * 逐项和「普通」对打（各 160 局）量出来的。结论有点反直觉：
 *
 *   出牌阈值（passThreshold）是**最大的杠杆**：-1 → -3 能拿到 +8.8 个百分点的胜率。
 *     这条游戏里费用不累积，所以「能打就打」确实比「留着费用」好。
 *   而「更会防守」（defense 调高）**反而更弱**（1.6 → 44%）：过度前压会白送单位。
 *   生命权重（wHp）调高也变弱。
 *   一步预判（lookahead）单独用略亏（48.8%），所以噩梦靠的是
 *   「预判 + 额外优势」，而不是只靠预判。
 */
const BASE = {
  wHp: 0.7,
  wFront: 2.0,
  wBlockUrgent: 5.0,
  wTradeKill: 3.0,
  wThreat: 0.5,
  wChip: 0.3,
  wBackOpen: 1.5,
  wZeroBack: -6.0,
  wSquishyBack: 1.0,
  wFragile: -2.0,
  wLookahead: 0.8,
  wSpread: 1.5,
};

export const DIFFICULTIES = [
  {
    ...BASE,
    key: 'easy',
    name: '简单',
    tagline: '只会下单位，不会用锦囊',
    // 结构性差异，不是微调参数 —— 微调（阈值 ±2、生命权重 ±0.2）
    // 打 200 局的差距还不到随机波动的两倍，玩家根本感觉不到。
    noSpells: true,
    passThreshold: 1.5,
    jitter: 1.0,
    lookahead: false,
    bonus: null,
  },
  {
    ...BASE,
    key: 'normal',
    name: '普通',
    tagline: '会防守、会用锦囊，但算不到下一步',
    // 这一档就是加难度系统之前的老 AI，手感没变
    passThreshold: -1.0,
    jitter: 0.1,
    lookahead: false,
    bonus: null,
  },
  {
    ...BASE,
    key: 'hard',
    name: '困难',
    tagline: '出牌不靠运气，每一步都算',
    // ⚠ 实测说明（2026-09，第三批 129 张卡的卡池，卡组 80 张抽样，每档 150 局）
    //
    //   这一档换过两次口径，都是被实测推翻的：
    //     ① 最早是「永不跳过」（passThreshold -100），在 17 张卡的旧卡池上 +2.3 个百分点；
    //        卡池换大之后失效 —— 把手里所有牌一股脑打光反而变亏。
    //     ② 改成「普通 + 一步预判 + 预判权重 1.5」，当时量到 +6.6；
    //        129 张卡池下再量，它**反而比普通低 7 个百分点**（47.3% vs 54.0% 同侧对照）。
    //
    //   129 张卡池下的完整实测（同侧对照「普通 vs 普通」= 54.0%，这一列不是 50%）：
    //     普通但去掉随机性（本档现在的决策参数） 54.0%  ← 与对照持平
    //     + 起手多 1 张                        52.7%  ← 没用
    //     + 每回合多 1 费                      70.0%  ← 有效
    //     + 起手多 1 张 + 每回合多 1 费          72.7%
    //     预判 + 起手多 1 张                    50.7%
    //
    //   结论：这个启发式 AI 在决策层面**已经没有可调的空间**（换任何参数都不比普通强），
    //   唯一能真正拉开差距的是资源优势。作者 2026-10 重新定了两档的资源优势：
    //     困难 = 起手多 1 张 + 国王生命上限 +6（**不加费**）
    //     噩梦 = 起手多 1 张 + 每回合多 1 费 + 国王生命上限 +8
    //   这些优势都**逐条写在难度选择界面上**，不偷偷作弊。
    //   想让它退回「和普通同级」，把 bonus 改成 null 即可。
    passThreshold: -1.0,
    jitter: 0,
    lookahead: false,
    // 作者 2026-10 口径：起手多 1 张 + 国王生命上限 +6，**不加费**。
    // 实测：多给手牌对胜负几乎没有影响，多给费用才会明显变强；所以「困难」给的是不压制玩家的那一档。
    bonus: {
      hand: 1,            // 起手多 1 张
      kingHp: 6,          // 国王生命上限 +6
    },
  },
  {
    ...BASE,
    key: 'nightmare',
    name: '噩梦',
    tagline: '和你同级地打，看得比你远一点',
    // 与「困难」同样是普通级的决策 + 去掉随机性 —— 实测「永不跳过 + 预判」
    // 这个大卡池下反而更弱（47% vs 54% 同侧对照），所以不再用它们。
    passThreshold: -1.0,
    jitter: 0,
    lookahead: false,
    // 这是**唯一**给 AI 加费的难度，并且**会在选难度时逐条写出来**，不偷偷作弊。
    // 作者 2026-10 口径：起手多 1 张 + 每回合多 1 费 + 国王生命上限 +8。
    // （旧的「起手多 2 张」拿掉了：多给手牌几乎不影响胜负，优势集中到费用上。）
    bonus: {
      hand: 1,            // 起手多 1 张
      manaPerTurn: 1,     // 每回合多 1 费（会同时写进 flatManaBonus 与当回合费用）
      kingHp: 8,          // 国王生命上限 +8
    },
  },
  {
    ...BASE,
    key: 'impossible',
    name: '不可能',
    tagline: '每一步都在脑子里试打几遍，算完才落子',
    // 作者 2026-10：这一档**不加任何数值优势**（bonus 为 null  费用 / 手牌 /
    // 国王血量和玩家完全一样），强的地方只有一个：真的把后面几步推演一遍。
    // 引擎里的启发式参数已经没有可调空间（见上面的实测：换任何参数都不比普通强），
    // 所以「从智商上」变强只能上结构性改法：模拟出牌  双方各打一个回合  评估局面。
    passThreshold: -1.0,
    jitter: 0,
    lookahead: false,
    bonus: null,
    // 作者 2026-10-24：这一档还要**看得到对手手牌和双方下一次抽到的牌**。
    // 这是**信息型**优势，不是数值优势 —— 手牌张数 / 费用 / 国王血量仍然和玩家完全一样，
    // 但和「噩梦」的数值优势一样，必须在选难度界面逐条写明（screens.js 的 diff-insight），
    // 门禁 09 会对账，不允许偷偷开。关掉它做对照：传 params { insight: null }。
    insight: { hand: true, deck: true },
    planner: 'rollout',   // 打开模拟前瞻
    /**
     * 作者 2026-10-27：引擎中途反问的每一问（弃哪张 / 封印谁 / 选哪条线 / 抉择走哪支 /
     * 召唤落哪格 / 拿哪张原料）也要自己算，不能再用引擎兜底的「取第一个选项」。
     *
     * 这是**决策水平**的提升，不是数值优势 —— 和 insight 一样只改选择、不改规则，
     * 所以不给它单独做界面文案；其余四档保持原来的手感，别顺手改掉。
     * 实测（13 阵营随机、种子 1-24、写死 0 档）：开 / 关只有 2 局结局相同，
     * 平均回合从 8.9 掉到 7.6 —— 它让对局变短，也就是更会推。
     */
    smartChoices: true,
    // 留手也交给推演决定（agent 2026-10 的实测改动，见 aiTakeTurn 里的 rolloutPass 分支）。
    // 原来是「贪心分低于 -1 就不出牌」，手调的常数 —— 实测它才是这一档最大的短板：
    //   写死第 0 档打噩梦，n=240（种子 1-240）：117/122/1 = 48.8%（关掉留手判定则 111/128/1 = 46.3%）
    //   另一段互不重叠的种子，n=120（种子 500-619）：59/60/1 = 49.2%（关掉则 55/64/1 = 45.8%）
    //   打「普通」那一档两种做法都在 94% 附近（n=240：93.8% vs 94.6%，已经碰到天花板）
    // 选推演版而不是再手调一个更低的阈值，是因为这套游戏里手调阈值**已经被推翻两次**
    // （见上面「困难」档的实测记录：-100 在旧卡池 +2.3 点，卡池换大后反而变亏）。
    // 交给推演就没有这个失效模式：卡池怎么换，它按同一把尺子重新比。
    // 代价：每次规划多推演一次「留手」，n=20 实测 184 次规划多 162 次克隆（+13%）。
    rolloutPass: true,
    // 推演档位是**实测扫出来的**（120 局  两组互不重叠的种子，见 README 的难度表）：
    //   K4/S8  打噩梦 25.8%  K8/S12 40.0%  K8/S20 45.8%（再深到 S28/S36 反而回落 40.8%）
    //   越深越准，但每个候选都要克隆一整局再往后再推，手机上太深会卡；S20 是拐点。
    // 推演的档位表在 PLAN_LEVELS（最省的一档就是原来的 K8/S20）。这里是**一整个回合**
    // 的推演时间上限：作者 2026-10 允许几秒延迟，让规划器自己往上爬档 ——
    // 手机上慢就自动少算一档，不会卡死；机器快就把 5 档跑满。
    // 跑参数扫描时用 planLevel 写死档位（可复现，不受机器快慢影响）。
    planBudgetMs: 6000,
  },
];

export const DEFAULT_DIFFICULTY = 'normal';

export function difficultyByKey(key) {
  return DIFFICULTIES.find((d) => d.key === key) || DIFFICULTIES[1];
}

/** 难度对 AI 那一边的增益（只有噩梦有实际内容）。在开局时调用一次。 */
/**
 * 施加一份「额外优势」。抽成独立函数是为了**回放能原样重放同一个加成**：
 * 有加成的那一局如果在重放时不加，会因为「费用不够」在中途崩掉。
 * 见 replay.js 的 createReplayPlayer。
 */
export function applyBonusObject(state, side, b) {
  if (!b) return;
  const p = state.players[side];

  if (b.hand) drawCards(state, side, b.hand);
  if (b.manaPerTurn) p.flatManaBonus = (p.flatManaBonus || 0) + b.manaPerTurn;
  if (b.kingHp) {
    p.kingMaxHp += b.kingHp;
    p.kingHp += b.kingHp;
  }
  // 立刻生效：费用上限要在本回合就体现出来
  p.manaCap = (p.manaCap || 0) + (b.manaPerTurn || 0);
  p.mana += (b.manaPerTurn || 0);
}

export function applyDifficultyBonus(state, side, difficultyKey) {
  applyBonusObject(state, side, difficultyByKey(difficultyKey).bonus);
}

// ══════════════════════════════════════════════════════════
// 评分
// ══════════════════════════════════════════════════════════

/** 估算 def 打 unit 实际能造成多少伤害（粗略计入装甲/祝福） */
function effectiveDamage(def, unit) {
  let dmg = def.atk || 0;
  const blessing = kwX(unit, 'blessing');
  if (blessing && dmg > blessing) dmg = blessing;
  dmg = Math.max(0, dmg - kwX(unit, 'armor'));
  return dmg;
}

/** 估算 unit 反击 def 会掉多少血（只考虑攻击力，不算荆棘）。用有效攻击力，计入光环 */
function threatOf(state, unit) {
  return effectiveAtk(state, unit) || 0;
}

/**
 * 「噩梦」专用：估算对手在这条线路上能拿出的最强反击。
 *
 * 刻意**不去克隆 state 做真前瞻** —— 复制整个 GameState（含 cardLib）
 * 又慢又容易出微妙的错。这里只回答一个问题：
 * 「我把这个单位放上去，对面最狠的一下会让我亏多少？」
 * 这已经能挡掉大部分「把脆皮白送」的臭棋。
 */
function opponentBestReply(state, side, lane, def) {
  const foe = 1 - side;
  let worst = 0;
  for (const u of allUnits(state)) {
    if (u.side !== foe || u.lane !== lane) continue;
    const dmg = effectiveAtk(state, u);
    if (dmg <= 0) continue;
    const wouldDie = dmg >= (def.hp || 0);
    // 被打死 = 白送一个单位；只是掉血 = 亏一部分价值
    const loss = wouldDie
      ? (def.atk || 0) * 1.0 + (def.hp || 0) * 0.7
      : dmg * 0.35;
    if (loss > worst) worst = loss;
  }
  return worst;
}

// ── 「不可能」的信息优势：对手手牌 + 双方下一抽（作者 2026-10-24）──
/**
 * 「不可能」看得到两样东西：**对手手上的牌**和**牌库顶（双方下一次各抽到什么）**。
 *
 * 这是**信息型**优势，不是数值优势：手牌张数、费用、国王血量和玩家完全一样。
 * 但和「噩梦」的数值优势一样，它必须**在选难度界面逐条写明**（screens.js 的 diff-insight），
 * 门禁 09 会逐条对账 —— 这里没有偷偷给。
 *
 * 三条自我约束（和推演同一套纪律）：
 *   1. 只读：不写任何 state 字段、不推进 rng、不改牌序；
 *   2. 只在 P.insight 打开时生效，其余四档 AI 走的还是原来的路径；
 *   3. 全部走函数参数，不做全局状态，回放 / 联机锁步不受影响。
 *
 * 关掉它做对照：aiTakeTurn 传 params { insight: null }。
 */
function insightOn(P) {
  return !!(P && P.insight);
}

/** 一张手牌「大概值多少」—— 只看卡面，不模拟。单位看身材，锦囊看效果。 */
function cardHandValue(def) {
  if (!def) return 0;
  if (def.type === 'unit') return (def.atk || 0) * 0.9 + (def.hp || 0) * 0.5 + (def.cost || 0) * 0.2;
  let v = (def.cost || 0) * 0.2;
  for (const a of def.actions || []) {
    const amt = typeof a.amount === 'number' ? a.amount : 2;
    switch (a.op) {
      case 'damage': v += amt * 0.7; break;
      case 'destroy': v += 4.0; break;
      case 'control': v += 4.5; break;
      case 'stealToHand': v += 4.0; break;
      case 'draw': v += amt * 1.8; break;
      case 'heal': v += amt * 0.4; break;
      case 'buffAtk':
      case 'buffMaxHp':
      case 'modifyStats': v += amt * 0.9; break;
      case 'summon':
      case 'summonRandomToken': v += 2.2; break;
      case 'seal':
      case 'freeze':
      case 'bounce': v += 1.6; break;
      default: v += 0.6;
    }
  }
  return v;
}

/** 对手手上的「解牌」：能打到最大多少血的单位，有没有硬解 / 控制 */
function removalInHand(state, foe) {
  const hand = (state.players[foe] && state.players[foe].hand) || [];
  let maxDmg = 0;
  let hasHard = false;
  for (const hc of hand) {
    const def = state.cardLib[hc.cardId];
    if (!def || def.type !== 'spell') continue;
    for (const a of def.actions || []) {
      if (a.op === 'damage') {
        // 只算指向「敌方单位」的伤害；只打国王的那种不能解场
        const spec = a.target || {};
        if (spec.kind === 'chosenKing' || spec.kind === 'enemyKing') continue;
        const amt = typeof a.amount === 'number' ? a.amount : 2;
        if (amt > maxDmg) maxDmg = amt;
      } else if (a.op === 'destroy' || a.op === 'control' || a.op === 'stealToHand') {
        hasHard = true;
      }
    }
  }
  return { maxDmg, hasHard };
}

/**
 * 这一方**下一次**抽牌会抽到的卡面。
 * 抽牌顺序是后手先抽、先手后抽（engine/src/turns.js 的 onTurnStart），
 * 所以后手拿 deck[0]、先手拿 deck[1]；deck 空则没有下一抽。
 */
function nextDrawCard(state, side) {
  const deck = state.deck;
  if (!deck || deck.length === 0) return null;
  const first = state.firstPlayer === 0 ? 0 : 1;
  const idx = side === 1 - first ? 0 : 1;
  const id = deck[idx];
  return id ? state.cardLib[id] || null : null;
}

/** 手牌总价值（只在「不可能」打开 insight 时用） */
function handValue(state, side) {
  const hand = (state.players[side] && state.players[side].hand) || [];
  let v = 0;
  for (const hc of hand) v += cardHandValue(state.cardLib[hc.cardId]);
  return v;
}

/**
 * 某一方手牌里**能直接打到对方国王**的伤害合计（只数锦囊，单位要下场才算）。
 * 对**对手**用这个函数，就是「不可能」的信息优势本体：
 * 玩家看不到 AI 的手牌，AI 看得到玩家的 —— 于是它知道对面手里压着几点斩杀。
 */
function kingDamageInHand(state, side) {
  const hand = (state.players[side] && state.players[side].hand) || [];
  let sum = 0;
  for (const hc of hand) {
    const def = state.cardLib[hc.cardId];
    if (!def || def.type !== 'spell') continue;
    for (const a of def.actions || []) {
      if (a.op !== 'damage') continue;
      const spec = a.target || {};
      const canHitKing =
        spec.kind === 'enemyKing' ||
        spec.kind === 'chosenKing' ||
        spec.kind === 'king' ||
        (spec.kind === 'chosenEnemyTarget' && spec.allowKing !== false);
      if (!canHitKing) continue;
      sum += typeof a.amount === 'number' ? a.amount : 2;
    }
  }
  return sum;
}

/**
 * 「对面下一回合能打掉我多少国王血」= 他手上的直伤 + 他空线白打脸的攻击力。
 * 只有打开 insight 才会读**对方**手牌；不打开时这个函数根本不会被调用。
 */
function incomingThreat(state, side) {
  const foe = 1 - side;
  const mine = state.players[side];
  const burst = kingDamageInHand(state, foe) + freeLaneDamage(state, foe);
  const kingHp = (mine && mine.kingHp) || 1;
  return { burst, lethal: burst >= kingHp, half: burst * 2 >= kingHp };
}

/** 我这一回合能打掉对面多少国王血（手牌直伤 + 空线白打脸）—— 用来判断能不能一波斩杀 */
function myBurst(state, side) {
  return kingDamageInHand(state, side) + freeLaneDamage(state, side);
}

// ── 单位落点评分 ──────────────────────────────────────────

function scoreUnitPlacement(state, side, def, lane, row, P) {
  const foe = 1 - side;
  const foeFront = state.board[lane].units[foe].front;
  const myFront = state.board[lane].units[side].front;

  let score = (def.atk || 0) * 1.0 + (def.hp || 0) * P.wHp - (def.cost || 0) * 0.25;

  // 前排是阻挡位，天然有价值；后排只有安全输出价值
  if (row === 'front') {
    score += P.wFront;
    // 对面有前排而我没有 → 再不挡国王就要被打
    if (foeFront && !myFront) score += P.wBlockUrgent;
    // 能换掉对面这个单位
    if (foeFront) {
      const dmg = effectiveDamage(def, foeFront);
      if (dmg >= foeFront.hp) score += P.wTradeKill + threatOf(state, foeFront) * P.wThreat;
      else if (dmg > 0) score += threatOf(state, foeFront) * P.wChip;
    }
  } else {
    // 后排：不会被普通交战命中，适合高攻低血的输出单位
    if (!foeFront) score += P.wBackOpen;   // 对面这路没前排，后排可以安全打脸
    if ((def.atk || 0) === 0) score += P.wZeroBack; // 0 攻单位放后排纯浪费
    if ((def.hp || 0) <= 2) score += P.wSquishyBack; // 脆皮更适合后排
  }

  // 前排放太脆的单位容易被白吃
  if (row === 'front' && foeFront && (def.hp || 0) <= threatOf(state, foeFront)) {
    score += P.wFragile;
  }

  // 预判：算一下对面最狠的反击值多少
  if (P.lookahead) {
    score -= opponentBestReply(state, side, lane, def) * P.wLookahead;
  }

  // 「不可能」看得到对手手牌 → 知道对面手上压着什么解牌。
  // 这里只做一件事：被一张牌就能点掉的血量，别主动送到前排去换；
  // 反过来，一张牌解不掉的血线，前排的阻挡价值更值钱。**不改任何规则，只改选择。**
  if (insightOn(P)) {
    const rm = removalInHand(state, 1 - side);
    const hp = def.hp || 0;
    if (row === 'front') {
      if (hp <= rm.maxDmg) score -= 2.4;
      else if (rm.maxDmg > 0) score += 1.2;
      if (rm.hasHard && hp <= 3) score -= 1.4;   // 硬解 / 控制牌对小块头也有威胁
    } else if (rm.hasHard && hp >= 5) {
      score -= 1.0;                              // 后排躲不过硬解，别把大单位当安全牌堆在后排
    }

    // 它还算得出「对面下回合能不能一波打死我」。能打死的时候先堵枪眼：
    // 这一路对面本来可以白打脸多少攻击力，挡住它就值多少。
    const threat = P.insightBlock === false ? { lethal: false, half: false } : incomingThreat(state, side);
    if (threat.lethal || threat.half) {
      const free = laneFreeDamage(state, 1 - side, lane);
      if (row === 'front' && free > 0) {
        score += free * (threat.lethal ? 0.8 : 0.3) + (threat.lethal ? 2.0 : 0.6);
      }
    }
  }

  // 尽量均匀分布，避免一路堆满
  const laneFill = ROWS.filter((r) => state.board[lane].units[side][r]).length;
  score -= laneFill * P.wSpread;

  return score;
}

// ── 锦囊目标选择 ──────────────────────────────────────────

/**
 * 选出这张锦囊的最佳目标。
 *   返回 string(uid) → 需要指定单位目标
 *   返回 null        → 无需目标，直接打
 *   返回 undefined   → AI 不处理（需要选线路的效果），跳过这张牌
 */
function bestSpellTarget(state, side, def, P) {
  const actions = def.actions || [];
  const targetSpecs = actions.map((a) => a.target).filter(Boolean);
  const kinds = targetSpecs.map((t) => t.kind);

  if (kinds.length === 0) return null;

  const needsLane = kinds.some((k) => k === 'allEnemyUnitsInLane' || k === 'adjacentEnemyUnits');
  if (needsLane) return undefined;

  // 场上所有单位
  const units = allUnits(state);
  const spec = targetSpecs[0];
  const foe = 1 - side;

  // 「杀单位」类效果：优先挑能杀掉的最大威胁
  const wantsDestroy = actions.some((a) => a.op === 'destroy');
  // 「伤害」类效果
  const damageAmount = actions.find((a) => a.op === 'damage')?.amount ?? 0;
  const wantsHeal = actions.some((a) => a.op === 'heal');
  const wantsSacrifice = actions.some((a) => a.op === 'sacrifice');

  if (spec.kind === 'chosenEnemyUnit' || spec.kind === 'chosenEnemyFront' || spec.kind === 'chosenEnemyTarget') {
    const allowKing = spec.kind === 'chosenEnemyTarget' && spec.allowKing !== false;

    let cands = units.filter((u) => u.side === foe);
    if (spec.kind === 'chosenEnemyFront') cands = cands.filter((u) => u.row === 'front');
    // 与引擎共用同一个过滤器（如「滚石」的 maxAtk:2），避免 AI 选出非法目标
    if (spec.filter) cands = cands.filter((u) => matchesTargetFilter(u, spec.filter, filterCtx(state)));
    // 「控制」：我这边没地方落脚就别选它（引擎会直接判定控制失败，白白浪费一张牌）
    if (spec.controlRoom) cands = cands.filter((u) => !!findControlSpot(state, u, side));

    const scored = [];
    for (const u of cands) {
      let s = threatOf(state, u) * 1.0 + u.hp * 0.4 * P.defense;
      if (wantsDestroy) s += 6.0;                                  // 无差别消灭，挑最值钱的
      if (damageAmount > 0) {
        if (damageAmount >= u.hp) s += 5.0;                        // 能直接秒掉
        else s -= (u.hp - damageAmount) * 1.2;                     // 打不死就贬值
      }
      if (u.row === 'back') s += 0.8;                              // 后排更难处理，优先解
      scored.push({ target: { uid: u.uid }, score: s });
    }

    // 「造成X点伤害」类卡片可以把国王算作候选目标
    if (allowKing && damageAmount > 0) {
      const kingHp = state.players[foe].kingHp;
      let s = damageAmount * 0.9;                                  // 打脸的直接价值
      if (damageAmount >= kingHp) s += 25;                         // 能直接斩杀
      else if (kingHp - damageAmount <= 3) s += 5;                 // 接近斩杀
      // insight：AI 知道自己手上还有几点直伤、场上还有几路白打脸。
      // 这一手能凑成斩杀就全力打脸，差一点点就先打脸压血线。
      if (insightOn(P) && P.insightBurst !== false) {
        const burst = myBurst(state, side);                        // 含这张牌自己
        if (burst >= kingHp) s += 16;
        else if (burst + 3 >= kingHp) s += 4;
      }
      scored.push({ target: { king: true, side: foe }, score: s });
    }

    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score);
    // 分数太低就不要浪费这张牌
    return scored[0].score > 0 ? scored[0].target : null;
  }

  if (spec.kind === 'chosenOwnUnit') {
    const mine = units.filter((u) => u.side === side);
    if (!mine.length) {
      // 没有友方单位：若是献祭类效果就打不出去
      return wantsSacrifice ? undefined : null;
    }
    let best = null;
    let bestScore = -Infinity;
    for (const u of mine) {
      let s = 0;
      if (wantsHeal) s = (u.maxHp - u.hp) * 2.0 - u.hp * 0.1;
      else if (wantsSacrifice) s = -(u.atk * 1.0 + u.hp * 0.6);    // 献祭最没用的
      else s = u.atk * 1.0 + u.hp * 0.5;
      // insight：对面手里有解牌，就越不值得把强化堆在它身上
      if (insightOn(P) && !wantsSacrifice) {
        const rmFoe = removalInHand(state, foe);
        if (rmFoe.hasHard && u.hp >= 4) s -= 3.0;
        else if (rmFoe.maxDmg >= u.hp) s -= 1.5;
      }
      if (s > bestScore) { bestScore = s; best = u; }
    }
    return { uid: best.uid };
  }

  return null;
}

/** 锦囊整体价值评分 */
function scoreSpell(state, side, def, target, P) {
  // 这里用卡面费用做「贵不贵」的偏好即可 —— 真正的**能不能出**由 getLegalPlays 判，
  // 它读的是手牌实例上的费用修正（costOf）。AI 不会因为这里读卡面值而出非法牌。
  let score = -(def.cost || 0) * 0.35;
  const units = allUnits(state);
  // 「不可能」看得到对手手牌：他手上有几点直伤、场上还有几路白打脸，
  // 合起来已经够打死我的时候，能解场的牌现在就得用掉，不能再攒。
  const threat = (insightOn(P) && P.insightSpell !== false) ? incomingThreat(state, side) : null;
  // 动态数值（{perOwnUnit:2} 之类）在评估阶段没有目标上下文，用一个保守估计，
  // 否则 a.amount 是对象、参与算术会变成 NaN，整张牌的评分直接坏掉。
  const amt = (a) => (typeof a.amount === 'number' ? a.amount : 2);

  for (const a of def.actions || []) {
    switch (a.op) {
      case 'damage': {
        score += amt(a) * 0.85;
        if (target && target.king) {
          // 打国王：能斩杀时价值极高，残血时也不差
          const kingHp = state.players[target.side].kingHp;
          if (amt(a) >= kingHp) score += 14.0;
          else if (kingHp - amt(a) <= 3) score += 3.0;
        } else if (target) {
          const t = units.find((u) => u.uid === target.uid);
          if (t && amt(a) >= t.hp) score += 4.0;
          if (threat && threat.lethal) score += 2.0;   // 快被打死了，解场优先
          else if (threat && threat.half) score += 0.8;
        }
        break;
      }
      case 'destroy':
        score += 6.5;
        if (threat && threat.lethal) score += 2.5;     // 斩杀线上，硬解就是保命
        else if (threat && threat.half) score += 1.0;
        break;
      case 'draw':
        score += amt(a) * 2.6;
        break;
      case 'gainManaCap':
        score += amt(a) * 3.2;
        break;
      case 'gainMana':
        score += amt(a) * 1.5;
        break;
      case 'heal':
        score += amt(a) * 0.5;
        break;
      case 'sacrifice':
        score -= 3.5;
        break;
      /**
       * 心驭（作者 2026-10-24）：
       *   · control —— 抢一张敌人过来，等于「消灭 + 自己拍一张」，按对方的威胁估价；
       *   · duel    —— 让两个单位互砍，AI 里按「解掉一个大威胁」的中等价给分；
       *   · summonToHand —— 多一张手牌，按抽牌的一半左右给（它还要再花费用打出去）。
       */
      case 'control': {
        score += 5.5;
        if (target && !target.king) {
          const t = units.find((u) => u.uid === target.uid);
          if (t) score += threatOf(state, t) * 0.55;
        }
        break;
      }
      case 'duel':
        score += 3.2;
        break;
      case 'summonToHand':
        score += 1.6;
        break;
      case 'buffAtk':
      case 'buffMaxHp':
        score += amt(a) * 1.2;
        break;
      case 'modifyStats':
        // -2攻-1血 ≈ 3 点数值差，按 1.1 折算
        score += (Math.abs(a.atk || 0) + Math.abs(a.maxHp || 0)) * 1.1;
        break;
      case 'attachKingEffect':
        // 「友方单位被消灭时抽一张牌」：中后期价值高，给个中等偏上的估值
        score += 3.0;
        break;
      // ── 第三批新 op。不补这些的话 AI 会把「额外攻击」「上封印」这类牌当 0 分，
      //    于是手上有也不打 —— 玩家会觉得「AI 不会用新卡」。
      case 'extraAttack':      case 'summonRandomToken':
        // 随机令牌：不知道抽到什么，按一张中等牌估值
        score += 2.6;
        break;
      case 'endTurnNow':
        // 立即结束本回合：本身不产生数值，进攻性由同一张牌的 extraAttack 体现
        break;
      case 'setStats':
        // 把自己拉回固定身材（正向时值钱，负向时不值）
        if (target && target.unit) {
          const gain = (a.hp !== undefined ? a.hp - target.unit.hp : 0)
            + (a.atk !== undefined ? a.atk - target.unit.atk : 0);
          score += gain * 0.9;
        } else {
          score += 1.0;
        }
        break;
      case 'seal':
        // 封掉对面一个异能单位：中后期值钱，前期一般
        score += 1.8;
        break;
      case 'grantKeyword': {
        // 授予「无敌 / 复生 / 穿透」这类正面词条值钱；授予敌方负面词条也值一点
        const good = ['invincible', 'rebirth', 'pierce', 'frenzy', 'doubleStrike', 'firstStrike', 'splash'];
        const bad = ['disease', 'rooted'];
        if (good.includes(a.keyword)) score += 3.2;
        else if (bad.includes(a.keyword)) score += 2.4;
        else score += 1.6;
        break;
      }
      case 'bounce':
        // 退回手牌 ≈ 软解一个单位
        score += 3.4;
        break;
      case 'freeze':
        // 让它这一回合不出手
        score += 2.2;
        break;
      case 'move':
        // 「转移」这类：本身不强，但因为还带抽牌，给一点正向估值
        score += 0.8;
        break;
      case 'discard':
        // 弃自己的牌是代价
        score -= amt(a) * 1.2;
        break;
      case 'returnToDeck':
        // 洗回牌组：对自己是「换个牌」，对敌方是干扰，给中性偏正
        score += 0.6;
        break;
      case 'discardDrawn':
        // 阻止对方抽牌
        score += 1.4;
        break;
      case 'lockLane':
        // 封锁一块地形：能让对方下不了单位
        score += 2.0;
        break;
      case 'summon':
        // 免费上场的衍生物：价值取决于身材，这里用召唤目标卡面估
        score += 2.6;
        break;
      case 'summonToHand':
        score += 1.6;
        break;
      case 'stealToHand':
        score += 5.0;
        break;
      case 'modifyHandCost':
        // 降费是正向（amount 为负时 score 变大）
        score -= amt(a) * 0.8;
        break;
      default:
        break;
    }
  }
  return score;
}

// ── 主入口 ────────────────────────────────────────────────

/**
 * 「拟定目标攻击」（卡牌「强化士兵」）—— AI 侧自己挑打谁。
 *
 * 引擎在开战结算到这张牌出手时会问目标（见 engine/src/combat.js 的
 * pickCombatTarget）。玩家侧会挂起等人点；AI 侧走这个函数，
 * 由 app/js/game-flow.js 挂到 `state.targetPicker` 上。
 *
 * 口径（作者裁决：AI 自己挑最划算的）：
 *   1. 能**一击打死**的敌方单位 → 打它（白赚一个，还少吃一次反击）
 *      —— 同样打得死，优先挑血厚的（死一个 5/6 比死一个 1/1 值）
 *   2. 打不死任何单位 → 直接打国王
 *      （攻击力打谁都是这么多，打国王是确定收益；打大块头等于替对手挡刀）
 *
 * ⚠ 纯函数、不碰 state.rng：回放重跑与联机锁步都必须得到同一个答案。
 *   难度**不影响**这个选择 —— 它只关系到「打出哪张牌」，不改变这张牌的规则。
 */
export function aiTargetPicker(state, info) {
  if (!state || !info || !info.options || !info.options.length) return null;
  const atk = effectiveAtk(state, info.unit) || 0;

  let best = null;
  for (const o of info.options) {
    if (o.king || o.uid == null) continue;
    const hp = o.hp === undefined ? null : o.hp;
    if (hp === null) continue;
    if (atk >= hp && (!best || hp > best.hp)) best = { uid: o.uid, hp };
  }
  if (best) return info.options.find((o) => o.uid === best.uid) || null;

  const king = info.options.find((o) => o.king);
  if (king) return king;
  // 万一没有国王选项（理论上不会），退回第一个
  return info.options[0] || null;
}

/**
 * 把 AI 的挑目标策略装到这一局上（建局时调一次）。
 * 不装也不会崩：引擎有自带口径（engine/src/combat.js 的 combatTargetPicker）。
 */
export function installAiTargetPicker(state) {
  if (state) state.targetPicker = aiTargetPicker;
  return state;
}

// ══════════════════════════════════════════════════════════
// AI 自行裁定「引擎问到一半」的选择
// ══════════════════════════════════════════════════════════

/**
 * 引擎在效果结算中途会反问「选哪个」。AI 那一侧以前**没有答案**，只会走
 * `choices.js` 的兜底「取第一个选项」—— 而第一个选项按棋盘顺序排，等于随机。
 *
 * 在这套卡里这不是小事：实测 40 局里被兜底吃掉的多选项提问有
 *   chooseUnit 5.5k、chooseEnemyTarget 6.9k、chooseHandCard 1.2k、
 *   chooseLane 1.0k、chooseOption 1.0k、summonCell 178、chooseRawMaterial 318 次。
 * 「弃哪张牌」「封印谁」「冰冻哪两条线」「召唤落在哪」「抉择走哪一支」全在里面 ——
 * 阵营超能力（极寒的选线冻结、炎帝的抉择、炼金的原料）几乎全靠这些分支生效，
 * 交给「取第一个」就等于 AI 只用了阵营卡的字面效果。
 *
 * 这套策略只回答**引擎提出的问题**，不参与「打哪张牌」的决策：
 *   · 纯函数：不写 state、不推进 rng、不读日志（推演克隆里也照常成立）；
 *   · 每一问都当场算一个答案，所以推演里走的分支和真对局一致 ——
 *     这是「不可能」那一档的推演结果能对得上实战的前提；
 *   · 只挂在 `state.chooser` 上，由 aiTakeTurn 在这一次调用期间临时装上，
 *     离开时还原（回放播放器自己那个 chooser 不会被顶掉）。
 *
 * 关闭方式：`aiTakeTurn(..., { params: { chooser: null } })`，做消融对照用。
 */

/** 某只单位此刻的有效攻击力（含光环 / 锁攻），不写 state */
function unitAtk(state, u) {
  return u ? (effectiveAtk(state, u) || 0) : 0;
}

/** 这只单位对 side 的威胁值：攻击力 + 血量的四成，后排再加一点（更难处理） */
function unitThreat(state, u) {
  if (!u) return 0;
  return unitAtk(state, u) + (u.hp || 0) * 0.4 + (u.row === 'back' ? 0.8 : 0);
}

/** 手牌里这张「值多少」—— 复用 cardHandValue，弃牌 / 洗回时挑最不值钱的那张 */
function handCardWorth(state, hc) {
  return cardHandValue(state.cardLib[hc.cardId]);
}

/** 从活着的单位里挑威胁最大 / 最小的那个（ties 按 uid，结果确定） */
function pickUnitByThreat(state, list, wantMax) {
  let best = null;
  let bestScore = wantMax ? -Infinity : Infinity;
  for (const u of list) {
    if (!u || u.removed) continue;
    const s = unitThreat(state, u);
    if (wantMax ? s > bestScore : s < bestScore) { best = u; bestScore = s; }
  }
  return best;
}

/** 我方这一条线上「对面一根毛都没有」= 放上去就能白打脸 */
function laneOpenFor(state, lane, side) {
  return laneFreeDamage(state, side, lane) > 0;
}

/**
 * 一条线上「敌方」的威胁合计：有挡的线路解掉它最值钱。
 */
function laneEnemyWeight(state, lane, side) {
  const foe = 1 - side;
  const row = (state.board[lane] && state.board[lane].units) || {};
  const theirs = row[foe] || {};
  return [theirs.front, theirs.back]
    .filter((u) => u && !u.removed)
    .reduce((sum, u) => sum + unitThreat(state, u), 0);
}

/**
 * 给一个 `chooseUnit` 提问打分。
 *
 * 三档，按 selector 隐含的敌我来分：
 *   敌方 → 威胁最大的那个（威胁 = 攻击力 + 血量，后排更高）
 *   我方 → 挑「最脆、最不重要」的那个（这一问几乎都是代价：献祭 / 弃 / 洗回）
 *   谁都可以 → 敌我各取一侧，用同一把尺子比
 * 另外，「控制」类（`controlRoom`）已经在引擎那边过滤掉了放不下的候选。
 */
function chooseUnitAnswer(state, request) {
  const options = request.options || [];
  if (!options.length) return null;
  if (options.length === 1) return options[0];
  const side = request.side === 1 ? 1 : 0;
  const units = allUnits(state);
  const byUid = new Map(units.map((u) => [u.uid, u]));

  const mine = [];
  const theirs = [];
  for (const o of options) {
    const u = byUid.get(o.uid);
    if (!u || u.removed) continue;
    (u.side === side ? mine : theirs).push(o);
  }

  // ── 1. 我方目标：默认是「代价」，挑最不心疼的
  const scapegoat = () => {
    let worst = null;
    let worstScore = Infinity;
    for (const o of mine) {
      const u = byUid.get(o.uid);
      const s = unitThreat(state, u);
      if (s < worstScore) { worst = o; worstScore = s; }
    }
    return worst;
  };
  // ── 2. 敌方目标：挑威胁最大的
  const target = () => {
    let best = null;
    let bestScore = -Infinity;
    for (const o of theirs) {
      const u = byUid.get(o.uid);
      const s = unitThreat(state, u);
      if (s > bestScore) { best = o; bestScore = s; }
    }
    return best;
  };

  /**
   * 敌方目标里混进了「点名要动敌方」的提问（封印 / 弹射 / 冻结 / 控制 / 抢），
   * 这些一律走 target()。反过来「献祭 / 消耗自己」类走 scapegoat()。
   */
  if (mine.length && theirs.length) {
    // 敌我都可选（「选择一个单位」）：消灭类挑敌方，其余挑自己（代价）
    return target() || scapegoat() || options[0];
  }
  if (theirs.length) return target() || options[0];
  if (mine.length) return scapegoat() || options[0];
  return options[0];
}

/** 敌方单位或敌方国王：能一刀打死国王就先打脸，否则按单位威胁挑 */
function chooseEnemyTargetAnswer(state, request) {
  const options = request.options || [];
  if (!options.length) return null;
  if (options.length === 1) return options[0];
  const side = request.side === 1 ? 1 : 0;
  const foe = 1 - side;
  const units = allUnits(state);
  let best = null;
  let bestScore = -Infinity;
  for (const o of options) {
    let s;
    if (o.king) {
      // 国王值多少：残血国王按「再摸一下就到斩杀线」加价，满血只算常规收益
      const hp = state.players[foe].kingHp;
      s = 6 + Math.max(0, 12 - hp) * 0.8;
    } else {
      const u = units.find((x) => x.uid === o.uid);
      s = unitThreat(state, u);
    }
    if (s > bestScore) { best = o; bestScore = s; }
  }
  return best || options[0];
}

/**
 * 选一条线路。
 *
 * 两种提问共用这一个类型：
 *   · 范围效果（`chooseLanes`）——「冰刃出击：选两条相邻线路」：选敌方单位最多的线
 *   · 「把某只单位移到哪条线」—— 选一条能白打脸、或者能挡住对面空线的线
 * 靠 prompt 里的「移到」分辨（引擎那两条路的 prompt 就是这么写的），
 * 拿不准时退回「敌方最值钱的线」，那是两种情况下都不亏的选择。
 */
function chooseLaneAnswer(state, request) {
  const options = request.options || [];
  if (!options.length) return null;
  if (options.length === 1) return options[0];
  const side = request.side === 1 ? 1 : 0;
  const prompt = String(request.prompt || '');
  const moving = prompt.indexOf('移到') >= 0;
  let best = null;
  let bestScore = -Infinity;
  for (const o of options) {
    const lane = o.lane;
    let s;
    if (moving) {
      // 搬过去能打脸 > 搬过去能挡对面；两边都空的线最没用
      s = laneFreeDamage(state, side, lane) * 1.2
        + laneFreeDamage(state, 1 - side, lane) * 1.0;
    } else {
      // 范围效果：解掉这条线上最多 / 最硬的敌人
      s = laneEnemyWeight(state, lane, side);
      // 空线只值一点点（有些效果带抽牌，不该完全不选，但没有理由优先选）
      if (s === 0) s = 0.2;
    }
    if (s > bestScore) { best = o; bestScore = s; }
  }
  return best || options[0];
}

/**
 * 弃一张手牌 / 洗回牌组：挑**手里最不值钱**的那张。
 * 手里唯一一张牌也得弃 —— 那就弃它（没有第二选择）。
 */
function chooseHandCardAnswer(state, request) {
  const options = request.options || [];
  if (!options.length) return null;
  if (options.length === 1) return options[0];
  const side = request.side === 1 ? 1 : 0;
  const hand = (state.players[side] && state.players[side].hand) || [];
  let best = null;
  let bestWorth = Infinity;
  for (const o of options) {
    const hc = hand.find((c) => c.iid === o.iid);
    const w = hc ? handCardWorth(state, hc) : 0;
    if (w < bestWorth) { best = o; bestWorth = w; }
  }
  return best || options[0];
}

/**
 * 「抉择」：把每个分支的成本算出来，挑净收益最高的。
 *
 * 只认三种成本 / 收益，其余分支按「有没有实质内容」估：
 *   `damage → ownKing`   自己掉血，按 1 点血 ≈ 3.2 分扣
 *   `taxMana`            下回合少费用，1 费 ≈ 2.6 分
 *   `damage / destroy / control / draw / summon`  按收益加分
 *
 * 效果数据里没写数值的部分不猜（只给一个很小的正分），宁可低估也不要
 * 因为「看起来很大」而选错分支 —— 这一档在卡面数值上吃过亏。
 */
function optionBranchValue(state, actions, side, depth) {
  if (depth > 3) return 0;
  let v = 0;
  for (const a of actions || []) {
    switch (a.op) {
      case 'damage': {
        const amount = typeof a.amount === 'number' ? a.amount : 2;
        const kind = (a.target && a.target.kind) || '';
        if (kind === 'ownKing') v -= amount * 3.2;
        else if (kind === 'enemyKing') v += amount * 1.4 + (amount >= state.players[1 - side].kingHp ? 20 : 0);
        else if (kind === 'allEnemyUnits') v += amount * 1.1;
        else if (kind === 'allOwnUnits') v -= amount * 1.1;
        else v += amount * 0.9;
        break;
      }
      case 'destroy': v += 5.0; break;
      case 'control': v += 5.5; break;
      case 'draw': v += (typeof a.amount === 'number' ? a.amount : 1) * 2.2; break;
      case 'heal': v += (typeof a.amount === 'number' ? a.amount : 2) * 0.5; break;
      case 'summon': v += 2.6; break;
      case 'summonToHand': v += 1.6; break;
      case 'delayedSummon': v += 1.8; break;
      case 'taxMana': v -= (a.amount || 1) * 2.6; break;
      case 'sacrifice': v -= 3.5; break;
      case 'buffAtk':
      case 'buffMaxHp': v += (typeof a.amount === 'number' ? a.amount : 1) * 1.0; break;
      case 'grantKeyword':
      case 'grantKeywordBuff': v += 2.2; break;
      case 'chooseKeywords': v += 3.0; break;
      case 'freeze': v += 2.2; break;
      case 'spellLock': v += 2.0; break;
      case 'kingInvincible':
      case 'kingShield': v += 2.6; break;
      case 'kingDamageReduce': v += (a.amount || 1) * 0.8; break;
      case 'discard': v -= (a.amount || 1) * 1.2; break;
      case 'compound':
      case 'conditional': v += optionBranchValue(state, a.actions || a.then || [], side, depth + 1); break;
      default: v += 0.2; break;
    }
  }
  return v;
}

function chooseOptionAnswer(state, request) {
  const options = request.options || [];
  if (!options.length) return null;
  if (options.length === 1) return options[0];
  const side = request.side === 1 ? 1 : 0;
  // request.options 只带 {index,label}；分支内容在卡面数据里，按 label 反查。
  const cur = state.players[side] && state.players[side].currentSpell;
  const def = cur ? state.cardLib[cur] : null;
  const branches = [];
  const collect = (acts) => {
    for (const a of acts || []) {
      if (a.op === 'choose') branches.push(...(a.options || []));
      else if (a.op === 'compound' || a.op === 'conditional') collect(a.actions || a.then || a.else);
    }
  };
  if (def) collect(def.actions);
  let best = options[0];
  let bestScore = -Infinity;
  for (const o of options) {
    const br = branches.find((b) => (b.label || '') === o.label);
    const s = br ? optionBranchValue(state, br.actions || [], side, 0) : 0.3;
    if (s > bestScore) { best = o; bestScore = s; }
  }
  return best;
}

/**
 * 召唤落点：优先「对面这条线没有单位」的位置（下一回合白打脸），
 * 其次「对面这条线单位最弱」的位置；都差不多时落到左边那条（结果确定）。
 * label 形如「山地-前排」。
 */
function chooseSummonCellAnswer(state, request) {
  const options = request.options || [];
  if (!options.length) return null;
  if (options.length === 1) return options[0];
  const side = request.side === 1 ? 1 : 0;
  let best = null;
  let bestScore = -Infinity;
  // 同一路的两个身位里，前排先（能挡、也能打）
  const rowBias = (o) => (String(o.label || '').indexOf('前排') >= 0 ? 0.15 : 0);
  for (const o of options) {
    if (!o || !o.lane) continue;
    const openBonus = laneOpenFor(state, o.lane, side) ? 3.0 : 0;
    const s = openBonus - laneEnemyWeight(state, o.lane, side) * 0.5 + rowBias(o);
    if (s > bestScore) { best = o; bestScore = s; }
  }
  return best || options[0];
}

/**
 * 炼金原料：按组合表挑「能立刻凑出一张令牌」的那张。
 *
 * 它只决定「这一问拿哪张原料」，真正的组合匹配在 tryAlchemyBrew 里；
 * 这里多看一步能让原料堆往有解的方向掏（否则经常掏到凑不成对的那张）。
 */
function chooseRawMaterialAnswer(state, request) {
  const options = request.options || [];
  if (!options.length) return null;
  if (options.length === 1) return options[0];
  const side = request.side === 1 ? 1 : 0;
  const hand = (state.players[side] && state.players[side].hand) || [];
  const inHand = hand.map((c) => c.cardId);
  let best = options[0];
  let bestScore = -Infinity;
  for (const o of options) {
    // 手里已经有同一张 → 直接成对；否则按「这张原料在组合表里出现的次数」排
    let s = inHand.indexOf(o.cardId) >= 0 ? 3.0 : 0;
    const combos = (G.RAW_COMBOS && Object.keys(G.RAW_COMBOS)) || [];
    for (const key of combos) {
      if (key.split('+').indexOf(o.cardId) >= 0) s += 0.2;
    }
    if (s > bestScore) { best = o; bestScore = s; }
  }
  return best;
}

/**
 * 统一入口。遇到不认识的问题返回 `undefined` —— 这样引擎会退回它自己的
 * 兜底口径（`request.choose`，再不行取第一个），不会因为 AI 没见过某种提问就卡住。
 *
 * ⚠ **引擎自己挂了 `request.choose` 的提问，一律不抢**（2026-10-27 实测）：
 *   选敌方单位 / 敌方目标这两类的 `choose` 是 `pickFragileTarget` ——「能一刀杀
 *   就杀，否则打国王」，是作者按这套卡池调过的口径。拿「威胁值最大」去覆盖它
 *   是明确的负收益，配对同种子各 120 局：
 *     只开这两类 84.2% / 66.7%   只开其余五类 90.0% / 70.8%   全关 90.0% / 70.0%
 *   （打困难 / 打噩梦）—— 覆盖掉 `pickFragileTarget` 正是「学会用阵营反而变弱」
 *   的来源。阵营卡真正一片空白的地方是**下面这五类**：引擎对它们只会
 *   「取第一个选项」，没有任何策略可言。
 */
export function aiChoose(state, request) {
  if (!state || !request) return undefined;
  if (typeof request.choose === 'function') return undefined;
  switch (request.type) {
    case 'chooseUnit': return chooseUnitAnswer(state, request) || undefined;
    case 'chooseEnemyTarget': return chooseEnemyTargetAnswer(state, request) || undefined;
    case 'chooseLane': return chooseLaneAnswer(state, request) || undefined;
    case 'chooseHandCard': return chooseHandCardAnswer(state, request) || undefined;
    case 'chooseOption': return chooseOptionAnswer(state, request) || undefined;
    case 'summonCell': return chooseSummonCellAnswer(state, request) || undefined;
    case 'chooseRawMaterial': return chooseRawMaterialAnswer(state, request) || undefined;
    // `combatTarget` 由 request.choose → aiTargetPicker 那条路答，这里不抢。
    default: return undefined;
  }
}

/**
 * 只在这一次 AI 回合里把 aiChoose 装上（离开时原样还原）。
 *
 * ⚠ 形态：`state.chooser(request)` —— **只收一个参数**（见 replay.js 的 replayChooser，
 *   和 engine/src/choices.js 的 `state.chooser(request)`），state 得靠闭包带进来。
 *   写成 `state.chooser = aiChoose` 是不行的：那会把 request 当成 state 传进去，
 *   于是每一问都返回 undefined、静默退回引擎兜底，看起来「装上了」其实一次都没生效。
 *
 * ⚠ `aiRebind`：推演克隆（cloneForSim）要把这个 chooser 重新绑到**克隆体自己**身上，
 *   否则推演里每一问都拿真棋盘判。见 cloneForSim 的 `chooser` 分支。
 */
function bindAiChooser(state) {
  const fn = (request) => aiChoose(state, request);
  fn.aiRebind = (other) => bindAiChooser(other);
  return fn;
}
function withAiChooser(state, fn) {
  const had = Object.prototype.hasOwnProperty.call(state, 'chooser');
  const prev = state.chooser;
  // 让 takeChoice 把 chooser 的答案也记进裁定流水（见 engine/src/choices.js）。
  // 录制中的对局记账；推演克隆拿到的是自己那份临时数组，记了也无害。
  const hadRec = Object.prototype.hasOwnProperty.call(state, 'chooserRecords');
  const prevRec = state.chooserRecords;
  state.chooser = bindAiChooser(state);
  state.chooserRecords = true;
  try {
    return fn();
  } finally {
    if (had) state.chooser = prev;
    else delete state.chooser;
    if (hadRec) state.chooserRecords = prevRec;
    else delete state.chooserRecords;
  }
}


/**
 * AI 在自己的行动阶段连续出牌，直到没得打。
 *
 * @param {object} state
 * @param {number} side
 * @param {object} [opts]  { difficulty: 'easy'|'normal'|'hard'|'nightmare'|'impossible', maxPlays: 8 }
 * @returns {{ count:number, actions:Array<{iid:number, opts:object}> }}
 *   `actions` 是本阶段真正打出的每一张牌。回放录制需要它：把 AI 的每一步
 *   也照单记下来，重放时就不用再跑一遍 AI（既快，也不必依赖 AI 决策的稳定性）。
 */
/**
 * 炼金阵营的炼药：AI 自己找一组「能凑出令牌、且付得起」的原料。
 *
 * 返回这次真正消耗掉的 iid 列表（没炼就返回 null）。
 * 找不到组合、付不起、或引擎拒绝，都当作「这一步不做」AI 绝不能因为
 * 炼药抛错就卡死在自己的回合里。
 */
function tryAlchemyBrew(state, side) {
  const p = state.players[side];
  if (!p || p.faction !== 'alchemy') return null;
  const mats = p.hand
    .map((hc) => ({ hc, def: state.cardLib[hc.cardId] }))
    .filter((it) => it.def && it.def.rawMaterial);
  const n = mats.length;
  if (n < 2 || n > 12) return null;

  let best = null;
  for (let mask = 1; mask < (1 << n); mask++) {
    const picked = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) picked.push(mats[i]);
    if (picked.length < 2 || picked.length > 4) continue;
    const token = G.comboTokenFor(picked.map((it) => it.hc.cardId));
    if (!token) continue;
    let cost = 0;
    for (const it of picked) cost += G.costOf(state, it.hc);
    if (cost > p.mana) continue;
    const tdef = state.cardLib[token] || {};
    const score = (tdef.cost || 0) * 2 + ((tdef.actions || []).length);
    if (!best || score > best.score) best = { score, iids: picked.map((it) => it.hc.iid) };
  }
  if (!best) return null;
  try {
    G.brew(state, side, best.iids);
  } catch (err) {
    return null;
  }
  return best.iids;
}

// 
// 「不可能」：模拟前瞻（作者 2026-10：不加任何数值优势，只把棋算得更远）
// 

/**
 * 只写不读的流水账：推演全程**没有任何一处读它们**，所以克隆体给个空数组就够。
 *
 *   log        战报。board.js 的 M.log 只 push；唯一读它的是界面（game-flow.js
 *              的战斗可视化按 `state.log.length` 游标取新事件），推演根本不经过界面。
 *   choiceLog  裁定流水。choices.js 只 push；读它的是回放录制侧（replay.js 用自己
 *              那份 recording.choiceLog），推演里的 takeChoice 也不会去读。
 *
 * 为什么值得单独挑出来：它们是**只增不减**的，一局几百条，而且每一条都要递归深拷。
 * 实测（244 条日志的局面，2000 次克隆取平均）：cloneForSim 全量 0.192ms/次，
 * 跳过 log 后 0.049ms/次 —— log 一个人吃掉 77%。一次规划要克隆几十次
 * （每档每个候选一次），省下来的全是白给的时间预算。
 *
 * ⚠ 必须是**空数组**而不是共享引用：M.log 会 push，共享会把推演的假事件写进
 *   真对局的战报里，界面就会播出根本没发生的特效。
 */
const JOURNAL_KEYS = ['log', 'choiceLog'];

/**
 * 深拷贝一局，用来推演。四条纪律：
 *   1. `cardLib` / 函数（targetPicker 等）按引用共享  只读；拷了又慢又容易出微妙的错。
 *   2. `rng` 必须**另造**：engine/src/rng.js 的状态藏在闭包里，
 *      直接展开会把推演和真对局接到同一个随机源上，真对局的随机数会被推演吃掉。
 *   3. 克隆体设 `humanSide = -1` + `autoResolveChoices = true`：
 *      推演里所有「要问人」的请求都必须自动答，绝不能挂起。
 *   4. `JOURNAL_KEYS` 里的流水账只给空数组，见上面那段实测。
 */
function cloneForSim(state) {
  const c = {};
  for (const k of Object.keys(state)) {
    if (k === "cardLib" || k === "targetPicker") {
      c[k] = state[k];
    } else if (k === "chooser") {
      /**
       * ⚠ AI 自己那个 chooser 是**闭包绑死了真对局 state 的**，不能按引用共享。
       *
       * `withAiChooser` 装的是 `(request) => aiChoose(state, request)`；克隆体如果
       * 原样继承这个函数，推演里每一问都会拿**真棋盘**去判 —— 选出的是「真局面里
       * 该打谁」，却作用在推演的局面上。推演于是从第二步起就和现实分叉，
       * 规划器据此挑出来的牌自然也是错的（实测：开 smartChoices 后打「困难」
       * 从 95.8% 掉到 85.4%，配对同种子）。
       *
       * 认得出的就重新绑到克隆体自己身上；认不出的（回放播放器的 chooser 等）
       * 仍旧按引用共享 —— 它们读的是自己那份录制流水，不依赖 state 指针。
       */
      const fn = state[k];
      c[k] = (typeof fn === "function" && typeof fn.aiRebind === "function")
        ? fn.aiRebind(c)
        : fn;
    } else if (JOURNAL_KEYS.includes(k)) {
      c[k] = Array.isArray(state[k]) ? [] : state[k];
    } else if (k === "rng") {
      c[k] = createRng(state.rng ? state.rng.state : 0);
    } else if (k === "pending") {
      c[k] = state[k];           // 正常不会走到这里（推演只在空闲时开始）
    } else {
      c[k] = cloneValue(state[k]);
    }
  }
  c.humanSide = -1;
  c.autoResolveChoices = true;
  return c;
}

/** 通用深拷贝：函数与原始值原样共享，对象 / 数组逐层复制 */
function cloneValue(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) {
    const a = new Array(v.length);
    for (let i = 0; i < v.length; i++) a[i] = cloneValue(v[i]);
    return a;
  }
  const o = {};
  for (const k of Object.keys(v)) {
    const x = v[k];
    o[k] = typeof x === "function" ? x : cloneValue(x);
  }
  return o;
}

/** 单条线「对面没有阻挡」时，attSide 在这条线上能直接打到国王的攻击力 */
function laneFreeDamage(state, attSide, lane) {
  const row = state.board[lane] && state.board[lane].units;
  if (!row) return 0;
  const mine = row[attSide];
  const theirs = row[1 - attSide];
  if (!mine || !theirs) return 0;
  if (theirs.front || theirs.back) return 0;   // 对面有单位，不算白打脸
  let sum = 0;
  for (const u of [mine.front, mine.back]) {
    if (u && !u.removed) sum += effectiveAtk(state, u) || 0;
  }
  return sum;
}

/** 各条线「对面没有阻挡」时，attSide 能直接打到国王的攻击力合计 */
function freeLaneDamage(state, attSide) {
  let sum = 0;
  for (const lane of LANES) sum += laneFreeDamage(state, attSide, lane);
  return sum;
}

/**
 * 局面评估：从 side 的角度看，正数代表优势。
 * 权重可由难度表 / opts.params 注入（W），便于跑参数扫描。
 *
 * ⚠ 2026-10 实测记录：这一层**已经没有可调的余地了**，试过的都原样退回。
 *   拿「不可能」写死第 0 档打噩梦（n=120，种子 1-120，基线 45.8%）：
 *     · 把单位身材项反过来算（wAtk/wHpEval = -5）→ 17.5%
 *     · 国王血量差 / 手牌张数 / 两条「白打脸」项的权重**全部清零** → 45.8%（一个 pick 都没变）
 *     · 「白打脸」权重 ×3 → 45.8%；费用项清零 → 45.8%
 *     · 另加的三项（关键词折价 / 手牌费用和 / 斩杀项）逐项扫 0 / 1 / 2 / 40 → 45.8%~46.7%，全在噪声里
 *   身材项一动就崩、其它项怎么动都一样，说明**推演的分胜负信号已经压过评估函数的排序**：
 *   实测叶节点里 54.8% 已经是 ±1000 的终局（赢 263 / 输 571），剩下不到一半才轮到评估函数排。
 *   所以「让不可能更强」的关键不在评估函数，而在**什么时候不出牌**（见 aiTakeTurn 的留手判定）。
 */
function evalPosition(state, side, W) {
  W = W || {};
  const foe = 1 - side;
  if (state.winner === side) return 1000;
  if (state.winner === foe) return -1000;
  const mine = state.players[side];
  const theirs = state.players[foe];
  if (!mine || !theirs) return 0;

  let v = (mine.kingHp - theirs.kingHp) * (W.wKing === undefined ? 2.4 : W.wKing);
  v += ((mine.hand ? mine.hand.length : 0) - (theirs.hand ? theirs.hand.length : 0)) * (W.wHand === undefined ? 0.6 : W.wHand);
  v += ((mine.mana || 0) - (theirs.mana || 0)) * 0.3;

  for (const u of allUnits(state)) {
    if (u.removed) continue;
    const val = (effectiveAtk(state, u) || 0) * (W.wAtk === undefined ? 1.0 : W.wAtk)
      + (u.hp || 0) * (W.wHpEval === undefined ? 0.6 : W.wHpEval)
      + (u.row === "front" ? 0.8 : 0.2);
    v += u.side === side ? val : -val;
  }

  // 下个回合谁能直接打卡牌脸，权重最高  这是这套游戏真正的胜负来源
  v += freeLaneDamage(state, side) * (W.wFreeMine === undefined ? 1.0 : W.wFreeMine);
  v -= freeLaneDamage(state, foe) * (W.wFreeFoe === undefined ? 1.6 : W.wFreeFoe);

  // 「不可能」的信息优势：手牌不再只按**张数**算，而是按卡面估出来的**价值**算；
  // 双方**下一次各会抽到什么**也一并算进局面（牌库顶是双方共享的，它本来就该是已知信息）。
  if (insightOn(W) && W.insightEval !== false) {
    v += (handValue(state, side) - handValue(state, foe))
      * (W.wHandValue === undefined ? 0.5 : W.wHandValue);
    v += (cardHandValue(nextDrawCard(state, side)) - cardHandValue(nextDrawCard(state, foe)))
      * (W.wNextDraw === undefined ? 0.4 : W.wNextDraw);
  }
  return v;
}


/**
 * 「不可能」的推演档位：从最省的一档往上爬，越高越费算力。
 *
 * 档位是扫出来的（n=120，种子 1-120，见 README）：**只加广，不加深**。
 * 加深是负收益：K24/S32 只有 40.8%、K8/S36 也是 40.8%，K16/S28 45.8%，
 * 而同样 20 步只把 K 从 8 加到 12/16/20/24 是 49.2%/47.5%/48.3%/48.3%（都在噪声里）。
 * 推演越深，评估函数的那点偏差被放大得越厉害，所以步数锁在 20，档位只加候选数。
 */
const PLAN_LEVELS = [
  { k: 8, steps: 20 },    // 第 0 档 = 原来的定档
  { k: 12, steps: 20 },
  { k: 16, steps: 20 },
  { k: 20, steps: 20 },
  { k: 24, steps: 20 },   // 第 4 档：算力约 3 倍，预算管够时的默认
];

/** 在克隆体上从当前局面往下推 steps 步（含双方回合与开战结算） */
function simForward(clone, steps) {
  for (let n = 0; n < steps; n++) {
    if (clone.winner !== null) break;
    if (clone.pending) break;
    let actor = null;
    try { actor = G.getActor(clone); } catch (err) { break; }
    if (actor === null) {
      try { G.advance(clone); } catch (err) { break; }
      continue;
    }
    try {
      aiTakeTurn(clone, actor, { difficulty: "hard", maxPlays: 6 });
    } catch (err) { break; }
    try { G.advance(clone); } catch (err) { break; }
  }
}

/** 推演「打出这个候选」之后的局面分 */
function rolloutScore(state, side, cand, P) {
  const clone = cloneForSim(state);
  try {
    G.playCard(clone, side, cand.iid, cand.opts);
  } catch (err) {
    return -Infinity;
  }
  simForward(clone, P.planSteps || 8);
  return evalPosition(clone, side, P);
}

/** 推演「这一手先不出（留手）」之后的局面分 —— 与出牌候选用的是同一把尺子 */
function rolloutPassScore(state, side, P, steps) {
  const clone = cloneForSim(state);
  simForward(clone, steps);
  return evalPosition(clone, side, P);
}

/**
 * 用某一档把前 K 个候选各推演一遍，返回推演后局面最好的那一手（含它的推演分）。
 *
 * `cache`（可选）复用上一次**同一档步数**算出来的分数。爬档时前 8 个候选的分数
 * 与档位无关（PLAN_LEVELS 里步数一律 20），所以能原样搬过来：
 * 原来从第 0 档爬到第 4 档要 8 + 24 = 32 次推演，其中 8 次是纯重复；
 * 现在只要 24 次。推演分是确定性的（克隆自带 rng、决策无随机），复用的分数
 * 与重算逐位相同，所以「同分取贪心分更高那个」的 tie-break 语义不变。
 */
function rolloutAtLevel(state, side, candidates, P, lv, cache) {
  const k = Math.min(lv.k, candidates.length);
  const usable = cache && cache.steps === lv.steps ? cache : null;
  let best = candidates[0];
  let bestScore = -Infinity;
  for (let i = 0; i < k; i++) {
    const c = candidates[i];
    let s;
    if (usable && i < usable.scores.length) {
      s = usable.scores[i];
    } else {
      s = rolloutScore(state, side, c, { ...P, planSteps: lv.steps });
      if (usable) usable.scores[i] = s;
    }
    // 推演分相同时取贪心分更高的那个（保住原来「能打就打」的手感）
    if (s > bestScore + 1e-9) { bestScore = s; best = c; }
  }
  return { best, bestScore };
}

/**
 * 在贪心评分最高的前几个候选里，挑推演后局面最好的那个。
 *
 * 时间预算（作者 2026-10：可以接受几秒的延迟，让他算）：
 *   - `planBudgetMs` 是**一整个回合**最多花多少毫秒做推演（不是每张牌都算一遍），
 *     0 / 不填 = 只跑最省的一档；
 *   - 从最省的一档往上爬：先量出第一档要多久，再按「算力 ≈ K × 步数」预估下一档，
 *     装得进剩余预算就继续爬，装不进就停在上一档。手机上慢就自动少算，不会卡死；
 *   - `planLevel` 可以写死某一档（跑参数扫描用，结果可复现，不受机器快慢影响）。
 */
/** 测试钩子：上一次规划实际跑到了第几档（0 = 最省的一档） */
function notePlanLevel(idx) {
  try { if (typeof globalThis !== 'undefined') globalThis.__aiLastPlanLevel = idx; } catch (err) { /* 老环境没有 globalThis */ }
  return idx;
}

function planRollout(state, side, candidates, P) {
  if (P.planLevel !== undefined && P.planLevel !== null) {
    const idx = Math.max(0, Math.min(P.planLevel, PLAN_LEVELS.length - 1));
    notePlanLevel(idx);
    return { ...rolloutAtLevel(state, side, candidates, P, PLAN_LEVELS[idx]), level: idx };
  }
  const budget = Math.max(0, P.planBudgetMs || 0);
  const deadline = P.planDeadline || (budget > 0 ? Date.now() + budget : 0);
  if (!deadline) {
    notePlanLevel(0);
    return { ...rolloutAtLevel(state, side, candidates, P, PLAN_LEVELS[0]), level: 0 };
  }

  // 第一档既要出结果，也用来「量一下这台机器有多快」：算力大致与 K × 步数成正比，
  // 于是能按比例预估别的档要多久，再跳到「预算装得下的最贵那一档」——
  // 不再一档一档地爬（那样等于把每一档都算一遍，白白多花好几倍时间）。
  //
  // 第一档的分数存进 cache，爬档时只补算第 8..K-1 个候选（见 rolloutAtLevel）。
  // 第 0 档本身仍然只跑一遍，所以「量速度」和「出结果」两条都还成立。
  const t0 = Date.now();
  const cache = { steps: PLAN_LEVELS[0].steps, scores: [] };
  const base = rolloutAtLevel(state, side, candidates, P, PLAN_LEVELS[0], cache);
  const dt0 = Math.max(Date.now() - t0, 1);
  const unit0 = PLAN_LEVELS[0].k * PLAN_LEVELS[0].steps;
  let pick = 0;
  for (let i = 1; i < PLAN_LEVELS.length; i++) {
    const est = dt0 * (PLAN_LEVELS[i].k * PLAN_LEVELS[i].steps) / unit0;
    if (Date.now() + est > deadline) break;
    pick = i;
  }
  notePlanLevel(pick);
  if (pick === 0) return { ...base, level: 0 };
  return { ...rolloutAtLevel(state, side, candidates, P, PLAN_LEVELS[pick], cache), level: pick };
}

export function aiTakeTurn(state, side, opts = {}) {
  const difficulty = opts.difficulty || DEFAULT_DIFFICULTY;
  const maxPlays = opts.maxPlays || 8;
  // opts.params 允许临时覆盖参数，用于跑参数扫描（tools 里的实验脚本用）
  const P = opts.params
    ? { ...difficultyByKey(difficulty), ...opts.params }
    : difficultyByKey(difficulty);

  // 引擎中途反问的每一问（选目标 / 选线路 / 弃牌 / 抉择 / 召唤落点）交给 aiChoose。
  // 以前这里什么都没有，全靠引擎兜底的「取第一个选项」—— 阵营卡几乎全靠这些分支生效。
  // 只有表里写了 smartChoices 的那一档才装，别的档手感不变（见难度表的说明）。
  // 消融对照：params { chooser: null }。
  if (P.chooser === null || !P.smartChoices) return runAiTurn(state, side, P, maxPlays);
  return withAiChooser(state, () => runAiTurn(state, side, P, maxPlays));
}

function runAiTurn(state, side, P, maxPlays) {
  // 推演预算按**整个回合**算：一回合里可能连续做几次规划，它们共用同一个截止时间。
  // 这样「可以接受几秒延迟」变成的是「这一回合最多算几秒」，而不是每张牌都算几秒。
  const planDeadline = (P.planBudgetMs > 0) ? Date.now() + P.planBudgetMs : 0;
  const P2 = planDeadline ? { ...P, planDeadline } : P;

  let played = 0;
  const actions = [];

  let brews = 0;
  while (played < maxPlays) {
    // 炼金阵营的节奏是「先炼药、再打令牌」：能凑出组合就先把原料炼掉。
    // 一回合最多两次，免得把手牌耗空、也不会在炼药上打转。
    if (brews < 2) {
      const used = tryAlchemyBrew(state, side);
      if (used) {
        brews++;
        actions.push({ brew: used });
        continue;
      }
    }
    const plays = G.getLegalPlays(state, side);
    if (plays.length === 0) break;

    const candidates = [];
    for (const play of plays) {
      const def = state.cardLib[play.cardId];
      if (!def) continue;

      if (def.type === 'unit') {
        for (const place of play.places) {
          candidates.push({
            iid: play.iid,
            opts: { lane: place.lane, row: place.row },
            score: scoreUnitPlacement(state, side, def, place.lane, place.row, P),
          });
        }
      } else {
        if (P.noSpells) continue;         // 简单难度不会用锦囊
        const target = bestSpellTarget(state, side, def, P);
        if (target === undefined) continue; // 需要选线路，AI 跳过
        const o = !target
          ? {}
          : (target.king ? { targetKing: true } : { targetUid: target.uid });
        candidates.push({
          iid: play.iid,
          opts: o,
          score: scoreSpell(state, side, def, target, P),
        });
      }
    }

    if (candidates.length === 0) break;

    // 加一点随机，避免每局完全一样。
    // 难度越高噪声越小 —— 简单难度的臭棋就是从这里来的。
    if (P.jitter > 0) {
      for (const c of candidates) c.score += (state.rng.state % 100) / 1000 * P.jitter;
    }
    candidates.sort((a, b) => b.score - a.score);

    // 「不可能」：把前几个候选各自推演一遍（我打完 + 双方各一个回合），
    // 选结算后局面最好的那个，而不是只看眼前这一步的分数。
    const plan = P.planner === 'rollout' ? planRollout(state, side, candidates, P2) : null;
    const pick = plan ? plan.best : candidates[0];
    if (plan && P.rolloutPass) {
      // 由推演自己决定「打」还是「留手」：把「这一手都不出」也推演一遍，
      // 用同一把尺子和最优出牌比。passMargin 是留手的门槛（0 = 一样好就不打）。
      const passScore = rolloutPassScore(state, side, P2, PLAN_LEVELS[plan.level].steps);
      if (passScore > plan.bestScore + (P.passMargin || 0)) break;
    } else if (pick.score < P.passThreshold) {
      // 分数太低的牌就不打了，留住费用。阈值越高越消极。
      break;
    }

    try {
      G.playCard(state, side, pick.iid, pick.opts);
      played++;
      actions.push({ iid: pick.iid, opts: pick.opts });
    } catch (err) {
      break;
    }
  }
  return { count: played, actions };
}
