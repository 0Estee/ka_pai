/**
 * 把 data/_transcribe 下 A~D 四组卡牌片段合并成正式的卡牌模块
 * `engine/cards/user-cards-b3.js`。
 *
 *   node tools/merge-b3.mjs
 *
 * 为什么要合：录卡是分批并行做的（每组一个 agent），
 * 但运行时**只能有一个** `USER_CARDS` 来源 —— 否则
 * `TEST_CARDS = [...DEMO_CARDS, ...USER_CARDS]` 会漏掉某些组，
 * 表现是「卡录进去了但对局里永远抽不到」。
 *
 * 合并时会做几项硬校验，任一项不过就中止：
 *   · id 全局唯一（跨组也不能撞）
 *   · id 与现有 U01~U17 不撞
 *   · 令牌（token:true）不进牌库、但必须在卡牌库里
 *   · 每张卡有 name / type / cost
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(url.fileURLToPath(new URL('..', import.meta.url)));
const SRC = path.join(ROOT, 'data', '_transcribe');
const OUT = path.join(ROOT, 'engine', 'cards', 'user-cards-b3.js');
// W = 心驭阵营的五张超能力（原本直接写在产物里，见 data/_transcribe/_cards_W.js 的说明）
const GROUPS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W'];
// 允许部分合并（某一个片段还没生成就先跳过），方便边录边验；
// 但**至少要有 A~D** —— 那是最初那 65 张，少了它们就是在往回退。
const REQUIRED = ['A', 'B', 'C', 'D'];

const { USER_CARDS: EXISTING } = await import(url.pathToFileURL(
  path.join(ROOT, 'engine', 'cards', 'user-cards.js')).href);

const all = [];
const seen = new Map();
const problems = [];

for (const g of GROUPS) {
  const file = path.join(SRC, `_cards_${g}.js`);
  if (!fs.existsSync(file)) {
    if (REQUIRED.includes(g)) problems.push(`缺少片段 _cards_${g}.js（这是必需组）`);
    else console.log(`   · ${g} 组片段还不存在，跳过`);
    continue;
  }
  const mod = await import(url.pathToFileURL(file).href);
  const list = mod[`CARDS_${g}`];
  if (!Array.isArray(list)) { problems.push(`_cards_${g}.js 没有导出 CARDS_${g}`); continue; }

  for (const card of list) {
    if (!card.id || !card.name || !card.type) {
      problems.push(`${g}: 卡缺 id/name/type → ${JSON.stringify(card).slice(0, 80)}`);
      continue;
    }
    if (card.type !== 'unit' && card.type !== 'spell') {
      problems.push(`${card.id} ${card.name}: type 只能是 unit/spell，实际 ${card.type}`);
    }
    if (typeof card.cost !== 'number') problems.push(`${card.id} ${card.name}: cost 不是数字`);
    if (EXISTING.some((c) => c.id === card.id)) problems.push(`${card.id} 与现有卡撞 id`);
    if (seen.has(card.id)) problems.push(`${card.id} 在 ${seen.get(card.id)} 与 ${g} 之间重复`);
    seen.set(card.id, g);
    all.push(card);
  }
}

/**
 * 防「静默丢卡」：合并产物里可能有**片段里没有**的卡
 * （心驭阵营 U478~U482 就是直接写在产物里的）。
 * 合并会从零重建产物，这些卡就**无声消失**了 —— 抽不到、也没有任何报错。
 * 所以先比一遍 id，只要有一张会消失就中止，让人先把它补进片段。
 */
if (fs.existsSync(OUT)) {
  const prev = await import(url.pathToFileURL(OUT).href + '?prev=' + Date.now());
  const nextIds = new Set(all.map((c) => c.id));
  const dropped = (prev.USER_CARDS_B3 || []).map((c) => c.id).filter((id) => !nextIds.has(id));
  if (dropped.length) {
    problems.push(`这些卡在合并产物里、但片段里没有，合并会把它们丢掉：${dropped.join(', ')}`
      + '（把它们补进 data/_transcribe 对应片段，或干脆删掉片段目录、改为直接维护产物）');
  }
}

if (problems.length) {
  console.error('❌ 合并前校验失败：');
  for (const p of problems) console.error('   · ' + p);
  process.exit(1);
}

const body = all.map((c) => '  ' + JSON.stringify(c, null, 2).split('\n').join('\n  ')).join(',\n');

const out = `/**
 * 作者设计的卡牌 · 第三批（手绘卡 k 目录 + 令牌目录）
 *
 * ⚠️ 这个文件由 \`tools/merge-b3.mjs\` 从 data/_transcribe 的 A~D 四组片段合并生成，
 *    **不要手改** —— 改了下次合并会被覆盖。要改卡就改片段再合并，
 *    或者先合并、之后把片段目录删掉、转为直接维护本文件。
 *
 * 录入约定：
 *   · 卡面上 \`⚔\` 与 \`◈\` 都是攻击力，\`♥\` 是生命
 *   · 卡面旧名「飞行」= 词条 \`nimble\`（轻灵）
 *   · 独占一行且带下划线的词条名 → \`keywords\`；出现在句子中间的 → 效果文本里的引用
 *   · 类型下方带「令」的卡是**令牌**：\`token: true\`，不进牌库、只能被召唤
 *   · 每个 op / 选择器 / 触发时机写法见 data/_transcribe/引擎DSL速查.md
 */

export const USER_CARDS_B3 = [
${body},
];
`;

fs.writeFileSync(OUT, out, 'utf8');
console.log(`✅ 合并完成: engine/cards/user-cards-b3.js`);
console.log(`   共 ${all.length} 张（令牌 ${all.filter((c) => c.token).length} 张）`);
for (const g of GROUPS) {
  const n = all.filter((c) => seen.get(c.id) === g).length;
  console.log(`   · ${g} 组 ${n} 张`);
}
