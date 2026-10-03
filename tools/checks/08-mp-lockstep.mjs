/** § 联机：锁步一致性（整个设计成立的前提） */
import { api, check } from './harness.mjs';

console.log('\n§ 联机：锁步一致性（整个设计成立的前提）');

check('一局的真实操作序列喂给两个引擎，全程保持一致', () => {
  // 直接拿上面录制下来的真实对局操作流，灌进两个全新的引擎。
  // 这正是联机在做的事：只传操作，两端各跑一遍。
  const rec = api.__replays()[0];
  if (!rec || !rec.actions.length) throw new Error('没有可用的操作序列');

  const r = api.__mp.lockstepCheck(rec.seed, rec.firstPlayer, rec.deck, rec.actions, rec.bonuses || [], rec.factions || []);
  if (!r.ok) throw new Error(`第 ${r.divergedAt} 步开始不一致（共 ${r.steps} 步）` + (r.error ? `  错误：${r.error}` : ''));
  if (r.winnerA !== rec.winner || r.winnerB !== rec.winner) {
    throw new Error(`重放终局对不上：录的是 ${rec.winner}，两个引擎跑出 ${r.winnerA}/${r.winnerB}`);
  }
  if (r.hashA !== r.hashB) throw new Error('终局指纹不同');
});

check('状态指纹对相同状态稳定、对不同状态敏感', () => {
  const a = api.__game();
  const h1 = api.__mp.stateHash(a);
  const h2 = api.__mp.stateHash(a);
  if (h1 !== h2) throw new Error('同一状态两次哈希不同，说明算进了易变字段');
  const before = a.players[0].kingHp;
  a.players[0].kingHp = before - 1;
  const h3 = api.__mp.stateHash(a);
  a.players[0].kingHp = before;
  if (h3 === h1) throw new Error('国王掉血后哈希没变，指纹不够敏感');
});
