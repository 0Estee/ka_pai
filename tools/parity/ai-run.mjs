/**
 * AI 对拍（JS 侧）：用 app/js/ai.js 的 AI 把整局打完，逐步记下状态摘要。
 *
 * 为什么需要：godot/tests/ai.gd 只能证明「AI 能把一局下完、高档位赢低档位」，
 * 证明不了「移植后每一步决策还是原来那一步」。评分权重抄错一个系数、
 * 候选排序少一层、bonus 加错边，都会照样下完，只是变蠢 —— 胜率看不出来。
 *
 * 做法：同一个种子 + 同一副牌库 + 双方都是 AI，把每一步的摘要写成 JSON；
 * godot/tests/ai-parity.gd 用 GDScript 版 AI 跑同一局，逐步比对摘要。
 * 全部一致 ⇒ 决策序列相同，移植保真。
 *
 * ⚠️ 不含 impossible 档：那一档用 Date.now() 做推演预算，
 *    跑两遍耗时不同、选出的手也会不同（设计如此，不是移植问题）。
 *
 * 用法：
 *   node tools/parity/ai-run.mjs                 # 默认 6 局写进 godot/data/parity/
 */
import path from 'node:path';
import fs from 'node:fs';
import url from 'node:url';

import * as G from '../../engine/src/engine.js';
import { TEST_CARD_LIB, buildTestDeck } from '../../engine/cards/test-cards.js';
import {
  aiTakeTurn, applyDifficultyBonus, installAiTargetPicker,
} from '../../app/js/ai.js';
import { digest } from './js-run.mjs';

const ROOT = path.resolve(url.fileURLToPath(new URL('../..', import.meta.url)));
const OUT_DIR = path.join(ROOT, 'godot', 'data', 'parity');

/** 跑一局 AI 对 AI，返回 { cfg, steps: [{a, side, difficulty, digest}], over, winner } */
export function runAiGame({ seed, key0 = 'normal', key1 = 'normal', deckSize = 80, maxSteps = 900 }) {
  const deck = buildTestDeck(deckSize, seed);
  const state = G.createGame({
    seed, firstPlayer: seed % 2, deck, cardLib: TEST_CARD_LIB, factions: [],
  });
  state.humanSide = -1;
  state.autoResolveChoices = true;
  state.aiSides = [0, 1];
  G.startGame(state);
  const keys = [key0, key1];
  for (const side of [0, 1]) {
    applyDifficultyBonus(state, side, keys[side]);
    installAiTargetPicker(state);
  }

  const steps = [{ a: 'init', digest: digest(state) }];
  let n = 0;
  while (!G.isOver(state) && n < maxSteps) {
    n++;
    if (state.pending) {
      steps.push({ a: 'stuck', digest: digest(state) });
      break;
    }
    const actor = G.getActor(state);
    if (actor === null || actor === undefined) {
      G.advance(state);
      steps.push({ a: 'advance', digest: digest(state) });
      continue;
    }
    const handBefore = state.players[actor].hand.map((h) => h.iid + '=' + h.cardId).join(',');
    const res = aiTakeTurn(state, actor, { difficulty: keys[actor] });
    steps.push({
      a: 'turn', side: actor, difficulty: keys[actor], plays: res.count,
      actions: res.actions, hand: handBefore, digest: digest(state),
    });
    G.advance(state);
    steps.push({ a: 'advance', digest: digest(state) });
  }

  return {
    cfg: { seed, firstPlayer: seed % 2, deck, key0, key1 },
    over: G.isOver(state),
    winner: state.winner,
    turn: state.turn,
    steps,
  };
}

const PLAN = [
  { seed: 4001, key0: 'hard', key1: 'hard' },
  { seed: 4002, key0: 'normal', key1: 'normal' },
  { seed: 4003, key0: 'easy', key1: 'easy' },
  { seed: 4004, key0: 'hard', key1: 'easy' },
  { seed: 4005, key0: 'nightmare', key1: 'normal' },
  { seed: 4006, key0: 'hard', key1: 'nightmare' },
];

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('AI 对拍 · JS 侧');
  const index = [];
  for (const p of PLAN) {
    const run = runAiGame(p);
    const name = 'js-ai-seed' + p.seed + '.json';
    fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(run));
    index.push({ file: name, seed: p.seed, key0: p.key0, key1: p.key1 });
    console.log('  seed=' + p.seed + ' ' + p.key0 + ' vs ' + p.key1
      + ' 步数=' + run.steps.length + ' 终局=' + (run.over ? '是' : '否')
      + ' 胜者=' + run.winner + ' T' + run.turn);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'ai-index.json'), JSON.stringify(index, null, 2));
  console.log('写完 ' + index.length + ' 个文件 → godot/data/parity/');
}

main();
