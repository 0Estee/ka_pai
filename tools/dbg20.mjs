
import { api, timers } from './checks/harness.mjs';
const pump = (r) => { for (let i = 0; i < r; i++) { const p = [...timers.entries()]; if (!p.length) return false; for (const [id, t] of p) { timers.delete(id); try { t.fn(); } catch (e) { console.log('timer err', e.message); } } } return true; };
const flush = () => new Promise((r) => setImmediate(r));
for (const id of [...timers.keys()]) timers.delete(id);
api.__go('home');
api.__newGameFirst();
api.__pause(true);
const st = api.__game();
st.humanSide = 0;
api.__place(0, 'U396', 'mountain', 'front');
api.__place(1, 'U242', 'mountain', 'front');
const foe = st.players[1]; foe.hand.length = 0; foe.mana = 0; foe.manaCap = 0;
st.phase = 'SPELL_FIRST';
api.__go('game');
api.__pause(false);
api.__nav('end', {});
let sawPending = false, trail = [];
for (let i = 0; i < 200; i++) {
  trail.push(st.phase + (st.pending ? '*P' : '') + '/' + (api.__view().busy ? 'B' : '-'));
  if (st.pending) { sawPending = true; break; }
  if (st.winner !== null) break;
  pump(1); await flush();
}
console.log('sawPending=', sawPending, 'trail=', trail.slice(0, 24).join(' '), '| total', trail.length);
if (st.pending) console.log('request=', st.pending.request.type, 'autoResolve=', st.autoResolveChoices);
