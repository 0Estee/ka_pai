/** § 目标选择器登记（漏登记 = 那张牌在手里永远灰着） */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, check } from './harness.mjs';

// ── 选择器登记一致性 ──────────────────────────────────────
console.log('\n§ 目标选择器登记（漏登记 = 那张牌在手里永远灰着）');

/** 递归列出目录下的所有 .js，按路径排序（查找结果稳定，不受目录顺序影响） */
function listSourceFiles(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * 在目录里找到包含某个锚点字符串的源文件，返回 { path, text }；找不到就抛错并列出查过的文件。
 *
 * 为什么按锚点找、而不是写死路径：这些符号一直在被拆文件
 * （resolveTargets → targets.js、execActions → actions.js、analyzeSpell → play-input.js）。
 * 写死路径的话，每拆一次这条断言就失效一次；**找不到时必须明确报错**，绝不静默跳过。
 */
function findSourceFile(dir, anchor) {
  const files = listSourceFiles(dir);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes(anchor)) return { path: file, text };
  }
  throw new Error(`在 ${path.relative(ROOT, dir)} 里找不到包含「${anchor}」的源文件；`
    + `查过 ${files.length} 个文件：${files.map((f) => path.relative(ROOT, f)).join(', ')}`);
}

/**
 * 锚点所在函数体的结束位置：
 *   · 同一文件里还有下一个锚点（符号还住在一起时的布局）→ 用那个锚点当边界，和原实现一致
 *   · 否则切到下一个顶层 function 声明（符号被拆到别的文件之后的布局）
 *   · 都没有就切到文件末尾
 */
function bodyEnd(text, start, nextAnchor) {
  if (nextAnchor) {
    const hit = text.indexOf(nextAnchor, start + 1);
    if (hit >= 0) return hit;
  }
  const re = /\n(?:export\s+)?(?:async\s+)?function/g;
  re.lastIndex = start + 1;
  const m = re.exec(text);
  return m ? m.index : text.length;
}

/**
 * 这一类 bug 踩过两次（「紧急包扎」「虫群」）。
 * 症状极具迷惑性：界面一切正常，就是这张牌永远灰着、点了打不出去 ——
 * 因为 `analyzeSpell` 认为它「没有可选目标」。
 *
 * 这里做的是**源码级交叉验证**，不依赖运行时：
 *   引擎 resolveTargets 认识的每个 kind，必须要么在界面的 NO_CHOICE_TARGET_KINDS 里，
 *   要么被 analyzeSpell 显式处理（需要玩家点选的那些）。
 */
check('引擎支持的每个 target.kind 都被界面登记为「需选择」或「无需选择」', () => {
  const RESOLVE_ANCHOR = 'function* resolveTargets';
  const EXEC_ANCHOR = 'export function* execActions';
  const engine = findSourceFile(path.join(ROOT, 'engine', 'src'), RESOLVE_ANCHOR);
  const a = engine.text.indexOf(RESOLVE_ANCHOR);
  const b = bodyEnd(engine.text, a, EXEC_ANCHOR);
  const engineKinds = new Set(
    [...engine.text.slice(a, b).matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]),
  );
  if (engineKinds.size < 8) throw new Error(`只解析出 ${engineKinds.size} 个选择器，解析逻辑要修`);

  const ui = findSourceFile(path.join(ROOT, 'app', 'js'), 'const NO_CHOICE_TARGET_KINDS');
  const mj = ui.text;
  // 这三个符号必须还在同一个文件里、并且保持这个先后顺序（下面的切片靠它）：
  // 一旦被拆散，宁可明确报错，也绝不能让切片切错、断言静默失效。
  const uiPos = ['const NO_CHOICE_TARGET_KINDS', 'function analyzeSpell', 'function isPlayable']
    .map((anchor) => mj.indexOf(anchor));
  if (uiPos.some((i) => i < 0) || uiPos[0] > uiPos[1] || uiPos[1] > uiPos[2]) {
    throw new Error('界面侧的选择器登记解析不到：NO_CHOICE_TARGET_KINDS / analyzeSpell / isPlayable '
      + `必须按这个顺序住在同一个文件里（实际位置 ${JSON.stringify(uiPos)}）`);
  }

  const noChoiceBlock = mj.slice(mj.indexOf('const NO_CHOICE_TARGET_KINDS'), mj.indexOf('function analyzeSpell'));
  const noChoice = new Set([...noChoiceBlock.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]));

  const spellStart = mj.indexOf('function analyzeSpell');
  const spellBody = mj.slice(spellStart, mj.indexOf('function isPlayable', spellStart));
  const handled = new Set([...spellBody.matchAll(/spec\.kind === '([a-zA-Z]+)'/g)].map((m) => m[1]));

  const unregistered = [...engineKinds].filter((k) => !noChoice.has(k) && !handled.has(k));
  if (unregistered.length) {
    throw new Error(`这些选择器引擎认识、但界面没登记，用了它们的牌会永远灰着：${unregistered.join(', ')}`);
  }
});
