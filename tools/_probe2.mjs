/** 临时探针：用真实阶段推进跑一局，途中让「玩家」出带点选 / 抉择的牌，最后验回放 */
import { api } from './checks/harness.mjs';

const state = () => api.__game();
const isSpellPhase = (p) => p === 'SPELL_FIRST' || p === 'SPELL_SECOND';

function pickChoice() {
  // 走界面那条路答掉挂起请求（和玩家点面板一模一样）
  const rq = state().pending && state().pending.request;
  const n = rq && rq.options ? rq.options.length : 0;
  if (n > 0) api.__nav('choose-option', { idx: n > 1 ? 1 : 0, id: String(n > 1 ? 1 : 0) });
  return n;
}

api.__newGameFirst();
api.__pause(true);

const played = [];
const choices = [];
let guard = 0;
while (state().winner === null && guard++ < 400 && state().turn <= 8) {
  const s = state();
  if (s.pending) { choices.push(pickChoice()); continue; }
  const phase = s.phase;
  const actor = phase === 'DEPLOY_FIRST' || phase === 'SPELL_FIRST' ? 0
    : (phase === 'DEPLOY_SECOND' || phase === 'SPELL_SECOND' ? 1 : null);

  if (actor === 0 && isSpellPhase(phase)) {
    // 玩家出牌：优先挑「需要点选目标」的锦囊，其次挑「带抉择」的单位
    const hand = s.players[0].hand;
    const lib = s.cardLib;
    let target = null;
    for (const hc of hand) {
      const d = lib[hc.cardId];
      if (!d) continue;
      const needsTarget = (d.actions || []).some((a) => a.target
        && ['chosenEnemyUnit', 'chosenOwnUnit', 'chosenEnemyTarget', 'chosenEnemyFront'].includes(a.target.kind));
      if (needsTarget && d.cost <= s.players[0].mana) { target = { hc, d, opt: 'target' }; break; }
    }
    if (!target) {
      for (const hc of hand) {
        const d = lib[hc.cardId];
        if (!d) continue;
        const hasChoose = (d.effects || []).some((e) => (e.actions || []).some((a) => a.op === 'choose'));
        if (hasChoose && d.cost <= s.players[0].mana) { target = { hc, d, opt: 'none' }; break; }
      }
    }
    if (target) {
      const { hc, d, opt } = target;
      if (opt === 'target') {
        // 找合法目标：先尝试敌方单位 → 敌方国王 → 己方单位
        const foeUnits = [];
        for (const lane of Object.keys(s.board)) {
          for (const row of ['front', 'back']) {
            const u = s.board[lane].units[1][row];
            if (u) foeUnits.push(u);
          }
        }
        const ownUnits = [];
        for (const lane of Object.keys(s.board)) {
          for (const row of ['front', 'back']) {
            const u = s.board[lane].units[0][row];
            if (u) ownUnits.push(u);
          }
        }
        const cand = [foeUnits[0] && { targetUid: foeUnits[0].uid },
          { targetKing: true },
          ownUnits[0] && { targetUid: ownUnits[0].uid }].filter(Boolean);
        let ok = false;
        for (const o of cand) {
          try { api.commitPlay(hc.iid, o); ok = true; played.push(`${d.name}(${JSON.stringify(o)})`); break; } catch { /* 换一个目标 */ }
        }
        if (!ok) {
          // 打不出去就跳过这张
          s.players[0].hand = s.players[0].hand.filter((c) => c.iid !== hc.iid);
        }
      } else {
        try { api.commitPlay(hc.iid, { lane: 'mountain', row: 'front' }); played.push(d.name); } catch { /* 打不出去 */ }
      }
      while (state().pending) choices.push(pickChoice());
      continue;
    }
  }
  // 其他情况：走真实推进
  try { api.__advance(); } catch (err) { console.log('  推进失败:', err.message); break; }
  while (state().pending) choices.push(pickChoice());
}

console.log('出过的牌:', JSON.stringify(played));
console.log('答过的抉择次数:', JSON.stringify(choices));
const s2 = state();
console.log('终局: winner', s2.winner, 'turn', s2.turn, 'phase', s2.phase);
console.log('录制条数:', api.__recordingActions().length);
const v = api.__replayVerifyLive();
console.log('回放校验:', JSON.stringify({ total: v.total, played: v.played, divergedAt: v.divergedAt, error: v.error, ok: v.ok }));
if (v.divergedAt) console.log('trace:', JSON.stringify(v.trace));
