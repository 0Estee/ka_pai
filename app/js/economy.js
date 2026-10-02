/**
 * 金币与等级。
 *
 * **所有数值都集中在下面的表里，调平衡只改这个文件。**
 * 这个模块是纯函数（不碰 DOM、不碰存储），所以能直接被测试。
 *
 * ── 设计意图（给作者看的）────────────────────────────────
 *  金币：奖励「打赢」也奖励「打得漂亮」——赢是基础分，剩余国王血是表现分，
 *        速攻额外加分。输也有一点保底，避免连败后完全没有正反馈。
 *  等级：看的是**累计获得过的金币**（不是余额），所以以后开了商店花钱
 *        也不会掉级。曲线是二次的，前期升得快、后期变慢。
 */

/** 初次进入游戏赠送的金币 */
export const INITIAL_GOLD = 100;

/**
 * 对局基础奖励。
 * 输也有 5 金 —— 连败时的保底，不然玩家一点进度感都没有。
 */
export const BASE_REWARD = { win: 30, draw: 15, lose: 5 };

/**
 * 模式系数。联机是真人对决，赢得更多。
 */
export const MODE_MULTIPLIER = { ai: 1.0, pvp: 2.0 };

/**
 * 联机（真人对决）的金币规则 —— **作者 2026-09 定的**：
 *
 *   · 联机对局**会影响本地金币**
 *   · 联机**没有保底**：输了真扣，所以余额会掉到 0 甚至负数
 *   · 余额 ≤ 0 时**不能和真人对决**（`canPlayPvp`），但**可以打 AI 赚回来**
 *
 * AI 对局完全不受影响：永远能打，永远是正收益（输了也有 5 金保底）。
 *
 * ⚠️ 这两个数是**我按现有经济曲线取的**，作者可以随便改：
 *   联机赢一局约 +110~150，输一局 −20，大约「赢一局能输五到七局」。
 */
export const PVP = {
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

/** 表现加分 */
export const PERF = {
  perKingHpLeft: 1,   // 胜利时每剩 1 点国王生命 +1（最多 +20）
  fastWinTurns: 8,    // 胜利且回合数 ≤ 此值 → 速攻加分
  fastWinBonus: 10,
};

/**
 * 升到第 `level` 级所需的**累计金币**。
 * 二次曲线：升到 2 级要 200，3 级 450，4 级 750，5 级 1100……
 * 每级增量 +50，前期密集、后期拉长。
 */
export function goldForLevel(level) {
  const n = Math.max(0, level - 1);
  return 200 * n + 25 * n * (n - 1);
}

/** 反查：累计金币对应几级 */
export function levelFor(lifetimeGold) {
  const g = Math.max(0, Number(lifetimeGold) || 0);
  let level = 1;
  // 上限只是防止传入异常大的数时死循环
  while (level < 999 && g >= goldForLevel(level + 1)) level++;
  return level;
}

/** 等级进度（给界面画进度条用） */
export function levelProgress(lifetimeGold) {
  const g = Math.max(0, Number(lifetimeGold) || 0);
  const level = levelFor(g);
  const cur = goldForLevel(level);
  const next = goldForLevel(level + 1);
  const span = Math.max(1, next - cur);
  const into = Math.min(span, Math.max(0, g - cur));
  return {
    level,
    lifetimeGold: g,
    levelStart: cur,
    levelEnd: next,
    into,
    need: span,
    remain: Math.max(0, next - g),
    ratio: into / span,
  };
}

/**
 * 算一局的金币奖励。
 *
 * @param {object} o
 * @param {number|'draw'} o.winner      引擎的 winner
 * @param {number} o.humanSide          玩家是 0 还是 1
 * @param {number} o.turn               结束时是第几回合
 * @param {number} o.humanKingHp        结束时玩家国王剩余生命
 * @param {string} [o.mode]             'ai' | 'pvp'
 * @returns {{ total:number, base:number, perf:number, mult:number, lines:string[] }}
 */
export function rewardFor({ winner, humanSide, turn, humanKingHp, mode = 'ai' }) {
  const isWin = winner === humanSide;
  const isDraw = winner === 'draw';

  // ── 联机（真人对决）：**没有保底**
  //   赢了才谈奖励；输了真扣；平局不奖不扣。
  //   所以余额会掉到 0 甚至负数 —— 这之后只能去打 AI 赚回来（见 canPlayPvp）。
  if (mode === 'pvp') {
    if (isDraw) {
      return { total: 0, base: 0, perf: 0, mult: 1, lines: ['联机平局：不奖不扣'] };
    }
    if (!isWin) {
      return { total: -PVP.loseCost, base: 0, perf: 0, mult: 1, lines: [`联机战败 −${PVP.loseCost}`] };
    }
  }

  const base = isWin ? BASE_REWARD.win : (isDraw ? BASE_REWARD.draw : BASE_REWARD.lose);
  const lines = [`${isWin ? '胜利' : isDraw ? '平局' : '战败'}基础 +${base}`];

  let perf = 0;
  if (isWin) {
    const hpBonus = Math.max(0, Number(humanKingHp) || 0) * PERF.perKingHpLeft;
    if (hpBonus > 0) {
      perf += hpBonus;
      lines.push(`剩余国王生命 ${humanKingHp} → +${hpBonus}`);
    }
    if (Number(turn) <= PERF.fastWinTurns) {
      perf += PERF.fastWinBonus;
      lines.push(`第 ${turn} 回合内取胜 → +${PERF.fastWinBonus}`);
    }
  }

  const mult = MODE_MULTIPLIER[mode] ?? 1;
  let total = Math.round((base + perf) * mult);
  if (mult !== 1) lines.push(`模式系数 ×${mult}`);

  // 联机赢了再额外加一笔（输了在上面已经直接返回了）
  if (mode === 'pvp' && isWin) {
    total += PVP.winBonus;
    lines.push(`联机胜利 +${PVP.winBonus}`);
  }

  return { total, base, perf, mult, lines };
}

/** 把一局结果应用到档案上（返回新的档案对象 + 本局结算明细） */
export function applyResult(profile, { winner, humanSide, turn, humanKingHp, mode = 'ai' }) {
  const r = rewardFor({ winner, humanSide, turn, humanKingHp, mode });
  const next = {
    ...profile,
    gold: (Number(profile.gold) || 0) + r.total,
    lifetimeGold: (Number(profile.lifetimeGold) || 0) + r.total,
    games: (Number(profile.games) || 0) + 1,
    wins: (Number(profile.wins) || 0) + (winner === humanSide ? 1 : 0),
    losses: (Number(profile.losses) || 0) + (winner !== humanSide && winner !== 'draw' ? 1 : 0),
    draws: (Number(profile.draws) || 0) + (winner === 'draw' ? 1 : 0),
  };
  const before = levelFor(profile.lifetimeGold);
  const after = levelFor(next.lifetimeGold);
  return { profile: next, reward: r, levelBefore: before, levelAfter: after, leveledUp: after > before };
}

/** 胜率（没有对局时返回 null，界面显示「—」） */
export function winRate(profile) {
  const games = Number(profile.games) || 0;
  if (games <= 0) return null;
  return (Number(profile.wins) || 0) / games;
}
