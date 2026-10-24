/**
 * 全屏截图：把每个界面按手机宽度截一张，放在 .shots/。
 *
 * 需要 Firefox（无头、关沙盒）；容器里没有 Chrome 能跑。
 *   node tools/shots.mjs              截深色全套
 *   node tools/shots.mjs light        只截浅色
 *   node tools/shots.mjs dark game    只截指定几张
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(url.fileURLToPath(new URL('..', import.meta.url)));
const FF = process.env.FIREFOX || '/root/tmp/ff/firefox/firefox';
const PROFILE = process.env.FFPROFILE || '/root/tmp/ffprof';
const OUT = path.join(ROOT, '.shots');

const SHOTS = [
  { id: 'home', q: 'screen=home' },
  { id: 'play', q: 'screen=play' },
  { id: 'difficulty', q: 'screen=difficulty' },
  { id: 'lan', q: 'screen=lan' },
  { id: 'lanScan', q: 'screen=lanScan' },
  { id: 'lobby', q: 'screen=lobby&mode=host' },
  { id: 'settings', q: 'screen=settings' },
  { id: 'account', q: 'screen=account' },
  { id: 'admin', q: 'screen=admin' },
  { id: 'replays', q: 'demo=replays&n=4' },
  { id: 'game', q: 'turn=4&reveal=1' },
  { id: 'sandbox', q: 'demo=sandbox&place=0,U11,mountain,front;1,U21,mountain,front;0,U07,plainL,back' },
  { id: 'watch', q: 'demo=watch&turn=4' },
  { id: 'watchSide2', q: 'demo=watch&side=1&turn=4' },
  { id: 'sbfaction', q: 'demo=sbfaction&fac=demon' },
  { id: 'forgeMenu', q: 'screen=forgeMenu' },
  { id: 'adminEdit', q: 'demo=adminEdit' },
  { id: 'charm', q: 'demo=charm' },
  { id: 'adminEditSaved', q: 'demo=adminEdit&saved=1' },
  { id: 'watchJoin', q: 'screen=watchJoin' },
  { id: 'watching', q: 'demo=watchlobby&code=K7QM2P' },
  { id: 'factioninfo', q: 'demo=factioninfo&fac=demon' },
  { id: 'forge', q: 'screen=forge' },
  { id: 'replay', q: 'demo=replay&step=20&reveal=1' },
];

const theme = process.argv[2] || 'dark';
const only = process.argv.slice(3);
fs.mkdirSync(OUT, { recursive: true });

for (const shot of SHOTS) {
  if (only.length && !only.includes(shot.id)) continue;
  const file = path.join(OUT, `${shot.id}${theme === 'light' ? '-light' : ''}.png`);
  try { fs.unlinkSync(file); } catch { /* 忽略 */ }
  // 主题一定要显式给：设置存在 localStorage 里，Firefox 的 profile 是复用的，
  // 上一轮截过浅色，这一轮不带 theme 就会接着用浅色（深色图里其实是浅色）。
  const href = `file://${ROOT}/app/_preview.html?${shot.q}&noanim=1&theme=${theme}`;
  execFileSync(FF, ['--headless', '-no-remote', '--profile', PROFILE, '--window-size=390,844',
    '--screenshot', file, href], {
    env: { ...process.env, MOZ_HEADLESS: '1', MOZ_DISABLE_CONTENT_SANDBOX: '1', MOZ_DISABLE_GPU_SANDBOX: '1' },
    timeout: 90000, stdio: 'ignore',
  });
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  console.log(`${size ? '✓' : '✗'} ${shot.id}${theme === 'light' ? '-light' : ''} ${(size / 1024).toFixed(0)}KB`);
}
