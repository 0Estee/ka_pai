/**
 * 金币、星尘与等级。
 *
 * **所有数值都集中在下面的表里，调平衡只改这个文件。**
 * 这个模块是纯函数（不碰 DOM、不碰存储），所以能直接被测试。
 *
 * ── 设计意图（给作者看的）────────────────────────────────
 *  金币：奖励「打赢」也奖励「打得漂亮」——赢是基础分，剩余国王血是表现分，
 *        速攻额外加分。输也有一点保底，避免连败后完全没有正反馈。
 *        余额上限 1000，超出的部分自动熔成星尘（10 金币 = 1 星尘）。
 *  星尘：强化工坊里「精通」要用的材料，只能靠对局奖励、金币熔炼获得。
 *  等级：**不再看金币**，看「表现分」（perf）——每局按胜负、剩余国王血、
 *        速攻、击杀数综合给分，所以花钱强化不会掉级，摆烂赢也升得慢。
 *        曲线仍是二次的，前期升得快、后期变慢。
 */

/** 初次进入游戏赠送的金币 */
export const INITIAL_GOLD = 100;

/** 初次进入游戏赠送的星尘（够试一次精通） */
export const INITIAL_DUST = 60;

/** 金币余额上限：超出的部分按 DUST_PER_GOLD 熔成星尘 */
export const GOLD_CAP = 1000;

/** 星尘余额上限 */
export const DUST_CAP = 500;

/** 多少金币熔 1 星尘（强化工坊里也按这个比例手动合成） */
export const DUST_PER_GOLD = 10;

/**
 * 对局基础奖励（金币）。
 * 输也有 5 金 —— 连败时的保底，不然玩家一点进度感都没有。
 */
const BASE_REWARD = { win: 30, draw: 15, lose: 5 };

/**
 * 对局星尘奖励。赢多输少，保证「打十局能精通一次」左右的节奏。
 */
const DUST_REWARD = { win: 8, draw: 5, lose: 3 };

/**
 * 模式系数（金币与星尘都乘）。联机是真人对决，赢得更多。
 */
const MODE_MULTIPLIER = { ai: 1.0, pvp: 2.0 };

/**
 * 联机（真人对决）的金币规则 —— **作者 2026-09 定的**：
 *
 *   · 联机对局**会影响本地金币**
 *   · 联机**没有保底**：输了真扣，所以余额会掉到 0 甚至负数
 *   · 余额 ≤ 0 时**不能和真人对决**（`canPlayPvp`），但**可以打 AI 赚回来**
 *
 * AI 对局完全不受影响：永远能打，永远是正收益（输了也有 5 金保底）。
 */
const PVP = {
  winBonus: 30,   // 赢：在基础奖励与表现分之外，再额外加这么多
  loseCost: 20,   // 输：扣这么多（**没有保底**，可以直接扣成负数）
};

/**
 * 能不能和真人对决。余额必须 **> 0**（归零或负数都不行）。
 * 打 AI 不受这个限制。
 */
export function canPlayPvp(profile) {
  return (Number(profile && profile.gold) || 0) > 0;
}

/**
 * 表现分（perf）—— **等级只由它决定**。
 *
 * 2026-10 改动：以前等级看「累计金币」，于是「攒钱不花」比「花钱强化」更划算，
 * 和强化玩法直接打架。现在每局按综合表现给分，钱随便花，等级照升。
 */
const PERF_POINTS = {
  win: 100,
  draw: 60,
  lose: 30,
  perKingHpLeft: 2,   // 胜利时每剩 1 点国王生命 +2
  kingHpCap: 40,      // 该项最多 +40（国王初始 16 血，实际封顶也就 32）
  fastWinTurns: 8,    // 胜利且回合数 ≤ 此值 → 速攻加分
  fastWinBonus: 40,
  perKill: 10,        // 每消灭 1 个敌方单位 +10
  killCap: 50,        // 该项最多 +50
  pvpMult: 1.5,       // 联机表现分再乘 1.5
};

/**
 * 升到第 `level` 级所需的**累计表现分**。
 * 二次曲线：升到 2 级要 200，3 级 450，4 级 750，5 级 1100……
 * 每级增量 +50，前期密集、后期拉长。
 */
export function perfForLevel(level) {
  const n = Math.max(0, level - 1);
  return 200 * n + 25 * n * (n - 1);
}

/** 反查：累计表现分对应几级 */
export function levelFor(perf) {
  const g = Math.max(0, Number(perf) || 0);
  let level = 1;
  // 上限只是防止传入异常大的数时死循环
  while (level < 999 && g >= perfForLevel(level + 1)) level++;
  return level;
}

/** 等级进度（给界面画进度条用） */
export function levelProgress(perf) {
  const g = Math.max(0, Number(perf) || 0);
  const level = levelFor(g);
  const cur = perfForLevel(level);
  const next = perfForLevel(level + 1);
  const span = Math.max(1, next - cur);
  const into = Math.min(span, Math.max(0, g - cur));
  return {
    level,
    perf: g,
    levelStart: cur,
    levelEnd: next,
    into,
    need: span,
    remain: Math.max(0, next - g),
    ratio: into / span,
    // 兼容旧界面：以前叫 lifetimeGold
    lifetimeGold: g,
  };
}

/**
 * 把金币超过上限的部分熔成星尘（就地返回新的余额，不改入参）。
 * @returns {{gold:number, dust:number, melted:number}}
 */
export function capGold(gold, dust) {
  let g = Math.max(0, Number(gold) || 0);
  let d = Math.max(0, Number(dust) || 0);
  let melted = 0;
  if (g > GOLD_CAP) {
    const over = g - GOLD_CAP;
    melted = Math.floor(over / DUST_PER_GOLD);
    g = GOLD_CAP + (over % DUST_PER_GOLD);
    d += melted;
  }
  if (d > DUST_CAP) d = DUST_CAP;
  return { gold: g, dust: d, melted };
}

/**
 * 算一局的金币奖励。
 *
 * @param {object} o
 * @param {number|'draw'} o.winner      引擎的 winner
 * @param {number} o.humanSide          玩家是 0 还是 1
 * @param {number} o.turn               结束时是第几回合
 * @param {number} o.humanKingHp        结束时玩家国王剩余生命
 * @param {number} [o.kills]            玩家消灭的敌方单位数
 * @param {string} [o.mode]             'ai' | 'pvp'
 * @returns {{ total:number, dust:number, perf:number, lines:string[] }}
 */
export function rewardFor({ winner, humanSide, turn, humanKingHp, kills = 0, mode = 'ai' }) {
  const isWin = winner === humanSide;
  const isDraw = winner === 'draw';
  const lines = [];
  const mult = MODE_MULTIPLIER[mode] ?? 1;

  // 表现分（每一局都给）：胜负基础 + 剩余国王血 + 速攻 + 击杀
  let perfAdd = 0;
  if (isWin) {
    const hpBonus = Math.min(PERF_POINTS.kingHpCap, Math.max(0, Number(humanKingHp) || 0) * PERF_POINTS.perKingHpLeft);
    if (hpBonus > 0) {
      perfAdd += hpBonus;
      lines.push(`剩余国王生命 ${humanKingHp} → +${hpBonus}`);
    }
    if (Number(turn) <= PERF_POINTS.fastWinTurns) {
      perfAdd += PERF_POINTS.fastWinBonus;
      lines.push(`第 ${turn} 回合内取胜 → +${PERF_POINTS.fastWinBonus}`);
    }
  }
  const killBonus = Math.min(PERF_POINTS.killCap, Math.max(0, Number(kills) || 0) * PERF_POINTS.perKill);
  if (killBonus > 0) {
    perfAdd += killBonus;
    lines.push(`消灭 ${kills} 个敌方单位 → +${killBonus}`);
  }

  // ── 金币与星尘：分模式
  let total = 0;
  let dust = 0;
  if (mode === 'pvp') {
    if (isDraw) {
      lines.push('联机平局：不奖不扣');
    } else if (!isWin) {
      total = -PVP.loseCost;
      lines.push(`联机战败 −${PVP.loseCost}`);
    } else {
      total = Math.round(BASE_REWARD.win * mult) + PVP.winBonus;
      dust = DUST_REWARD.win;
      lines.push(`联机胜利 +${BASE_REWARD.win} ×${mult} +${PVP.winBonus}`);
      lines.push(`星尘 +${dust}`);
    }
  } else {
    const base = isWin ? BASE_REWARD.win : (isDraw ? BASE_REWARD.draw : BASE_REWARD.lose);
    total = Math.round(base * mult);
    dust = isWin ? DUST_REWARD.win : (isDraw ? DUST_REWARD.draw : DUST_REWARD.lose);
    lines.push(`${isWin ? '胜利' : isDraw ? '平局' : '战败'}基础 +${base}`);
    lines.push(`星尘 +${dust}`);
  }

  // 表现分：胜负基础 + 表现加成，联机再乘系数
  let perf = isWin ? PERF_POINTS.win : (isDraw ? PERF_POINTS.draw : PERF_POINTS.lose);
  perf += perfAdd;
  if (mode === 'pvp') perf = Math.round(perf * PERF_POINTS.pvpMult);
  lines.push(`表现分 +${perf}`);

  return { total, dust, perf, lines };
}

/** 把一局结果应用到档案上（返回新的档案对象 + 本局结算明细） */
export function applyResult(profile, { winner, humanSide, turn, humanKingHp, kills = 0, mode = 'ai' }) {
  const base = profile || {};
  const r = rewardFor({ winner, humanSide, turn, humanKingHp, kills, mode });
  const before = levelFor(base.perf !== undefined ? base.perf : base.lifetimeGold);
  const rawGold = (Number(base.gold) || 0) + r.total;
  const capped = capGold(rawGold, (Number(base.dust) || 0) + r.dust);
  if (capped.melted > 0) r.lines.push(`金币超上限，熔炼 +${capped.melted} 星尘`);
  const next = {
    ...base,
    gold: capped.gold,
    dust: capped.dust,
    perf: Math.max(0, Number(base.perf !== undefined ? base.perf : base.lifetimeGold) || 0) + r.perf,
    lifetimeGold: (Number(base.lifetimeGold) || 0) + Math.max(0, r.total), // 仅存档兼容
    games: (Number(base.games) || 0) + 1,
    wins: (Number(base.wins) || 0) + (winner === humanSide ? 1 : 0),
    losses: (Number(base.losses) || 0) + (winner !== humanSide && winner !== 'draw' ? 1 : 0),
    draws: (Number(base.draws) || 0) + (winner === 'draw' ? 1 : 0),
  };
  const after = levelFor(next.perf);
  return { profile: next, reward: r, levelBefore: before, levelAfter: after, leveledUp: after > before };
}

/**
 * 用金币合成星尘（强化工坊的按钮）。
 * @returns {{ok:boolean, profile?:object, reason?:string, gained?:number}}
 */
export function buyDust(profile, times = 1) {
  const n = Math.max(1, Math.floor(Number(times) || 1));
  const cost = n * DUST_PER_GOLD;
  const p = profile || {};
  const gold = Number(p.gold) || 0;
  const dust = Number(p.dust) || 0;
  if (gold < cost) return { ok: false, reason: `金币不足（需要 ${cost}）` };
  if (dust >= DUST_CAP) return { ok: false, reason: `星尘已满（${DUST_CAP}）` };
  return {
    ok: true,
    gained: Math.min(n, DUST_CAP - dust),
    profile: { ...p, gold: gold - cost, dust: Math.min(DUST_CAP, dust + n) },
  };
}
