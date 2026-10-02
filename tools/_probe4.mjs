/** 临时探针：让「歼-10」落到我方手里（对方先抽走就重开局），真实推进后打出+抉择，再验回放 */
import { api } from './checks/harness.mjs';
const state = () => api.__game();
const pick = (idx) => api.__nav('choose-option', { idx, id: String(idx) });

let attempts = 0;
let found = false;
do {
  attempts++;
  api.__newGameFirst();
  api.__pause(true);
  const s = state();
  if (s.players[1].hand.some((c) => c.cardId === 'U393')) continue;   // 被对方抽走了，重开
  s.deck = ['U393'];                                                 // 只留一张 → 下次一定归我方
  api.__resetRecording();
  found = true;
} while (!found && attempts < 40);
console.log('重开次数', attempts, '牌库', JSON.stringify(state().deck));

let guard = 0;
while (guard++ < 300) {
  const s = state();
  if (s.winner !== null) break;
  if (s.pending) { pick(0); continue; }
  const myDeploy = (s.phase === 'DEPLOY_FIRST' && s.firstPlayer === 0)
    || (s.phase === 'DEPLOY_SECOND' && s.firstPlayer === 1);
  const hc = s.players[0].hand.find((c) => c.cardId === 'U393');
  if (myDeploy && hc) {
    console.log(`打出歼-10 @ turn ${s.turn} phase ${s.phase} mana ${s.players[0].mana} iid ${hc.iid}`);
    api.commitPlay(hc.iid, { lane: 'mountain', row: 'front' });
    console.log('打出后 pending', state().pending ? state().pending.request.type : null);
    if (state().pending) {
      console.log('选项', JSON.stringify(state().pending.request.options.map((o) => o.label)));
      pick(1);
    }
    const u = state().board.mountain.units[0].front;
    console.log('抉择后 场上', u ? `${u.name} ${u.atk}⚔${u.hp}♥ 词条 ${JSON.stringify((u.keywords || []).map((k) => k.id))}` : '(无)',
      'mana', state().players[0].mana);
    for (let k = 0; k < 8; k++) { api.__advance(); while (state().pending) pick(0); }
    break;
  }
  api.__advance();
}

console.log('录制条数', api.__recordingActions().length);
console.log('录制尾巴', JSON.stringify(api.__recordingActions().slice(-4)));
const v = api.__replayVerifyLive();
console.log('回放:', JSON.stringify(v, null, 1));
