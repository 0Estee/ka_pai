/**
 * 对手 AI（启发式）与其 4 个难度。
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
 *   bonus        额外的开局优势（只有噩梦有）
 *
 * 关键行为：会补前排阻挡、会换掉能杀的敌人、会用锦囊解场或抽牌。
 * 随机 AI 完全不防守，会导致对局在 6 回合内崩掉，没法测玩法。
 */

import * as G from '../../engine/src/engine.js';
import { LANES, ROWS } from '../../engine/src/constants.js';
import { matchesTargetFilter } from '../../engine/src/keywords.js';
import { filterCtx, effectiveAtk } from '../../engine/src/auras.js';
// allUnits 直接用引擎的实现 —— 这里**不能**再自己写一份：
// 打包器把所有模块拼进同一个作用域，重名的函数会互相覆盖，
// 连 mechanics.js 内部的调用都会被顶掉。build-web.mjs 会拦截这种情况。
import { allUnits, drawCards } from '../../engine/src/mechanics.js';

/** 单位是否带某词条 */
const kw = (unit, id) => (unit.keywords || []).some((k) => k.id === id);
/** 取词条的数值参数 */
const kwX = (unit, id) => {
  const k = (unit.keywords || []).find((x) => x.id === id);
  return k ? k.x : 0;
};

// ══════════════════════════════════════════════════════════
// 难度表
// ══════════════════════════════════════════════════════════

/**
 * 四个难度。**调难度只改这张表。**
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
    //   唯一能真正拉开差距的是资源优势。所以「困难」= 普通级的决策 + **每回合多 1 费**，
    //   并且这条优势**写在难度选择界面上**，和噩梦一样不偷偷作弊。
    //   想让它退回「和普通同级」，把 bonus 改成 null 即可。
    passThreshold: -1.0,
    jitter: 0,
    lookahead: false,
    // 作者 2026-09：**不给加费**（最影响体感的就是这个），但手牌/国王血量可以给。
    // 实测：多给手牌对胜负几乎没有影响，多给费用才会明显变强 ——
    // 所以这里给的是「看着有优势、实际不压制玩家」的那一档。
    bonus: {
      hand: 1,            // 起手多 1 张
      kingHp: 4,          // 国王生命上限 +4
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
    // ⚠ 这是**唯一**给 AI 开大恩的难度，并且**会在选难度时明确写出来**，不偷偷作弊。
    //   实测：困难（每回合多 1 费）打普通 70%；噩梦在它基础上再多 1 费 + 起手多 1 张 + 国王 +4。
    // 同样**不加费**；在困难的基础上再多给手牌与国王血量。
    bonus: {
      hand: 2,            // 起手多 2 张
      kingHp: 8,          // 国王生命上限 +8
    },
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
        }
        break;
      }
      case 'destroy':
        score += 6.5;
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
      case 'extraAttack':
        // 相当于再打一次，价值接近一张伤害法术
        score += 2.8;
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

/**
 * AI 在自己的行动阶段连续出牌，直到没得打。
 *
 * @param {object} state
 * @param {number} side
 * @param {object} [opts]  { difficulty: 'easy'|'normal'|'hard'|'nightmare', maxPlays: 8 }
 * @returns {{ count:number, actions:Array<{iid:number, opts:object}> }}
 *   `actions` 是本阶段真正打出的每一张牌。回放录制需要它：把 AI 的每一步
 *   也照单记下来，重放时就不用再跑一遍 AI（既快，也不必依赖 AI 决策的稳定性）。
 */
export function aiTakeTurn(state, side, opts = {}) {
  const difficulty = typeof opts === 'string' ? opts : (opts.difficulty || DEFAULT_DIFFICULTY);
  const maxPlays = typeof opts === 'string' ? 8 : (opts.maxPlays || 8);
  // opts.params 允许临时覆盖参数，用于跑参数扫描（tools 里的实验脚本用）
  const P = opts.params
    ? { ...difficultyByKey(difficulty), ...opts.params }
    : difficultyByKey(difficulty);

  let played = 0;
  const seen = new Set();
  const actions = [];

  while (played < maxPlays) {
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

    const pick = candidates[0];
    // 分数太低的牌就不打了，留住费用。阈值越高越消极。
    if (pick.score < P.passThreshold) break;

    try {
      G.playCard(state, side, pick.iid, pick.opts);
      played++;
      actions.push({ iid: pick.iid, opts: pick.opts });
    } catch (err) {
      // 打不出去就把它记下来，避免死循环
      if (seen.has(pick.iid)) break;
      seen.add(pick.iid);
      break;
    }
  }
  return { count: played, actions };
}
