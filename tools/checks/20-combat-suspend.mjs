/** 开战挂起：强化士兵选完目标之后，回合必须能继续走（作者报过的卡死） */
import { api, check, timers } from './harness.mjs';

console.log(' 开战挂起：选完攻击目标不能卡死');

/** 集成测试里的计时器是桩、不会自己触发，这里手动一条条执行 */
function pumpTimers(rounds) {
  for (let i = 0; i < rounds; i++) {
    const pending = [...timers.entries()];
    if (!pending.length) return false;
    for (const [id, t] of pending) {
      timers.delete(id);
      try { t.fn(); } catch { /* 别的定时器抛错不影响这条断言 */ }
    }
  }
  return true;
}

/** 让微任务链（tick 自动推进用的是 Promise）有机会跑完 */
const flush = () => new Promise((r) => setImmediate(r));

/** 推进一格：先放一个定时器，再把微任务放干净 */
async function stepOnce() {
  pumpTimers(1);
  await flush();
}

/** 四条线上各格是谁（诊断用） */
function laneDump(st) {
  const out = {};
  for (const lane of ['mountain', 'plainL', 'plainR', 'water']) {
    out[lane] = st.board[lane].units.map((slot) => ['front', 'back'].map((row) => (slot[row] ? slot[row].side + ':' + (slot[row].cardId || slot[row].name) : '-')).join('/')).join(' | ');
  }
  return { turn: st.turn, phase: st.phase, lanes: out };
}

/** 棋盘上某一格的单位（诊断用） */
function cellOf(st, side, row) {
  const slot = st.board.mountain.units[side];
  const u = slot && slot[row];
  if (!u) return null;
  const def = u.def || u.card || {};
  return { uid: u.uid, id: def.id || u.cardId, name: u.name || def.name, side: u.side, hp: u.hp, keys: Object.keys(u).join(',') };
}

/**
 * 用真实回合循环（__nav('end') -> tick 的定时器链）跑到开战挂起，
 * 记录每一步「阶段 / 回合 / 特效是否还在播」，然后回答那一问。
 *
 * 必须先把场景摆好再断言：一旦摆牌失败（__place 返回 null），开战就不会有人提问，
 * 表现成「挂起没出现」，很容易误判成引擎坏了；所以诊断信息里带上摆牌结果。
 */
async function scenarioOnce() {
  let swapped = false;
  // harness 的 timers 是全局共享的，前面各分组留下的定时器桩没人清；
  // pumpTimers() 会把它们一起跑掉，那些回调属于别的场景，
  // 会在本组刚摆好的局面上乱推、甚至把 state 换掉（表现为挂起没出现）。
  // 所以开工前先清空，只跑本组自己排的定时器。
  for (const id of [...timers.keys()]) timers.delete(id);
  api.__go('home');
  api.__newGameFirst();
  api.__pause(true);
  const st = api.__game();
  st.humanSide = 0;                              // 真人这一侧：强化士兵开战时只问真人
  const placed = [
    api.__place(0, 'U396', 'mountain', 'front'), // 强化士兵：开战要指定攻击目标
    api.__place(1, 'U242', 'mountain', 'front'), // 拳击手：靶子
  ];
  const stage = {
    firstPlayer: st.firstPlayer,
    humanSide: st.humanSide,
    placed,
    mine: cellOf(st, 0, 'front'),
    foe: cellOf(st, 1, 'front'),
  };
  if (!placed[0] || !placed[1]) return { ok: false, why: '摆牌失败（__place 返回 null）', stage };
  /*
   *  把 AI 的手牌与费用清空再进锦囊阶段。
   *   这里只要「把棋摆好、走到开战」这一个场面，可 AI 的锦囊阶段是**真实出牌**的：
   *   曾有一局它打出「回旋龙卷风」，把 强化士兵 弹回了手牌，
   *   于是开战那条线上只剩靶子、根本没人提问  表现为「挂起没出现」，非常像引擎坏了。
   */
  const foe = st.players[1];
  foe.hand.length = 0;
  foe.mana = 0;
  foe.manaCap = 0;
  st.phase = st.firstPlayer === 0 ? 'SPELL_FIRST' : 'SPELL_SECOND';
  api.__go('game');
  api.__pause(false);
  api.__nav('end', {});                          // 走真实路由结束阶段 -> 开战

  const samples = [];
  const boardTrail = [];
  let sawPending = false;
  for (let i = 0; i < 200; i++) {
    if (api.__game() !== st) { swapped = true; break; }
    const fxs = api.__fx();
    samples.push({ phase: st.phase, turn: st.turn, busy: !!fxs.fx || !!(fxs.fxQueue && fxs.fxQueue.length) });
    if (st.pending) { sawPending = true; break; }
    if (boardTrail.length < 3 && st.phase === 'COMBAT') boardTrail.push(laneDump(st));
    if (st.winner !== null) break;
    await stepOnce();
  }
  if (!sawPending) {
    return {
      ok: false,
      why: '开战挂起没有出现（强化士兵根本没问「要打谁」）',
      stage,
      swapped,
      samples: samples.slice(-4),
      first: samples.slice(0, 4), timersLeft: timers.size, screen: api.__screen(),
      live: (() => { const l = api.__game(); return { same: l === st, phase: l.phase, turn: l.turn, logLen: l.log.length, pending: !!l.pending, cursor: api.__fx().fxCursor }; })(),
      boards: boardTrail,
      tail: st.log.slice(-40),
    };
  }

  const jumped = samples.find((s) => s.busy && s.turn > 1);
  const pendingPhase = st.phase;
  const req = st.pending.request;
  const atHang = { same: api.__game() === st, livePhase: api.__game().phase, livePending: !!(api.__game() && api.__game().pending), logLen: st.log.length, timers: timers.size };
  api.__nav('choose-option', { idx: 0 });
  const afterAnswer = { same: api.__game() === st, livePhase: api.__game().phase, livePending: !!(api.__game() && api.__game().pending), logLen: st.log.length, timers: timers.size };        // 回答「要打谁」
  for (let i = 0; i < 200; i++) {
    if (api.__game() !== st) { swapped = true; break; }
    if (!st.pending && st.phase !== pendingPhase) break;
    await stepOnce();
  }
  return {
    ok: st.pending === null && st.phase !== 'COMBAT',
    why: st.pending === null
      ? '回答之后还停在 COMBAT（这就是作者看到的卡死）'
      : '选完目标仍然挂着 pending',
    stage,
    pendingType: req && req.type,
    atHang, afterAnswer,
    swapped: swapped || !atHang.same,
    jumped,
    final: { phase: st.phase, turn: st.turn },
  };
}

let run = await scenarioOnce();
// module 22 (spell banner) runs concurrently while this top-level await is
// pending, and its own __newGame() swaps the shared app state -- then st goes
// stale. Retry when that swap was observed; the other module only swaps once.
for (let attempt = 0; attempt < 3 && run.swapped; attempt++) {
  console.log("  retry scenario (state was swapped by another check): attempt " + (attempt + 2));
  run = await scenarioOnce();
}

check('强化士兵在开战回合选完攻击目标之后，回合能继续推进（不卡死）', () => {
  if (!run.ok) throw new Error(run.why + ' | 现场：' + JSON.stringify(run));
  if (run.pendingType !== 'combatTarget') throw new Error('挂起的提问不是 combatTarget，而是 ' + run.pendingType);
});

check('开战演出没播完之前不会进入下一回合（作者 2026-10 口径）', () => {
  if (!run.ok) throw new Error('前置场景没跑通：' + run.why + ' | 现场：' + JSON.stringify(run.stage || run.final));
  if (run.jumped) throw new Error('特效还在播的时候回合就推进了：' + JSON.stringify(run.jumped));
});