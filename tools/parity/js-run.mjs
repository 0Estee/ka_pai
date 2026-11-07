/**
 * JS 端对拍数据生成器（移植对拍用）
 *
 * 干什么：
 *   用**固定种子 + 固定牌库**把一局 JS 引擎打完，把每一步的「动作」和
 *   「状态摘要（digest）」写成 JSON。Godot 侧的 godot/tests/parity.gd 读这份
 *   JSON，用同样的牌库重放同样的动作，逐步比对 digest —— 两边摘要逐行相等，
 *   才说明 5489 行 GDScript 移植与 JS 原版**规则等价**。
 *
 * 为什么用「动作序列」而不是「同种子各自随机」：
 *   两个实现的搜索/排序细节可能不同，随机会在第一步就分叉，分叉后比什么都没意义。
 *   把「JS 决定了打哪张、放哪格」写进 JSON，Godot 只负责重放 + 比对状态，
 *   一旦某步摘要不一致，就能指到具体是哪一步、哪一行不同。
 *
 * 摘要格式（两边必须逐字符一致，见 godot/tests/parity.gd 的 _digest）：
 *   T{turn} F{phase} A{actor}
 *   P0 K{hp}/{max} M{mana}/{cap} H{手牌数} SP{超能力数}
 *   P1 ...
 *   DK{牌库数} DS{弃牌数} CP{已打牌数} PD{挂起类型}
 *   H0 {手牌 id 顺序}
 *   H1 {手牌 id 顺序}
 *   D3 {牌库顶 3 张}
 *   R {rng 状态}
 *   B {每条线 每方 每排：cardId atk/hp}
 * 数字一律两位小数。
 *
 * 用法：
 *   node tools/parity/js-run.mjs                # 默认 12 个种子
 *   node tools/parity/js-run.mjs --seed 1001 --deck 80 --factions demon,god
 *   node tools/parity/js-run.mjs --out godot/data/parity
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import * as G from '../../engine/src/engine.js';
import { LANES, ROWS } from '../../engine/src/constants.js';
import { TEST_CARD_LIB, buildTestDeck } from '../../engine/cards/test-cards.js';

const ROOT = path.resolve(url.fileURLToPath(new URL('../..', import.meta.url)));

/** 两位小数（-0 归零，避免 "-0.00" 与 "0.00" 的假分歧） */
export function s2(v) {
  const n = Math.round((Number(v) || 0) * 100) / 100;
  return (Object.is(n, -0) ? 0 : n).toFixed(2);
}

/** 状态摘要：一行一个维度，方便逐行 diff 定位 */
export function digest(state) {
  const P = state.players;
  const out = [];
  const actor = state.phase ? G.getActor(state) : null;
  out.push('T' + state.turn + ' F' + (state.phase || '-') + ' A' + (actor === null || actor === undefined ? '-' : actor));
  for (const side of [0, 1]) {
    const p = P[side];
    out.push('P' + side + ' K' + s2(p.kingHp) + '/' + s2(p.kingMaxHp)
      + ' M' + s2(p.mana) + '/' + s2(p.manaCap)
      + ' H' + p.hand.length + ' SP' + (p.superpowers || []).length);
  }
  out.push('DK' + state.deck.length + ' DS' + state.discard.length
    + ' CP' + state.stats.cardsPlayed
    + ' PD' + (state.pending ? ((state.pending.request && state.pending.request.type) || '?') : '-'));
  for (const side of [0, 1]) {
    out.push('H' + side + ' ' + P[side].hand.map((h) => h.cardId).join(','));
  }
  out.push('D3 ' + state.deck.slice(0, 3).join(','));
  out.push('R ' + (state.rng && state.rng.state));
  const cells = [];
  for (const lane of LANES) {
    for (const side of [0, 1]) {
      for (const row of ROWS) {
        const u = state.board[lane].units[side][row];
        cells.push(lane + ':' + side + ':' + row + '=' + (u
          ? u.cardId + ' ' + s2(u.atk) + '/' + s2(u.hp)
          : '-'));
      }
    }
  }
  out.push('B ' + cells.join(' '));
  return out.join('\n');
}

/** 跑一局，返回 { cfg, steps: [{ a, side, cardId, lane, row, ok, digest }] } */
export function runOne({ seed, firstPlayer = 0, deckSize = 80, factions = [], maxSteps = 3000 }) {
  const deck = buildTestDeck(deckSize, seed);
  const state = G.createGame({
    seed, firstPlayer, deck, cardLib: TEST_CARD_LIB, factions,
  });
  state.autoResolveChoices = true;
  state.humanSide = -1;
  G.startGame(state);

  const steps = [{ a: 'init', digest: digest(state) }];
  let n = 0;
  while (!G.isOver(state) && n < maxSteps) {
    n++;
    const actor = G.getActor(state);
    if (actor === null || actor === undefined) {
      G.advance(state);
      steps.push({ a: 'advance', digest: digest(state) });
      continue;
    }
    const plays = G.getLegalPlays(state, actor);
    if (!plays || plays.length === 0) {
      G.advance(state);
      steps.push({ a: 'advance', digest: digest(state) });
      continue;
    }
    const pick = plays[(seed + n) % plays.length];
    const opts = {};
    const places = pick.places || [];
    if (places.length && places[0]) {
      opts.lane = places[0].lane;
      opts.row = places[0].row;
    }
    const hc = state.players[actor].hand.find((h) => h.iid === pick.iid);
    const ok = G.playCard(state, actor, pick.iid, opts);
    steps.push({
      a: 'play', side: actor, cardId: hc ? hc.cardId : null,
      lane: opts.lane || null, row: opts.row || null, ok: !!ok,
      digest: digest(state),
    });
  }
  console.log('  seed=' + seed + ' 步数=' + n + ' 终局=' + (G.isOver(state) ? '是' : '否')
    + ' 胜者=' + state.winner + ' 国王=' + s2(state.players[0].kingHp) + '/' + s2(state.players[1].kingHp)
    + ' 原因=' + state.winReason);
  return {
    cfg: { seed, firstPlayer, deck, factions },
    over: G.isOver(state),
    steps,
  };
}

// ── CLI ──────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const outDir = path.resolve(ROOT, arg('out', 'godot/data/parity'));
  const deckSize = Number(arg('deck', 80));
  const seedsArg = arg('seed', '');
  const factionsArg = arg('factions', '');

  const FACTION_PAIRS = [
    ['demon', 'god'], ['sword', 'music'], ['science', 'divine'],
    ['alchemy', 'inferno'], ['frost', 'sin'], ['party', 'flame'],
    [null, 'heart'], [null, null],
  ];
  let seeds;
  if (seedsArg) seeds = [Number(seedsArg)];
  else seeds = [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011, 1012];

  fs.mkdirSync(outDir, { recursive: true });
  const index = [];
  console.log('[parity] 写出到 ' + outDir);
  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i];
    let factions;
    if (factionsArg) factions = factionsArg.split(',').map((s) => (s === '-' || s === '' ? null : s));
    else factions = FACTION_PAIRS[i % FACTION_PAIRS.length];
    const run = runOne({ seed, firstPlayer: i % 2, deckSize, factions });
    const file = 'js-seed' + seed + '.json';
    fs.writeFileSync(path.join(outDir, file), JSON.stringify(run), 'utf8');
    index.push({ file, seed, firstPlayer: i % 2, deckSize, factions });
  }
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
  console.log('[parity] 完成 ' + seeds.length + ' 局');
}

// 作为脚本被 node 直接跑（本文件不会被 Godot 侧 import，直接执行即可）
main();
