#!/usr/bin/env node
/**
 * 发 GitHub Release（容器内版本，和 tools/publish-release.ps1 等价）。
 *
 * 为什么需要它：APK 进仓库只是 backup，**别人下载的正路是 Release 附件**
 * （固定链接 `releases/latest/download/ka-pai-<版本>.apk`）。0.61~0.67 那几版
 * 就是只推了源码、没发 Release，作者在 GitHub 上看着就是「没有推送」。
 *
 * 用法：
 *   node tools/publish-release.mjs 0.68.0            # 真发
 *   node tools/publish-release.mjs 0.68.0 --dry-run  # 只打印将要做什么
 *
 * 它做的事：
 *   1. 读 dist/ka-pai-<版本>.apk（没有就报错，绝不发空 Release）
 *   2. 打 tag v<版本>（已存在就跳过）指向当前 main
 *   3. 建 Release，正文取 docs/发行说明-<版本>.md（没有就用一句兜底）
 *   4. 把 APK 作为附件上传，并校验上传后的字节数
 *
 * token：只从环境变量 GITHUB_TOKEN / GH_TOKEN 或仓库根目录 .gh-token 读，不打印。
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.resolve(url.fileURLToPath(new URL('..', import.meta.url)));
const REPO = process.env.GITHUB_REPO || '0Estee/ka_pai';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const version = (args.find((a) => /^\d+\.\d+\.\d+$/.test(a)) || '').trim();

function readToken() {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try { return fs.readFileSync(path.join(ROOT, '.gh-token'), 'utf8').trim(); } catch { return ''; }
}
const TOKEN = readToken();

const H = {
  Authorization: 'Bearer ' + TOKEN,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'ka-pai-release',
  'X-GitHub-Api-Version': '2022-11-28',
};
const API = 'https://api.github.com/repos/' + REPO;

async function api(pathname, opts = {}) {
  const res = await fetch(API + pathname, { ...opts, headers: { ...H, ...(opts.headers || {}) }, signal: AbortSignal.timeout(60000) });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

async function main() {
  if (!version) {
    console.error('用法：node tools/publish-release.mjs <版本号> [--dry-run]');
    process.exit(2);
  }
  const apkPath = path.join(ROOT, 'dist', 'ka-pai-' + version + '.apk');
  if (!fs.existsSync(apkPath)) {
    console.error('找不到 ' + apkPath + ' —— 先构建 APK（bash tools/build-apk-container.sh）');
    process.exit(2);
  }
  const buf = fs.readFileSync(apkPath);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const notesPath = path.join(ROOT, 'docs', '发行说明-' + version + '.md');
  const notes = fs.existsSync(notesPath)
    ? fs.readFileSync(notesPath, 'utf8')
    : '# 发行说明 ' + version + '\n\n（这一版没有单独的发行说明文件）\n';
  const body = notes + '\n\n---\n\n## 装法\n\n' +
    '1. 下载附件 `ka-pai-' + version + '.apk`（' + Math.round(buf.length / 1024) + ' KB）；\n' +
    '2. 手机上点开安装（自签名包，首次会提示「未知来源」，允许即可）；\n' +
    '3. 可以直接覆盖安装旧版（同一个签名密钥，存档不丢）。\n\n' +
    'sha256：`' + sha + '`\n';
  const tag = 'v' + version;

  console.log('repo   ', REPO, BRANCH);
  console.log('apk    ', apkPath, Math.round(buf.length / 1024) + 'KB', sha.slice(0, 16));
  if (DRY) {
    console.log('dry-run：不建 tag、不发 Release。');
    return;
  }
  if (!TOKEN) {
    console.error('缺少 token：写到 ' + path.join(ROOT, '.gh-token') + ' 或设 GITHUB_TOKEN。');
    process.exit(2);
  }

  const head = await api('/git/ref/heads/' + BRANCH);
  if (head.status !== 200) { console.error('拿不到 ' + BRANCH + ' 的头：', head.status); process.exit(1); }
  const headSha = head.body.object.sha;

  const existingTag = await api('/git/ref/tags/' + tag);
  if (existingTag.status === 404) {
    const made = await api('/git/refs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'refs/tags/' + tag, sha: headSha }),
    });
    console.log(existingTag.status === 404 ? 'tag    ' : '', made.status === 201 ? '已建 ' + tag : '建 tag 失败 ' + made.status);
    if (made.status !== 201) { console.error(JSON.stringify(made.body).slice(0, 300)); process.exit(1); }
  } else {
    console.log('tag    ', tag, '已存在，跳过');
  }

  const rel = await api('/releases', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, target_commitish: BRANCH, name: version, body, draft: false, prerelease: false }),
  });
  if (rel.status !== 201) { console.error('建 Release 失败', rel.status, JSON.stringify(rel.body).slice(0, 300)); process.exit(1); }
  console.log('release', rel.status, rel.body.html_url);

  const up = await fetch('https://uploads.github.com/repos/' + REPO + '/releases/' + rel.body.id
    + '/assets?name=ka-pai-' + version + '.apk', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': String(buf.length) },
    body: buf,
    signal: AbortSignal.timeout(180000),
  });
  const asset = await up.json();
  if (up.status !== 201) { console.error('上传附件失败', up.status, JSON.stringify(asset).slice(0, 300)); process.exit(1); }
  if (asset.size !== buf.length) {
    console.error('附件大小对不上：本地 ' + buf.length + '，远端 ' + asset.size);
    process.exit(1);
  }
  console.log('asset  ', asset.name, asset.size, 'bytes');
  console.log('download', asset.browser_download_url);
}

main().catch((e) => { console.error('publish-release failed:', e && e.message ? e.message : e); process.exit(1); });
