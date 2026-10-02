/** 临时探针：多个种子跑「真人全程出牌（含点选目标/抉择）」并锁步验回放 */
import { api } from './checks/harness.mjs';
const state = () => api.__game();
const LANES = ['mountain', 'plainL', 'plainR', 'water'];
const recLen = () => (api.__recordingActions() || []).length;

function legalSlots(s, cardId) {
  const d = s.cardLib[cardId];
  const kw = (d.keywords || []);
  const aquatic = kw.includes('aquatic');
  const amphib = kw.includes('amphibious') || kw.includes('nimble');
  const okLane = (l) => (aquatic ? l === 'water' : (amphib ? true : l !== 'water'));
  const out = [];
  for (const l of LANES) {
    if (!okLane(l)) continue;
    const side = s.board[l].units[0];
    for (const row of ['front', 'back']) if (!side[row]) out.push({ lane: l, row });
  }
  return out;
}

function playOneGame(seed, preferSecond) {
  api.__newGame(seed);
  api.__pause(true);
  let guard = 0; let choices = 0;
  while (guard++ < 400) {
    const s = state();
    if (s.winner !== null) break;
    if (s.pending) {
      const opts = s.pending.request.options || [];
      const idx = preferSecond && opts.length > 1 ? 1 : 0;
      choices++;
      api.__nav('choose-option', { idx, id: String(idx) });
      continue;
    }
    const mine = (s.phase === 'DEPLOY_FIRST' || s.phase === 'SPELL_FIRST') ? s.firstPlayer === 0 : s.firstPlayer === 1;
    const isMyPhase = mine && ['DEPLOY_FIRST', 'DEPLOY_SECOND', 'SPELL_FIRST', 'SPELL_SECOND'].includes(s.phase);
    let acted = false;
    if (isMyPhase) {
      const hand = s.players[0].hand;
      const d = (c) => s.cardLib[c.cardId];
      const aff = hand.filter((c) => d(c).cost <= s.players[0].mana);
      const pool = (s.phase === 'DEPLOY_FIRST' || s.phase === 'DEPLOY_SECOND')
        ? aff.filter((c) => d(c).type === 'unit') : aff.filter((c) => d(c).type === 'spell');
      for (const hc of pool) {
        if (s.phase.startsWith('SPELL') && JSON.stringify(d(hc).effects || []).includes('chosen')) continue;
        const slot = legalSlots(s, hc.cardId)[0] || { lane: 'mountain', row: 'front' };
        const before = recLen();
        if (d(hc).type === 'unit') api.commitPlay(hc.iid, { lane: slot.lane, row: slot.row });
        else api.commitPlay(hc.iid, { lane: slot.lane });
        if (recLen() > before) { acted = true; break; }
      }
    }
    if (acted) continue;
    const before = recLen();
    api.__advance();
    if (recLen() === before) break;
  }
  const acts = api.__recordingActions() || [];
  const v = api.__replayVerifyLive();
  return { seed, choices, total: acts.length, cRecords: acts.filter((a) => a.k === 'c').length, ok: v.ok, err: v.error, divergedAt: v.divergedAt };
}

let allOk = true;
for (const seed of [1, 12345, 777, 20240501, 999983]) {
  for (const preferSecond of [false, true]) {
    const r = playOneGame(seed, preferSecond);
    if (!r.ok) allOk = false;
    console.log(`${r.seed} 选第${preferSecond ? 2 : 1}项 | 录制 ${r.total} 条（其中选目标 ${r.cRecords} 条）| 抉择 ${r.choices} 次 | ${r.ok ? '✅ 回放一致' : `❌ ${r.err}`}`);
  }
}
console.log(allOk ? '全部一致' : '存在分叉');
