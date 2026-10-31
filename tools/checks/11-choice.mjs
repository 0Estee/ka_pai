/** § 抉择：效果打到一半反问玩家 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, api, check } from './harness.mjs';

// ── 目标高亮（含国王）─────────────────────────────────────
console.log('\n§ 抉择：效果打到一半反问玩家');

check('「抉择」：会挂起并弹出二选一，点选后结算并恢复', () => {
  if (typeof api.__demoChoice !== 'function') throw new Error('缺少 __demoChoice 钩子');
  const info = api.__demoChoice();
  if (info.error) throw new Error(`打出歼-10 失败：${info.error}`);
  if (!info.pending) throw new Error('引擎没有挂起 —— 抉择面板不会出现');
  if (!info.hasMask) throw new Error('挂起了，但界面上没有渲染出 choice-mask 面板');
  if (info.options.length !== 2) throw new Error(`应该有 2 个选项，实际 ${info.options.length}`);
  for (const label of info.options) {
    if (!info.html.includes(label)) throw new Error(`选项「${label}」没有渲染到界面上`);
  }
  if (!info.html.includes('data-act="choose-option"')) throw new Error('选项按钮没有绑定 choose-option');

  // 点第二个选项：「+4⚔+2♥ 并获得装甲1」→ 场上应该是 8/6
  const after = api.__resolveChoice(1);
  if (after.pending) throw new Error('回答之后仍然处于挂起状态');
  if (after.atk !== 8 || after.hp !== 6) {
    throw new Error(`选第二项后应该是 8/6，实际 ${after.atk}/${after.hp}`);
  }
  if (after.auto !== true) throw new Error('交互走完后没有把 autoResolveChoices 恢复成 true（后面会自动卡住）');
});

check('「抉择」：点第一个选项走另一条分支（少花 4 费 + 穿透1）', () => {
  const info = api.__demoChoice();
  if (!info.pending) throw new Error('没有挂起');
  const after = api.__resolveChoice(0);
  if (after.pending) throw new Error('回答之后仍挂起');
  if (after.atk !== 4 || after.hp !== 4) {
    throw new Error(`选第一项不该改身材，实际 ${after.atk}/${after.hp}`);
  }
  if (after.mana !== 16) throw new Error(`8 费打出 + 退还 4 = 剩 16，实际 ${after.mana}`);
});

// ── 选项太多要能上下滑（作者 2026-10-31 报的 bug）───────────────
/**
 * 取某个选择器在**顶层**（不在 @media 里）的声明，后写的覆盖先写的。
 *
 * 为什么要求顶层：这条断言锁的是「不管屏幕多高都生效」的修复；
 * 只在某个 @media 里写 overflow-y，小屏以外的机型照样滑不动，
 * 那种写法应该让断言失败，而不是蒙混过关。
 */
function topLevelDecls(cssFile, selector) {
  const src = fs.readFileSync(path.join(ROOT, cssFile), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = {};
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(src))) {
    const head = m[1].trim();
    // 外层还开着花括号 = 在 @media / @supports 里面
    const before = src.slice(0, m.index);
    const depth = (before.match(/\{/g) || []).length - (before.match(/\}/g) || []).length;
    if (depth !== 0) continue;
    if (!head.split(',').map((s) => s.trim()).includes(selector)) continue;
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
    }
  }
  return out;
}

check('选项面板限高、只有选项区滚动（选项一多不能滑出去的 bug）', () => {
  const box = topLevelDecls('app/screens.css', '.choice-box');
  if (box.display !== 'flex') throw new Error('.choice-box 不是 flex 列 —— 没法把标题固定、只让选项区滚');
  if (!/calc\(100(d)?vh/.test(box['max-height'] || '')) {
    throw new Error(`.choice-box 没有 max-height: calc(100vh|100dvh - …)，现在是 ${JSON.stringify(box['max-height'])}`);
  }

  const list = topLevelDecls('app/screens.css', '.choice-list');
  if (list['overflow-y'] !== 'auto') {
    throw new Error(`.choice-list 没有 overflow-y: auto（现在是 ${JSON.stringify(list['overflow-y'])}）—— 选项一多就滑不动`);
  }
  if (list['min-height'] !== '0') {
    throw new Error('flex 子项默认 min-height:auto，不写 min-height: 0 滚动区会被内容顶破');
  }
  if (!/1 1 auto|1 1 0|flex: 1/.test(list.flex || '')) {
    throw new Error(`.choice-list 应该 flex: 1 1 auto 撑满剩余高度，现在是 ${JSON.stringify(list.flex)}`);
  }

  const opt = topLevelDecls('app/screens.css', '.choice-opt');
  if (!/^0 0 auto/.test(opt.flex || '')) {
    throw new Error(`.choice-opt 必须 flex: 0 0 auto，否则选项会被压扁（现在是 ${JSON.stringify(opt.flex)}）`);
  }

  // 召唤落点用的是底部条，同样可能列很多格
  const bar = topLevelDecls('app/screens.css', '.choice-bar');
  if (bar['overflow-y'] !== 'auto') throw new Error('.choice-bar（召唤落点）也不能滑');
});
