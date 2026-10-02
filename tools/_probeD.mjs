/** 临时探针 D：同一进程内重复 newGame，初始状态/推进是否确定性。 */
import { api } from './checks/harness.mjs';

const sig = (s) => [s.seed, s.firstPlayer, s.turn, s.phase, JSON.stringify(s.deck.slice(0, 8)), s.nextIid, s.rng && s.rng.state].join('|');

for (let rep = 0; rep < 3; rep++) {
  api.__newGame(777);
  api.__pause(true);
  const s0 = api.__game();
  console.log(`#${rep} init  `, sig(s0));
  for (let i = 0; i < 6; i++) api.__advance();
  console.log(`#${rep} after `, sig(api.__game()), 'actions=', (api.__recordingActions() || []).length);
}
