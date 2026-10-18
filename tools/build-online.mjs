/**
 * 把 `app/` 组装成 Cloudflare Workers 的静态资源目录 `cloudflare/assets/`。
 *
 * 与 `tools/build-web.mjs` 的关系：
 *   build-web.mjs  把 app/js 下的 ESM 拍平成浏览器能直接跑的 app/dist/bundle.js。
 *   本脚本          只是**搬运** —— 把浏览器真正需要的几个东西拷过去，别的（_preview.html、
 *                   诊断页、旧截图）一律不带，免得线上多出些不该公开的调试入口。
 *
 * 为什么先跑 build-web：线上跑的就是刚打出来的 bundle，和 APK 里那份必须是同一份代码。
 * 所以这里自己调一次 build-web，不做「你自己先跑一下」的约定 —— 少一个会忘的步骤。
 *
 * 用法：node tools/build-online.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(url.fileURLToPath(new URL('..', import.meta.url)));
const APP = path.join(ROOT, 'app');
const OUT = path.join(ROOT, 'cloudflare', 'assets');

/** 只带这些：入口页 + 两张样式表 + 打包产物 + 卡图 */
const FILES = ['index.html', 'style.css', 'screens.css'];
const DIRS = ['dist', 'img'];

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    const st = fs.statSync(src);
    if (st.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

/**
 * 把 `dir` 里不在 `keep` 里的东西删掉（相对路径的集合）。
 *
 * 为什么要「原地镜像」而不是先 rmSync 整个目录：
 * Windows 上 `wrangler dev` 的文件监听器会**一直持有 assets 目录的句柄**，
 * 删这个目录本身会 EPERM（连 `force: true` 都不行）。开发时最常见的动作恰恰是
 * 「改完代码 → 重新组装 → dev 服务自己热更新」，所以这里只覆盖/删除文件，
 * 永远不删 assets 根目录。
 */
function pruneExtras(dir, keepPrefix, rel = '') {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const relPath = rel ? `${rel}/${name}` : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      pruneExtras(full, keepPrefix, relPath);
      // 空目录顺手收掉（同样可能被监听器占着，失败就算了）
      try { if (fs.readdirSync(full).length === 0) fs.rmdirSync(full); } catch { /* 忽略 */ }
    } else if (!keepPrefix.some((p) => relPath === p || relPath.startsWith(`${p}/`))) {
      try { fs.unlinkSync(full); } catch { /* 被占用就先留着，下次再说 */ }
    }
  }
}

function dirBytes(dir) {
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    total += st.isDirectory() ? dirBytes(p) : st.size;
  }
  return total;
}

// ── 1. 先打包 JS（线上和 APK 用同一份）
console.log('· 打包前端 JS…');
execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-web.mjs')], {
  cwd: ROOT,
  stdio: 'inherit',
});

// ── 2. 原地镜像到资源目录（不删根目录，见 pruneExtras 的说明）
console.log('· 组装 cloudflare/assets/…');
fs.mkdirSync(OUT, { recursive: true });

for (const name of FILES) {
  const src = path.join(APP, name);
  if (!fs.existsSync(src)) throw new Error(`缺少资源：${name}`);
  fs.copyFileSync(src, path.join(OUT, name));
}
for (const name of DIRS) {
  const src = path.join(APP, name);
  if (!fs.existsSync(src)) throw new Error(`缺少资源目录：${name}/`);
  copyDir(src, path.join(OUT, name));
}

// ── 3. 删掉上一轮留下、这一轮不再需要的东西
//    例：某张卡图改名了、某个模块合并了 —— 留着旧的会让「线上是哪一版」变得说不清。
pruneExtras(OUT, [...FILES, ...DIRS]);

// ── 3. 兜底自检：没这些东西线上就是白屏，宁可构建失败也别发出去
const must = [
  'index.html',
  'style.css',
  'screens.css',
  'dist/bundle.js',
  'dist/modules',
  'img',
];
for (const name of must) {
  if (!fs.existsSync(path.join(OUT, name))) throw new Error(`组装结果缺少 ${name}`);
}
const indexHTML = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
if (!indexHTML.includes('dist/bundle.js')) {
  throw new Error('index.html 里没有引用 dist/bundle.js —— 线上会是一片空白');
}
const modCount = fs.readdirSync(path.join(OUT, 'dist', 'modules')).filter((n) => n.endsWith('.js')).length;
if (modCount < 30) throw new Error(`只组装到 ${modCount} 个模块，明显不对（应为 39 个左右）`);

const kb = (dirBytes(OUT) / 1024).toFixed(1);
console.log(`✅ 联机资源就绪: cloudflare/assets/  ${modCount} 个模块  ${kb} KB`);
console.log('   下一步： cd cloudflare && npx wrangler deploy');
