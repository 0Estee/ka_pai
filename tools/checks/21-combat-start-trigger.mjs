/** 开战前异能：狙击手「开战时:造成2点伤害（选择一个目标）」（作者 2026-10 改口径，裁决 D71） */
import { api, check } from './harness.mjs';

console.log('\n 开战前异能：狙击手「开战时」先打 2 点');

/**
 * 摆一个「狙击手 + 靶子」的场面，推进到开战。
 *
 * 两个要点：
 *   - enterPhase(COMBAT) 会**同步**跑这一整条开战链；狙击手在真人那一侧时，
 *     他这一问会挂起等人（D71 的 askHuman），所以推进用 while + 上限。
 *   - 断言只能看日志（state.log）与挂起请求，不能比对推进前后的血量。
 *
 * @param {number} sniperSide 狙击手在哪一侧（0 = 真人侧，1 = AI 侧）
 * @param {boolean} twoFoes 是否在别条线路再多摆一个靶子（验「只打选中的那一个」）
 */
function setup(sniperSide, twoFoes) {
  api.__go('home');
  api.__newGame();
  api.__pause(true);
  const foeSide = 1 - sniperSide;
  api.__place(sniperSide, 'U287', 'mountain', 'front');         // 狙击手 4 费 3/3
  const foe = api.__place(foeSide, 'W04', 'mountain', 'front'); // 白板巨兽 6 血靶子
  const other = twoFoes ? api.__place(foeSide, 'W04', 'plainL', 'front') : null;
  let n = 0;
  while (api.__game().phase !== 'COMBAT' && n++ < 14) api.__advance();
  return { foeSide, foe, other, st: api.__game() };
}

check('狙击手（真人侧）：开战时挂起点选，2 点落在选中的目标上、且早于 lane-combat', () => {
  const { foe, other, st } = setup(0, true);
  const req = st.pending && st.pending.request;
  if (!req) throw new Error('狙击手在真人那一侧应当挂起问「打谁」，实际没有挂起：' + JSON.stringify({ phase: st.phase, pending: st.pending }));
  if (req.type !== 'chooseEnemyTarget') throw new Error('挂起的请求类型应当是 chooseEnemyTarget，实际 ' + req.type);
  if (req.noAuto !== true) throw new Error('真人侧的请求必须带 noAuto: true，否则会被引擎「取第一个选项」静默代答');
  const uids = req.options.map((o) => o.uid).filter((u) => u !== undefined);
  if (!uids.includes(foe.uid)) throw new Error('选项里应当有本线路的敌人 uid=' + foe.uid + '，实际 ' + JSON.stringify(uids));
  if (!uids.includes(other.uid)) throw new Error('选项里应当有别的线路的敌人 uid=' + other.uid + '（口径是「任意一个敌方单位」）');
  if (!req.options.some((o) => o.king === true)) throw new Error('选项里应当有敌方国王（沿用 D16 口径），实际 ' + JSON.stringify(req.options));
  if (st.log.some((e) => e.type === 'lane-combat' && e.lane === 'mountain')) throw new Error('还没点选就把山地那条线结算完了：挂起必须发生在开战结算之前');
  const idx = req.options.findIndex((o) => o.uid === other.uid);
  api.__resolveChoice(idx);
  const log = api.__game().log;
  const idxDmg = log.findIndex((e) => e.type === 'damage' && e.uid === other.uid && e.lane === 'plainL');
  const idxLane = log.findIndex((e) => e.type === 'lane-combat' && e.lane === 'mountain');
  if (idxDmg < 0) throw new Error('选中的那个目标没有吃到这 2 点伤害：' + JSON.stringify(log.map((e) => e.type)));
  if (log[idxDmg].amount !== 2) throw new Error('这一下应当是 2 点，实际 ' + log[idxDmg].amount);
  if (log[idxDmg].hp !== 4) throw new Error('6 血靶子挨完 2 点应当剩 4，实际剩 ' + log[idxDmg].hp);
  if (!(idxLane >= 0)) throw new Error('答完之后剩下的开战结算没有继续跑（没有 lane-combat 日志）：挂起恢复后没接回结算链');
  if (!(idxDmg < idxLane)) throw new Error('这 2 点发生在 lane-combat 之后（dmg@' + idxDmg + '，lane-combat@' + idxLane + '）；口径是开战结算之前先打');
  if (log.some((e) => e.type === 'damage' && e.lane === 'mountain' && e.amount === 2)) throw new Error('没被选中的那条线路也挨了 2 点：口径是只打选中的那一个目标');
  api.__pause(false);
});

check('狙击手（AI 侧）：不挂起，同样在 lane-combat 之前打 2 点（两侧都要守）', () => {
  const { foe, st } = setup(1, false);
  if (st.pending) throw new Error('AI 侧不该挂起等人：' + JSON.stringify(st.pending.request));
  const log = st.log;
  const idxDmg = log.findIndex((e) => e.type === 'damage' && e.uid === foe.uid && e.lane === 'mountain');
  const idxLane = log.findIndex((e) => e.type === 'lane-combat' && e.lane === 'mountain');
  if (idxDmg < 0) throw new Error('AI 侧狙击手没有打出这 2 点：' + JSON.stringify(log));
  if (log[idxDmg].amount !== 2 || log[idxDmg].hp !== 4) throw new Error('这 2 点没打在 6 血靶子上（剩 4）：' + JSON.stringify(log[idxDmg]));
  if (!(idxDmg < idxLane)) throw new Error('AI 侧这 2 点没有发生在 lane-combat 之前（dmg@' + idxDmg + '，lane-combat@' + idxLane + '）');
  api.__pause(false);
});
