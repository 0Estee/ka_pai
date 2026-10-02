/** 临时探针：看清回放第一步为什么就分叉 */
import { api } from './checks/harness.mjs';

const state = () => api.__game();
const pickChoice = () => {
  const rq = state().pending && state().pending.request;
  const n = rq && rq.options ? rq.options.length : 0;
  if (n > 0) api.__nav('choose-option', { idx: n > 1 ? 1 : 0, id: String(n > 1 ? 1 : 0) });
  return n;
};

api.__newGameFirst();
api.__pause(true);
console.log('建局后: phase', state().phase, 'turn', state().turn, 'firstPlayer', state().firstPlayer,
  'auto', state().autoResolveChoices, 'humanSide', state().humanSide);

for (let i = 0; i < 6; i++) {
  const before = JSON.stringify(api.__recordingActions().slice(-1));
  try { api.__advance(); } catch (err) { console.log('推进失败', err.message); break; }
  while (state().pending) pickChoice();
  console.log(`advance #${i}: phase=${state().phase} turn=${state().turn} 新录 ${before} → ${JSON.stringify(api.__recordingActions().slice(-1))}`);
}

console.log('\n完整录制:');
api.__recordingActions().slice(0, 14).forEach((a, i) => console.log(' ', i, JSON.stringify(a)));
console.log('\n回放 trace:');
const v = api.__replayVerifyLive();
console.log(JSON.stringify(v.trace, null, 1));
console.log('live phase', state().phase, 'turn', state().turn);
