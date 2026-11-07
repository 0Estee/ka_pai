/**
 * 把现有 JS 卡牌 / 规则数据导出成 Godot 用的 JSON（作者 2026-11-01 迁移）。
 *
 * 为什么是「导出数据」而不是「逐张手抄」：
 *   卡牌的效果本来就是一份**声明式 DSL**（op / target.kind / filter / trigger），
 *   引擎负责解释它。迁移到 GDScript 时只要把解释器重写一遍，
 *   这套数据可以原样搬过去 —— 216 张卡一张都不用改。
 *
 * 产物（都在 data/ 下，Godot 侧直接 res://data/xxx.json 读）：
 *   cards.json     所有作者卡（含令牌），原样保留 actions / effects / 各种开关
 *   keywords.json  词条定义表（名称 + 是否带 X + 类别 + 说明）
 *   rules.json     常量（线路 / 排 / 阶段 / 国王血量 …）+ 阵营表
 *
 * 用法：node tools/export-rules-json.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { AUTHOR_CARDS, DEMO_CARDS, TOKEN_CARDS } from '../engine/cards/test-cards.js';
import { KEYWORD_DEFS, KEYWORDS_NOT_GRANTABLE } from '../engine/src/keywords.js';
import {
  LANES, LANE_NAME, ROWS, SIDE_NAME, PHASES, PHASE_ALLOWED_CARD_TYPE,
  CARD_TYPE, KING_MAX_HP, REBIRTH_HP, DRAW_ON_FIRST_TURN, MAX_TURNS,
} from '../engine/src/constants.js';
import { FACTIONS, RAW_MATERIAL_IDS, FLAME_IDS, FLAME_PILE_MAKEUP, FLAME_LOTUS_ID, RAW_COMBOS } from '../engine/src/factions.js';

const ROOT = path.resolve(url.fileURLToPath(new URL('..', import.meta.url)));
const OUT = path.join(ROOT, 'data');

/** 只带「数据」字段：函数字段（如 choose/onPlay 回调）在卡牌定义里不存在，但保险起见剔除 */
function plain(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(plain);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'function') continue;
    out[k] = plain(v);
  }
  return out;
}

function write(name, data) {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
  const kb = (fs.statSync(p).size / 1024).toFixed(1);
  console.log(`  ✓ ${name}  ${kb} KB`);
}

// ── 1. 卡牌 ───────────────────────────────────────────────
// 以 TEST_CARD_LIB 的口径为准：作者卡 + 白板演示卡（回放/自检要用），
// 令牌也在里面（token: true，牌库构建时会滤掉）。
const all = [...DEMO_CARDS, ...AUTHOR_CARDS];
const cards = all.map((c) => plain(c));
const ids = new Set();
for (const c of cards) {
  if (!c.id) throw new Error('有卡没有 id：' + JSON.stringify(c).slice(0, 80));
  if (ids.has(c.id)) throw new Error('卡 id 重复：' + c.id);
  ids.add(c.id);
}

// ── 2. 词条 ───────────────────────────────────────────────
const keywords = Object.fromEntries(Object.entries(KEYWORD_DEFS).map(([id, d]) => [id, plain(d)]));

// ── 3. 常量 / 阵营 ────────────────────────────────────────
const rules = {
  lanes: LANES,
  laneName: LANE_NAME,
  rows: ROWS,
  sideName: SIDE_NAME,
  phases: PHASES,
  phaseAllowedCardType: PHASE_ALLOWED_CARD_TYPE,
  cardType: CARD_TYPE,
  kingMaxHp: KING_MAX_HP,
  rebirthHp: REBIRTH_HP,
  drawOnFirstTurn: DRAW_ON_FIRST_TURN,
  maxTurns: MAX_TURNS,
  factions: FACTIONS,
  /** 抽超能力的国王血量阈值（顺序固定 = 抽取顺序确定） */
  superpowerThresholds: [15, 9, 3],
  keywordsNotGrantable: KEYWORDS_NOT_GRANTABLE,
  rawMaterialIds: RAW_MATERIAL_IDS,
  rawCombos: RAW_COMBOS,
  flameIds: FLAME_IDS,
  flamePileMakeup: FLAME_PILE_MAKEUP,
  flameLotusId: FLAME_LOTUS_ID,
  /**
   * 牌库构建参数：现有 buildTestDeck 的逻辑（40 张共享牌库 / 起手 5-4）
   * 在 GDScript 侧重写，这里只把数字固定下来。
   */
  deckSize: 40,
  openingHandFirst: 5,
  openingHandSecond: 4,
};

fs.mkdirSync(OUT, { recursive: true });
console.log(`· 导出规则数据到 data/（${cards.length} 张卡，其中令牌 ${TOKEN_CARDS.length} 张）`);
write('cards.json', { version: 1, generatedAt: new Date().toISOString(), cards });
write('keywords.json', { version: 1, keywords });
write('rules.json', { version: 1, rules });

// 顺手做一份体检：效果里出现过的 op / target.kind，GDScript 解释器要全覆盖
const ops = new Set();
const kinds = new Set();
function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(walk); return; }
  if (typeof node.op === 'string') ops.add(node.op);
  if (node.target && typeof node.target.kind === 'string') kinds.add(node.target.kind);
  for (const v of Object.values(node)) walk(v);
}
for (const c of cards) walk(c);
fs.writeFileSync(path.join(OUT, 'dsl-surface.json'), JSON.stringify({
  ops: [...ops].sort(),
  targetKinds: [...kinds].sort(),
}, null, 2) + '\n', 'utf8');
console.log(`  ✓ dsl-surface.json  op ${ops.size} 种 / target.kind ${kinds.size} 种（GDScript 解释器需要对表）`);
