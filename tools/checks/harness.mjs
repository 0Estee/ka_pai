/**
 * 打包产物集成测试的公共骨架。
 *
 * 从 tools/check-bundle.mjs 拆出（纯搬移，行为不变）：
 *   · 最小 DOM 桩（makeElement / makeLocalStorage / timers）
 *   · 用 node:vm 把 app/dist/modules/ 下的脚本**按顺序**当传统脚本求值，拿到 api（= window）
 *   · 断言收集：check（失败挡构建）/ softCheck（统计型，只报警告）
 *   · 共享结果数组 failures / warnings / results
 *
 * 各 § 分组文件 import 本文件时，下面的模块顶层代码**已经**把所有脚本求值完了，
 * 所以分组文件里可以直接用 api / elements / timers。
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';

export const ROOT = path.resolve(url.fileURLToPath(new URL('../..', import.meta.url)));
const MODULES_DIR = path.join(ROOT, 'app', 'dist', 'modules');

if (!fs.existsSync(MODULES_DIR)) {
  console.error('❌ 找不到 app/dist/modules/，请先运行 node tools/build-web.mjs');
  process.exit(1);
}

/**
 * 按文件名顺序加载：`tools/build-web.mjs` 已经按依赖顺序把文件编号成 `NN-...`，
 * 所以字典序就是执行序。
 *
 * ⚠ 所有脚本必须在**同一个** vm 上下文里求值：它们是传统脚本，靠全局作用域
 *   互相引用（浏览器里也是这样）。每个文件单独一个上下文会全部炸掉。
 *   `bundle.js` 只是浏览器用的加载器（走 document.write），在 DOM 桩里跑不了，
 *   所以这里直接按顺序加载模块本身。
 */
const MODULE_FILES = fs.readdirSync(MODULES_DIR).filter((n) => n.endsWith('.js')).sort();

// ── 最小 DOM 桩 ───────────────────────────────────────────
export const elements = new Map();
function makeElement(id) {
  const classes = new Set();
  return {
    id,
    innerHTML: '',
    dataset: {},
    style: {},
    value: '',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
    },
  };
}

/**
 * localStorage 桩。
 * 真实浏览器里有，Android WebView 里靠 setDomStorageEnabled(true) 打开；
 * 这里必须提供，否则「金币 / 回放能不能存下来」这条链路根本没被测到。
 */
function makeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    get length() { return map.size; },
    __map: map,
  };
}

export const timers = new Map();
let timerSeq = 0;

export const sandbox = {
  console,
  setTimeout: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; },
  clearTimeout: (id) => { timers.delete(id); },
  Math,
  Date,
  JSON,
  Object,
  Array,
  Set,
  Map,
  Number,
  String,
  Boolean,
  Error,
  Symbol,
  Infinity,
  NaN,
  undefined,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
sandbox.localStorage = makeLocalStorage();
sandbox.document = {
  documentElement: { dataset: {} },
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  },
  addEventListener() {},
  querySelector() { return null; },
};

// ── 加载产物 ──────────────────────────────────────────────
export const failures = [];
export const warnings = [];
/** § 整合对局 跑出来的每局结果，供 § 统计 汇总 */
export const results = [];

/**
 * 「软断言」：**统计型**测量（AI 强弱对比）用这个，失败只报警告、不挡构建。
 *
 * 为什么必须分开：n=100 时「胜率差值」的标准差约 7%，而这类测试想抓的真实差距
 * 只有 10~16% —— 余量不到 2 个标准差，误报率 15~30%。
 * 拿它当构建门禁，等于让构建**随机失败**（已经真的发生过一次：
 * build-apk.ps1 因为「噩梦打困难 68%」中止，重跑四次又全过）。
 *
 * 强度是**观测数据**，该写进报告；能不能构建要看**确定性**的结构断言（见下面各条 hardCheck）。
 */
export function softCheck(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    warnings.push({ name, message: err.message });
    console.log(`  ⚠ ${name}`);
    console.log(`      ${err.message.split('\n')[0]}`);
  }
}

export function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message.split('\n')[0]}`);
  }
}

console.log('§ 加载打包产物');
try {
  vm.createContext(sandbox);
  for (const f of MODULE_FILES) {
    vm.runInContext(fs.readFileSync(path.join(MODULES_DIR, f), 'utf8'), sandbox, { filename: f });
  }
  console.log(`  ✓ ${MODULE_FILES.length} 个脚本按依赖顺序求值成功，无语法错误/运行时异常`);
} catch (err) {
  console.error(`  ✗ 求值失败: ${err.message}`);
  process.exit(1);
}

export const api = sandbox;
console.log(`  · 暴露的钩子: ${Object.keys(api).filter((k) => k.startsWith('__')).join(', ') || '（无）'}`);
