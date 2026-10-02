/**  回放：真人点选 / 抉择 的问答必须精确重演 */
import { api, check } from './harness.mjs';

console.log('\n 回放：真人点选/抉择的问答');

/**
 * 这一节专门守「出牌带选择的卡牌回放会错」那一类 bug。它由**三个独立的坑**叠成，
 * 每个坑都曾让回放在中途报「有挂起的交互请求，但没法回答」：
 *
 *    回放播放器的游标**先 flushPending、后 index++** —— 于是它拿
 *      `record.actions[index]` 找答案时，读到的还是**刚应用的那条记录本身**
 *      （`{k:'p'}` / `{k:'a'}`），而不是紧随其后的 `{k:'c'}`。
 *      带 `choose` 的请求被引擎按自己的策略答掉（真人点的目标丢失）；
 *      不带 `choose` 的直接报错。种子 111 覆盖。
 *    一局可能「**终局已定、却还挂着一个没答的提问**」而结束：玩家看到的是结算
 *      画面，那一问再没人答，于是录制里最后一条就是出牌。这份录制是忠实的，
 *      回放必须同样收尾，不能报错。种子 207 覆盖。
 *    `state.chooser`（回放的驱动器）必须排在 `noAuto` **之前**，否则 `noAuto`
 *      的提问会绕过它、**不消耗 `choiceLog` 的那一条** → 游标从此错位，
 *      之后每一问都读到**别人的**条目，把本该引擎代答的误判成「挂起等人」。
 *      种子 111 覆盖（其后紧跟一个引擎代答的 chooseHandCard，正是被错位吃掉的那问）。
 *      （`holdHang` 还会往回放那份 `choiceLog` 追加条目，把它自己写脏。）
 *
 * 另一条**口径**说明：`__replayVerifyLive` 是「一条记录 = 一步」逐条对拍指纹，
 * 所以回放也必须每条记录走一步，不能一次 next() 吃掉两条。
 */

const LANES = ['mountain', 'plainL', 'plainR', 'water'];

/**
 * 把这一局的种子钉死。
 *
 * `newGame()` 里种子 = `Date.now() ^ Math.floor(Math.random() * 0xffffffff)`，
 * 而 harness 的沙箱直接用的是宿主 `Math` / `Date`（见 harness.mjs）——
 * 临时打桩这两个就能造出确定的种子。**只在建局那一瞬打桩**、随即还原：
 * 回放重建只认录制里的 `seed` / `opening`，不再需要随机数。
 */
function newGameWithSeed(seed) {
  const realRandom = api.Math.random;
  const realNow = api.Date.now;
  api.Math.random = () => (seed + 0.5) / 0x100000000;
  api.Date.now = () => 0;
  try {
    return api.__newGame();
  } finally {
    api.Math.random = realRandom;
    api.Date.now = realNow;
  }
}

/** 我方（0 号）能放下这张牌的空位。只看地形，够这一节用了 */
function legalSlots(s, cardId) {
  const d = s.cardLib[cardId];
  const kw = d.keywords || [];
  const aquatic = kw.includes('aquatic');
  const amphib = kw.includes('amphibious') || kw.includes('nimble');
  const out = [];
  for (const lane of LANES) {
    if (aquatic ? lane !== 'water' : (amphib ? false : lane === 'water')) continue;
    const side = s.board[lane].units[0];
    for (const row of ['front', 'back']) if (!side[row]) out.push({ lane, row });
  }
  return out;
}

/**
 * 用**真人玩家**的口径跑完一局，逐步留下指纹，最后校验回放。
 *
 * 出牌走 `commitPlay`（与 play-input.js 同一条路）；被反问就点面板
 * （`__nav('choose-option')` → `resolvePlayerChoice` → 记成 `{k:'c'}`）。
 */
function playAsHuman(seed) {
  newGameWithSeed(seed);
  api.__pause(true);
  const st = api.__game();
  st.humanSide = 0;
  st.autoResolveChoices = true;
  st.chooser = undefined;
  api.__liveDigests = [];   // ⚠必须每局清空：recAction 只在空槽位里存指纹

  let guard = 0;
  while (guard++ < 800) {
    const s = api.__game();
    api.__snapLive();
    if (s.winner !== null) break;
    if (s.pending) {
      const n = (s.pending.request.options || []).length;
      // 有第 2 项就选第 2 项：能抓到「被静默代答成第一个选项」那类错
      const pick = String(n > 1 ? 1 : 0);
      if (n > 0) api.__nav('choose-option', { idx: pick, id: pick });
      continue;
    }
    const mine = (s.phase === 'DEPLOY_FIRST' || s.phase === 'SPELL_FIRST')
      ? s.firstPlayer === 0 : s.firstPlayer === 1;
    let acted = false;
    if (mine && ['DEPLOY_FIRST', 'DEPLOY_SECOND', 'SPELL_FIRST', 'SPELL_SECOND'].includes(s.phase)) {
      const deploy = s.phase === 'DEPLOY_FIRST' || s.phase === 'DEPLOY_SECOND';
      for (const hc of s.players[0].hand) {
        const def = s.cardLib[hc.cardId];
        if (!def || def.cost > s.players[0].mana) continue;
        if (deploy !== (def.type === 'unit')) continue;
        // 需要预选目标的锦囊跳过（真实界面会先点目标）：本节要测的是
        // 「被反问时答得对不对」，靠单位异能 / 开战结算 / 未预选目标的出牌自然触发
        if (!deploy && JSON.stringify(def.effects || []).includes('chosen')) continue;
        const slot = legalSlots(s, hc.cardId)[0];
        if (!slot) continue;
        const before = api.__recordingActions().length;
        s.autoResolveChoices = false;   // 与 play-input.js 的 commitPlay 保持一致
        api.commitPlay(hc.iid, { lane: slot.lane, row: slot.row });
        if (!s.pending) s.autoResolveChoices = true;
        if (api.__recordingActions().length > before) { acted = true; break; }
      }
    }
    if (acted) continue;
    const before = api.__recordingActions().length;
    api.__advance();
    if (api.__recordingActions().length === before) break;
  }

  const s = api.__game();
  const acts = api.__recordingActions() || [];
  const v = api.__replayVerifyLive(api.__liveDigests);
  return {
    seed,
    v,
    answers: acts.filter((a) => a.k === 'c').length,
    endedWithPending: !!(s.pending && s.winner !== null),
  };
}

/**
 * 这三个种子各自守什么（缺一条就少守一个坑，别随手改）：
 *   2   —— 普通一局：真人被反问若干次并答掉（走 `{k:'c'}` 那条路）
 *   111 —— 确定性复现  与 ：`noAuto` 的 combatTarget 之后紧跟一个引擎代答的
 *         chooseHandCard（修复前必卡在第 43 步）
 *   207 —— 确定性复现 ：终局已定、却还挂着一个没答的提问
 */
/**
 * ⚠先把难度**钉死**再开局：前面的  会把难度改成「困难」（02-screen-nav.mjs），
 * 而难度会改 AI 的出牌（困难每回合多 1 费）→ 同一个种子会走出**不同的对局**，
 * 下面「哪个种子守哪个坑」那几条断言就不成立了（踩过一次）。
 */
const difficultyBefore = api.__settings().difficulty;
api.setDifficulty('normal');

const SEEDS = [2, 111, 207];
const played = SEEDS.map((sd) => playAsHuman(sd));

for (const r of played) {
  check(`回放（种子 ${r.seed}）：真人点选/抉择过的一局能逐步精确重演`, () => {
    if (r.v.error) throw new Error(r.v.error);
    if (r.v.divergedAt) throw new Error(`第 ${r.v.divergedAt} 步指纹分叉`);
    if (!r.v.ok) throw new Error(`回放没走完：${r.v.played}/${r.v.total}`);
  });
}

check('回放：这批对局确实经过了「真人答问」（否则这一节是空跑）', () => {
  const total = played.reduce((a, r) => a + r.answers, 0);
  if (total < 1) throw new Error("一个 {k:'c'} 都没录到  这节没测到真人答问，种子该换了");
});

check('回放：这批对局确实经过了「终局已定还挂着提问」（否则少守一个坑）', () => {
  if (!played.some((r) => r.endedWithPending)) {
    throw new Error('没有一局是「终局已定 + 还挂着提问」结束的  种子该换了（试试 207）');
  }
});

// 还回去：难度原样还原，并留一个干净局面给后面的检查
api.setDifficulty(difficultyBefore);
api.__go('home');
api.__newGame();
