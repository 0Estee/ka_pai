#!/usr/bin/env node
/**
 * 用 GitHub Git Data API 提交，不依赖 git 协议。
 *
 * 为什么不用 git push：这台容器的 git 走 GitHub HTTPS 会被重置
 * （GnuTLS/传输层错误），而 Node fetch 到 api.github.com 是通的。
 *
 * 用法：
 *   node tools/push-github.mjs --dry-run      只列出要改的文件（不需要 token）
 *   node tools/push-github.mjs                读取 .gh-token 并提交到 main
 *   GITHUB_TOKEN=... node tools/push-github.mjs
 *
 * token 需要：仓库 0Estee/ka_pai 的 Contents: Read and write。
 * token 只从环境变量或仓库根目录的 .gh-token 读取，**不会打印**。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import url from 'node:url';

const ROOT = path.resolve(url.fileURLToPath(new URL('..', import.meta.url)));
const REPO = process.env.GITHUB_REPO || '0Estee/ka_pai';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const DRY = process.argv.includes('--dry-run');

function readToken() {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    const p = path.join(ROOT, '.gh-token');
    const t = fs.readFileSync(p, 'utf8').trim();
    return t || '';
  } catch {
    return '';
  }
}

const TOKEN = readToken();
if (!TOKEN && !DRY) {
  console.error('缺少 token：把 GitHub token 写到 ' + path.join(ROOT, '.gh-token') + '，或设置 GITHUB_TOKEN。');
  process.exit(2);
}

const API = 'https://api.github.com/repos/' + REPO;

async function api(pathname, opts = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ka-pai-deploy',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(opts.headers || {}),
  };
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  const res = await fetch(API + pathname, {
    ...opts,
    headers,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) {
    const msg = body && body.message ? body.message : ('HTTP ' + res.status);
    throw new Error(pathname + ' -> ' + msg);
  }
  return body;
}

/** git blob 的 SHA-1：sha1("blob <bytes>\0" + content) */
function blobSha(buf) {
  return crypto.createHash('sha1').update('blob ' + buf.length + '\0').update(buf).digest('hex');
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'assets', '.toolchain', 'shots',
  '.verify-apk', '.tmp', '.wrangler', '.dsh',
]);
const SKIP_FILES = new Set(['.cf-token', '.gh-token', 'keystore.jks']);
const SKIP_EXT = new Set(['.apk', '.idsig', '.log', '.zip', '.tar', '.gz', '.xz']);

/** 只提交这些位置；其余（生成物、密钥、APK）一律不碰 */
const ROOTS = [
  'app', 'engine', 'cloudflare/src', 'cloudflare/test', 'docs', 'tools', 'data', 'android/app',
  'README.md', 'package.json', '.gitignore', '.gitattributes',
  'cloudflare/package.json', 'cloudflare/package-lock.json', 'cloudflare/wrangler.toml',
];

function walk(rel, out) {
  const abs = path.join(ROOT, rel);
  let st;
  try { st = fs.statSync(abs); } catch { return; }
  if (st.isDirectory()) {
    const base = path.basename(rel);
    if (SKIP_DIRS.has(base)) return;
    // app/dist 与 android/build 是生成物
    if (rel === 'app/dist' || rel === 'android/build' || rel === 'cloudflare/assets') return;
    for (const name of fs.readdirSync(abs)) {
      if (name.startsWith('.') && name !== '.gitignore' && name !== '.gitattributes') continue;
      walk(path.join(rel, name), out);
    }
    return;
  }
  if (!st.isFile()) return;
  if (SKIP_FILES.has(path.basename(rel))) return;
  if (SKIP_EXT.has(path.extname(rel).toLowerCase())) return;
  out.push(rel.split(path.sep).join('/'));
}

function localFiles() {
  const out = [];
  for (const r of ROOTS) walk(r, out);
  return [...new Set(out)].sort();
}

async function main() {
  const ref = await api('/git/ref/heads/' + BRANCH);
  const headSha = ref.object.sha;
  const commit = await api('/git/commits/' + headSha);
  const treeSha = commit.tree.sha;
  const remoteTree = await api('/git/trees/' + treeSha + '?recursive=1');
  const remote = new Map();
  for (const e of remoteTree.tree || []) if (e.type === 'blob') remote.set(e.path, e.sha);

  const files = localFiles();
  const changed = [];
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    const sha = blobSha(buf);
    if (remote.get(rel) !== sha) changed.push({ rel, buf, sha });
  }

  // 远端有、本地没有的候选文件：只报告，不自动删（避免误删）
  const localSet = new Set(files);
  const missing = [];
  for (const p of remote.keys()) {
    if (ROOTS.some((r) => p === r || p.startsWith(r + '/'))) {
      if (!localSet.has(p)) missing.push(p);
    }
  }

  console.log('repo   ', REPO, BRANCH, headSha.slice(0, 8));
  console.log('changed', changed.length, changed.map((x) => x.rel).join(', '));
  if (missing.length) console.log('remote-only (不会自动删除)', missing.join(', '));

  if (DRY) {
    console.log('dry-run：没有提交。');
    return;
  }
  if (!changed.length) {
    console.log('没有变化，跳过提交。');
    return;
  }

  const tree = [];
  for (const f of changed) {
    const blob = await api('/git/blobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: f.buf.toString('base64'), encoding: 'base64' }),
    });
    tree.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const newTree = await api('/git/trees', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_tree: treeSha, tree }),
  });

  const message = '0.61.0: 账号、云存档与管理后台\n\n- Users Durable Object：注册/登录/改密、存档冲突、管理员列表/重置/删号\n- 首页/设置云存档入口，账户页与管理页\n- 文档、门禁与版本号 0.61.0 (versionCode 65)';
  const newCommit = await api('/git/commits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, tree: newTree.sha, parents: [headSha] }),
  });

  await api('/git/refs/heads/' + BRANCH, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: newCommit.sha }),
  });

  console.log('pushed', newCommit.sha);
  console.log('https://github.com/' + REPO + '/commit/' + newCommit.sha);
}

main().catch((e) => {
  console.error('push failed:', e && e.message ? e.message : e);
  process.exit(1);
});
