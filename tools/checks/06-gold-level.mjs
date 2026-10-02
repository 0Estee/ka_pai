/** § 金币与等级 */
import { api, sandbox, check } from './harness.mjs';
import { N } from './05-integrated-game.mjs';

console.log('\n§ 金币与等级');

check(`${N} 局之后金币增加，且累加值与胜场对得上`, () => {
  const p = api.__profile();
  if (p.games !== N) throw new Error(`应记录 ${N} 局，实际 ${p.games}`);
  if (p.wins + p.losses + p.draws !== N) throw new Error('胜负平数量加起来不等于总局数');
  if (p.lifetimeGold <= 0) throw new Error('打了这么多局累计金币却是 0');
  if (p.gold !== 100 + p.lifetimeGold) {
    throw new Error(`金币(${p.gold}) 应等于 初始100 + 累计(${p.lifetimeGold}) —— 说明有局没结算或重复结算`);
  }
});

check('每局至少拿到保底金币（输也有 5）', () => {
  const p = api.__profile();
  if (p.lifetimeGold < p.games * 5) {
    throw new Error(`${p.games} 局至少应有 ${p.games * 5} 金币，实际 ${p.lifetimeGold}`);
  }
});

check('金币写进了 localStorage（不是只存在内存里）', () => {
  const raw = sandbox.localStorage.getItem('kapai.profile.v1');
  if (!raw) throw new Error('存档 key 不存在，进度不会持久化');
  const parsed = JSON.parse(raw);
  if (parsed.gold !== api.__profile().gold) throw new Error('写盘的金币与内存里的不一致');
});
