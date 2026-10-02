/**
 * 极简打包器：把 ESM 源码打成**单个传统脚本**。
 *
 * 为什么需要它：
 *   Android WebView 从 file:// 加载 <script type="module"> 会被 CORS 拦截
 *   （file:// 是不透明源，模块请求走 CORS 检查）。
 *   传统 <script> 没有这个限制，所以把 ESM 拍平成一个普通脚本最稳。
 *
 * 为什么不用 webpack / esbuild：
 *   npm 官方源不可达，而本项目的 import 形式高度统一，
 *   用正则就能覆盖，不引入任何依赖。
 *
 * 支持的语法（本项目的全部用法，import 允许跨行）：
 *   import { a, b } from './x.js';
 *   import * as NS from './x.js';
 *   import './x.js';
 *   export function f() {}   export const c = 1;   export class C {}
 *   export { a, b };
 *
 * 输出：
 *   app/dist/modules/NN-<组>-<文件>.js   一个源模块一个 classic script，按依赖顺序编号
 *   app/dist/bundle.js                   加载器：按顺序把这些脚本插进页面
 * 命名空间导入会生成对应的对象字面量（`const G = { ... }`），插在被导入模块那个文件末尾。
 * 构建结束会做语法自检，避免产出坏文件。
 *
 * 用法：node tools/build-web.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(url.fileURLToPath(new URL('..', import.meta.url)));
const ENTRY = path.join(ROOT, 'app', 'js', 'main.js');
const OUT_FILE = path.join(ROOT, 'app', 'dist', 'bundle.js');

const modules = new Map();

/** 解析单个模块：抽出 import / export，返回去掉这些语句的正文 */
function parseModule(absPath) {
  if (modules.has(absPath)) return modules.get(absPath);
  if (!fs.existsSync(absPath)) throw new Error(`模块不存在: ${absPath}`);

  let src = fs.readFileSync(absPath, 'utf8');
  const imports = [];
  const exportNames = new Set();

  // ── import * as NS from '...'
  src = src.replace(
    /^[ \t]*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"];?[ \t]*$/gm,
    (_, ns, from) => { imports.push({ namespace: ns, from }); return ''; },
  );

  // ── import { a, b } from '...'   （关键：允许跨行，之前按单行匹配会漏）
  src = src.replace(
    /^[ \t]*import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"];?[ \t]*$/gm,
    (_, names, from) => {
      imports.push({
        names: names.split(',').map((s) => s.trim()).filter(Boolean),
        from,
      });
      return '';
    },
  );

  // ── import '...'
  src = src.replace(
    /^[ \t]*import\s+['"]([^'"]+)['"];?[ \t]*$/gm,
    (_, from) => { imports.push({ sideEffect: true, from }); return ''; },
  );

  // ── export { a, b as c };
  src = src.replace(
    /^[ \t]*export\s*\{([\s\S]*?)\};?[ \t]*$/gm,
    (_, names) => {
      for (const piece of names.split(',')) {
        const n = piece.trim().split(/\s+as\s+/).pop().trim();
        if (n) exportNames.add(n);
      }
      return '';
    },
  );

  // ── export function / const / let / var / class NAME
  src = src.replace(
    /^([ \t]*)export\s+(function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm,
    (_, indent, kind, name) => {
      exportNames.add(name);
      return `${indent}${kind} ${name}`;
    },
  );

  // 残留检测
  if (/^[ \t]*(import|export)\b/m.test(src)) {
    const bad = src.split(/\r?\n/).filter((l) => /^[ \t]*(import|export)\b/.test(l));
    throw new Error(`${path.relative(ROOT, absPath)} 仍有未处理的 import/export：\n  ${bad.join('\n  ')}`);
  }

  const record = { absPath, code: src, imports, exportNames };
  modules.set(absPath, record);

  for (const imp of imports) {
    if (imp.sideEffect) continue;
    parseModule(path.resolve(path.dirname(absPath), imp.from));
  }
  return record;
}

/** 拓扑排序：被依赖的模块在前 */
function topoOrder(entry) {
  const seen = new Set();
  const order = [];
  (function visit(absPath) {
    if (seen.has(absPath)) return;
    seen.add(absPath);
    const mod = modules.get(absPath);
    for (const imp of mod.imports) {
      if (imp.sideEffect) continue;
      visit(path.resolve(path.dirname(absPath), imp.from));
    }
    order.push(absPath);
  })(entry);
  return order;
}

/** 收集「哪些模块需要以命名空间形式引用某个模块」 */
function namespaceAliasesFor(targetPath, order) {
  const aliases = new Set();
  for (const p of order) {
    for (const imp of modules.get(p).imports) {
      if (!imp.namespace) continue;
      if (path.resolve(path.dirname(p), imp.from) === targetPath) aliases.add(imp.namespace);
    }
  }
  return [...aliases];
}

// ── 主流程 ────────────────────────────────────────────────
parseModule(ENTRY);
const order = topoOrder(ENTRY);

/**
 * 收集一个模块的**顶层**声明名（缩进为 0 的 function / const / let / var / class）。
 */
function topLevelNames(code) {
  const names = new Set();
  const re = /^(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(code)) !== null) names.add(m[1]);
  return names;
}

/**
 * 跨模块重名检测。
 *
 * 打包器把所有模块**拼进同一个 IIFE 作用域**，所以任意两个模块的顶层名字
 * 都不能重复 —— 重名会静默地把前一个覆盖掉，而且报错位置离真正的原因很远。
 *
 * 真实踩过的坑：app/js/main.js 里的 `startGame()` 撞上了 engine.js 导出的
 * `startGame`，于是 `G.startGame` 被指向了界面函数，变成
 * newGame → G.startGame → newGame → … 无限递归，
 * 报出来的是 rng.js 里的「Maximum call stack size exceeded」。
 * 定位花了很久，所以这里直接拦下，不许再发生。
 */
function findCollisions(order) {
  const owner = new Map();
  const hits = [];
  for (const absPath of order) {
    const names = topLevelNames(modules.get(absPath).code);
    for (const alias of namespaceAliasesFor(absPath, order)) names.add(alias);
    for (const n of names) {
      if (owner.has(n)) {
        hits.push({ name: n, first: owner.get(n), second: absPath });
      } else {
        owner.set(n, absPath);
      }
    }
  }
  return hits;
}

const collisions = findCollisions(order);
if (collisions.length > 0) {
  const lines = collisions.map((c) => {
    const a = path.relative(ROOT, c.first).replace(/\\/g, '/');
    const b = path.relative(ROOT, c.second).replace(/\\/g, '/');
    return `  · "${c.name}"  同时声明于  ${a}  和  ${b}`;
  });
  throw new Error(
    `打包失败：有 ${collisions.length} 个顶层名字在多个模块里重复。\n`
    + `${lines.join('\n')}\n`
    + '所有模块会被拼进同一个作用域，重名会静默覆盖（曾经导致无限递归）。请改名。',
  );
}

// ── 产出 ──────────────────────────────────────────────────
/**
 * 一个源模块 → 一个 classic script，按依赖顺序编号。
 *
 * 为什么不打成一个文件：打成一个文件时，手机上出错只会报
 * `bundle.js:29000`，跟源码对不上；拆成一个源文件一个脚本之后，
 * 报错行号直接落在 `engine/src/actions.js` 这样的真实文件上。
 *
 * ⚠ 这些文件**不能**用 `<script type="module">`：WebView 从 file:// 加载模块
 *   会被 CORS 挡掉（file:// 是不透明源）。所以它们是传统脚本，靠**全局作用域**
 *   互相引用 —— 这正是 findCollisions 必须拦重名的原因。
 * ⚠ 因为共享全局作用域，顶层名字会遮蔽同名的 window 属性。
 *   `let`/`const` 遮蔽是安全的（已实测 `let screen` 在 Chrome 里正常，
 *   window.screen 仍可访问）；`var`/`function` 同名才危险。下面有警告。
 */
const MODULES_DIR = path.join(ROOT, 'app', 'dist', 'modules');

/** engine/src、engine/cards、app/js 三组，进文件名便于人眼定位 */
function groupOf(rel) {
  if (rel.startsWith('engine/src/')) return 'engine';
  if (rel.startsWith('engine/cards/')) return 'cards';
  return 'app';
}

const emitted = order.map((absPath, i) => {
  const rel = path.relative(ROOT, absPath).replace(/\\/g, '/');
  return {
    rel,
    name: `${String(i + 1).padStart(2, '0')}-${groupOf(rel)}-${path.basename(absPath)}`,
    code: modules.get(absPath).code,
  };
});

const AUTO = '/* 自动生成，请勿手改 —— 源文件在 engine/src、engine/cards 与 app/js */';

// 先清空目录：删掉的模块如果留下旧文件，verify-apk 会因为
// 「APK 里有、工程源码里没有」而报失败（这是刻意的双向校验）。
fs.rmSync(MODULES_DIR, { recursive: true, force: true });
fs.mkdirSync(MODULES_DIR, { recursive: true });
fs.rmSync(path.join(ROOT, 'app', 'dist', 'bundle.broken.js'), { force: true });

let namespaceCount = 0;
for (const absPath of order) {
  const mod = modules.get(absPath);
  const rel = path.relative(ROOT, absPath).replace(/\\/g, '/');
  const it = emitted.find((e) => e.rel === rel);
  const lines = [
    AUTO,
    `/* 源文件：${rel} */`,
    "'use strict';",
    mod.code,
  ];
  for (const alias of namespaceAliasesFor(absPath, order)) {
    lines.push(`const ${alias} = { ${[...mod.exportNames].sort().join(', ')} };`);
    namespaceCount++;
  }
  fs.writeFileSync(path.join(MODULES_DIR, it.name), lines.join('\n'), 'utf8');
}

// ── 语法自检：宁可构建失败，也不要产出坏文件 ──────────────
const concat = emitted.map((e) => e.code).join('\n');
try {
  // eslint-disable-next-line no-new-func
  new Function(`'use strict';\n${concat}`);
} catch (err) {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(OUT_FILE), 'bundle.broken.js'), concat, 'utf8');
  throw new Error(`打包结果语法错误：${err.message}\n（已把坏产物写到 app/dist/bundle.broken.js 便于排查）`);
}

// ── 顶层名字 vs 浏览器全局，警告（不挡构建） ───────────────
/**
 * 模块共享全局作用域，所以顶层名字会落在 window 上。
 * 这里只警告「名字本身就是常见 window 属性」的那些，避免以后踩坑。
 */
const KNOWN_SAFE_SHADOWS = new Set([
  // screen 是 app-state.js 的当前屏幕变量。实测 Chrome 里
  // `let screen = 'home'` 完全正常：window.screen 是 configurable 的属性，
  // 全局 let 只是遮蔽它，window.screen 仍可访问。所以放行。
  'screen',
]);
const RISKY_GLOBAL_NAMES = new Set([
  'name', 'length', 'status', 'top', 'self', 'parent', 'origin', 'location', 'history',
  'open', 'close', 'stop', 'find', 'print', 'focus', 'blur', 'scroll', 'alert', 'confirm',
  'prompt', 'event', 'external', 'frames', 'document', 'window', 'navigator', 'localStorage',
  'sessionStorage', 'indexedDB', 'crypto', 'performance', 'customElements', 'isSecureContext',
]);
const shadowWarnings = [];
for (const e of emitted) {
  for (const n of topLevelNames(e.code)) {
    if (RISKY_GLOBAL_NAMES.has(n) && !KNOWN_SAFE_SHADOWS.has(n)) shadowWarnings.push(`${n}  ← ${e.rel}`);
  }
}

// ── 加载器：bundle.js ─────────────────────────────────────
/**
 * 为什么还留着 bundle.js：它是 **app/index.html 唯一引用的那个脚本**，
 * 也是局域网 HTTP 服务与 Java 侧测试按路径取前端代码的入口
 * （见 docs/联机协议.md 的资源表），所以不能删。
 *
 * 用 document.write 插入 <script>：**解析期**插入是同步且有序的，
 * 能保证模块严格按依赖顺序执行，而且 index.html / _preview.html / _diag.html
 * 一行都不用改。'<scr' + 'ipt' 是为了不在 JS 字符串里出现字面量 `</script>`。
 */
const loader = `${AUTO}
/*
 * 加载器：真正的代码在 dist/modules/ 里，一个源文件一个脚本。
 * 本文件只按依赖顺序把它们插进页面（解析期 document.write 同步有序）。
 * 想看/调试某个模块，直接去 dist/modules/ 找对应文件，报错行号也和源码对得上。
 */
(function () {
  var FILES = [
${emitted.map((e) => `    'dist/modules/${e.name}',`).join('\n')}
  ];
  for (var i = 0; i < FILES.length; i++) {
    document.write('<scr' + 'ipt src="' + FILES[i] + '"></scr' + 'ipt>');
  }
})();
`;
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, loader, 'utf8');

// ── 给 tools/*.ps1 自动补 UTF-8 BOM ───────────────────────
/**
 * Windows PowerShell 5.1 会把**没有 BOM** 的 .ps1 当成 ANSI 读，
 * 中文注释会变成乱码并直接报语法错误（报错位置还完全对不上）。
 *
 * 各种编辑工具经常在保存时悄悄去掉 BOM，所以这里每次打包都自动补回来。
 * 已经踩过两次：一次是手写脚本时，一次是改了 build-apk.ps1 之后。
 * 报错长这样：
 *   Unexpected token '}' in expression or statement.
 *   + Write-Host '鈹€' * 58
 */
function ensurePs1Bom() {
  const dir = path.join(ROOT, 'tools');
  const fixed = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.ps1')) continue;
    const file = path.join(dir, name);
    const buf = fs.readFileSync(file);
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) continue;
    fs.writeFileSync(file, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(buf.toString('utf8'), 'utf8'),
    ]));
    fixed.push(name);
  }
  return fixed;
}

const bomFixed = ensurePs1Bom();

const modBytes = emitted.reduce((a, e) => a + fs.statSync(path.join(MODULES_DIR, e.name)).size, 0);
const loaderBytes = fs.statSync(OUT_FILE).size;
console.log(`✅ 打包完成: app/dist/modules/  共 ${emitted.length} 个脚本   ${(modBytes / 1024).toFixed(1)} KB   语法自检通过`);
console.log(`   加载器 app/dist/bundle.js  ${(loaderBytes / 1024).toFixed(1)} KB（index.html 只引它，它按顺序插入上面那些脚本）`);
console.log(`   命名空间 ${namespaceCount} 个`);
if (shadowWarnings.length) {
  console.log(`   ⚠ ${shadowWarnings.length} 个顶层名字和浏览器全局属性同名（会遮蔽 window 上的同名属性）：`);
  for (const w of shadowWarnings) console.log(`     · ${w}`);
}
if (bomFixed.length) {
  console.log(`   ⚠ 已自动补回 UTF-8 BOM: ${bomFixed.join(', ')}（PowerShell 5.1 需要）`);
}
for (const e of emitted) {
  console.log(`   · dist/modules/${e.name}   ← ${e.rel}  (导出 ${modules.get(path.join(ROOT, e.rel)).exportNames.size})`);
}
