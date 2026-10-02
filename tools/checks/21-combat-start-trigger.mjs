/** 开战前异能：狙击手「自己线上的战斗开始前:造成2点伤害」（作者口径） */
import { api, check } from './harness.mjs';

console.log('\n 开战前异能：狙击手先打 2 点');

/**
 * 摆一个狙击手对靶子的场面，推进到开战。
 *
 * 注意：enterPhase('COMBAT') 会**同步**把这一路的开战结算完（除非中途挂起问人），
 * 所以跑到 phase === 'COMBAT' 时战斗已经打完了  断言只能看日志，
 * 不能去比对「推进前后的血量」（推进前读到的是已经打完的血量）。
 */
function scenario(sniperSide) {
  api.__go('home');
  api.__newGame();
  api.__pause(true);
  const foeSide = 1 - sniperSide;
  api.__place(sniperSide, 'U287', 'mountain', 'front');   // 狙击手 4 费 3/3
  api.__place(foeSide, 'W04', 'mountain', 'front');       // 白板巨兽 6 血靶子
  let n = 0;
  while (api.__game().phase !== 'COMBAT' && n++ < 14) api.__advance();
  const log = api.__game().log;
  const laneCombat = log.findIndex((e) => e.type === 'lane-combat' && e.lane === 'mountain');
  const dmg = log.findIndex((e) => e.type === 'damage' && e.lane === 'mountain' && e.side === foeSide);
  const first = dmg >= 0 ? log[dmg] : null;
  api.__pause(false);
  return { dmg, laneCombat, amount: first && first.amount, hpAfter: first && first.hp, cardId: first && first.cardId };
}

check('狙击手：自己线上的战斗开始前先造成 2 点伤害（我方侧）', () => {
  const r = scenario(0);
  if (!r.amount) throw new Error('开战日志里没有这条线路的伤害：' + JSON.stringify(r));
  if (r.amount !== 2) throw new Error('「战斗开始前」那一下应当是 2 点，实际 ' + r.amount);
  if (r.hpAfter !== 4) throw new Error('这 2 点应当打在 6 血靶子上（打完剩 4），实际剩 ' + r.hpAfter);
  if (!(r.dmg >= 0 && r.dmg < r.laneCombat)) {
    throw new Error('这 2 点没有发生在 lane-combat 之前（dmg@' + r.dmg + '，lane-combat@' + r.laneCombat + '）');
  }
});

check('狙击手：AI 那一侧同样在开战前打 2 点（两侧都要守）', () => {
  const r = scenario(1);
  if (!r.amount || r.amount !== 2 || r.hpAfter !== 4 || !(r.dmg >= 0 && r.dmg < r.laneCombat)) {
    throw new Error('AI 侧狙击手没在开战前打出 2 点：' + JSON.stringify(r));
  }
});