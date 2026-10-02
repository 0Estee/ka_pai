/** 临时探针 A：真实对局的动作流 vs 回放播放器的动作流，逐步对拍（重复直到失败）。 */
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

for (let attempt = 1; attempt <= 40; attempt++) {
  api.__newGame();
  api.__pause(true);
  const st0 = state();
  /**
   * 用**真实对局的口径**跑：`humanSide = 0`（真人是我方）、AI 侧的提问自动代答
   *（进 `state.choiceLog`）、我方出牌时由探针把 `autoResolveChoices` 关掉 ——
   * 这正是 `play-input.js:240` 干的事，于是我方那一问**真的挂起**、答案记成 `{k:'c'}`。
   *
   * ⚠ 不能调 `__resetRecording()`：它只存「当前剩下的牌库」，而重建方会从
   * 第 1 回合重新发牌 —— 两边发到手里的牌必然不同。验回放要从**这一局的起点**走。
   */
  st0.humanSide = 0;
  st0.autoResolveChoices = true;
  st0.chooser = undefined;
  api.__dbg = true;
  api.__liveDigests = [];
  st0.qTrace = [];
  api.__liveQTrace = st0.qTrace;
  let guard = 0;
  while (guard++ < 400) {
    const s = state();
    api.__snapLive();        // 记录条数没变就不覆盖，所以这里存的是「当前位置」的局面
    if (s.winner !== null) break;
    if (s.pending) {
      const opts = s.pending.request.options || [];
      const want = String(opts.length > 1 ? 1 : 0);
      // 与 play-input.js 的 resolvePlayerChoice 同一条路：
      // 答案会进录制（`{k:'c'}`）与答案流水（`type:'human'`），两边时序才一致
      api.__nav('choose-option', { idx: want, id: want });
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
        // 与 play-input.js 的 commitPlay 同一条路：出牌前关掉自动代答，
        // 出牌后若没留下挂起请求就恢复（留下了就等 pending 分支去答）。
        s.autoResolveChoices = false;
        if (d(hc).type === 'unit') api.commitPlay(hc.iid, { lane: slot.lane, row: slot.row });
        else api.commitPlay(hc.iid, { lane: slot.lane });
        if (!s.pending) s.autoResolveChoices = true;
        if (recLen() > before) { acted = true; break; }
      }
    }
    if (acted) continue;
    const before = recLen();
    api.__advance();
    if (recLen() === before) break;
  }

  const acts = api.__recordingActions() || [];
  api.__dbg = true;
  const v = api.__replayVerifyLive(api.__liveDigests);
  if (v.ok) { console.log(`#${attempt} 录制 ${acts.length} 条 → ok:true`); continue; }
  console.log(`#${attempt} 录制 ${acts.length} 条 → 分叉于 ${v.divergedAt}：${v.error}`);
  console.log('裁决流 live vs 回放:');
  const live = api.__liveQTrace || [];
  const rep = v.qTrace || [];
  for (let i = 0; i < Math.max(live.length, rep.length); i++) {
    if (live[i] !== rep[i]) console.log(`  ✗ [${i}] live=${live[i]} 回放=${rep[i]}`);
  }
  console.log(`  live(${live.length}): ${live.join(' ')}`);
  console.log(`  回放(${rep.length}): ${rep.join(' ')}`);
  console.log('动作流:', acts.map((a, i) => `${i}${a.k}${a.k !== 'a' ? JSON.stringify(a) : ''}`).join(' '));
  console.log(`REPLAY_ASK ${JSON.stringify(api.__log || [])}`);
  console.log(`choiceLog ${JSON.stringify(api.__recordingLog ? api.__recordingLog() : [])}`);
  console.log('nextIid 对照:');
  for (let i = 0; i <= acts.length; i++) {
    const d = api.__liveDigests[i];
    if (!d) continue;
    const mm = /n(\d+)\|/.exec(d);
      console.log(`[${i}] ${acts[i - 1] ? acts[i - 1].k : '-'} nextIid=${mm ? mm[1] : '?'} ${d.split('|')[1]} cards=${(/st(\d+)/.exec(d) || [])[1]}`);
  }
  continue;
}
