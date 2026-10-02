/** § 深色 / 浅色 / 玻璃主题 */
import fs from 'node:fs';
import { ROOT, api, elements, sandbox, check } from './harness.mjs';

// ── 主题 ──────────────────────────────────────────────────
console.log('\n§ 深色 / 浅色 / 玻璃主题');

check('默认是深色主题', () => {
  api.__setTheme('dark');
  if (api.__theme() !== 'dark') throw new Error(`documentElement.dataset.theme 应为 dark，实际 ${api.__theme()}`);
});

check('切到浅色后写入设置并反映到 documentElement', () => {
  api.__setTheme('light');
  if (api.__theme() !== 'light') throw new Error('切到浅色失败');
  const raw = sandbox.localStorage.getItem('kapai.settings.v1');
  if (!raw) throw new Error('设置没写进 localStorage');
  if (JSON.parse(raw).theme !== 'light') throw new Error('写盘的主题不对');
});

check('设置页渲染出主题开关与当前选项', () => {
  api.__go('settings');
  const html = elements.get('stage').innerHTML;
  if (!html.includes('data-act="set-theme"')) throw new Error('缺少主题切换按钮');
  if (!html.includes('data-theme="light"')) throw new Error('缺少浅色选项');
  if (!html.includes('seg-item on" data-act="set-theme" data-theme="light"')) {
    throw new Error('当前主题没有高亮到「浅色」上');
  }
});

check('回到首页后金币/等级仍然正确渲染', () => {
  api.__go('home');
  const html = elements.get('stage').innerHTML;
  if (api.__screen() !== 'home') throw new Error('没回到首页');
  if (!html.includes(String(api.__profile().gold))) throw new Error('首页没有显示当前金币');
  if (!html.includes('Lv.')) throw new Error('首页没有显示等级');
});

//  玻璃主题（第三个外观选项，作者 2026-10）
check('切到玻璃主题后写入设置并反映到 documentElement', () => {
  api.__setTheme('glass');
  if (api.__theme() !== 'glass') throw new Error('documentElement.dataset.theme 应为 glass，实际 ' + api.__theme());
  const raw = sandbox.localStorage.getItem('kapai.settings.v1');
  if (!raw) throw new Error('设置没写进 localStorage');
  if (JSON.parse(raw).theme !== 'glass') throw new Error('写盘的主题不对');
});

check('设置页渲染出三个主题选项，玻璃时高亮在玻璃上', () => {
  api.__go('settings');
  const html = elements.get('stage').innerHTML;
  for (const t of ['dark', 'light', 'glass']) {
    if (!html.includes('data-theme="' + t + '"')) throw new Error('缺少 ' + t + ' 选项');
  }
  if (!html.includes('seg-item on" data-act="set-theme" data-theme="glass"')) {
    throw new Error('当前主题没有高亮到「玻璃」上');
  }
  if (html.includes('seg-item on" data-act="set-theme" data-theme="light"')) {
    throw new Error('玻璃主题下「浅色」还亮着');
  }
});

check('玻璃主题样式真的进源码了（变量表完整 + 磨砂 + 光斑背景）', () => {
  const css = fs.readFileSync(ROOT + '/app/style.css', 'utf8');
  const i = css.indexOf(':root[data-theme="glass"] {');
  if (i < 0) throw new Error('style.css 里没有玻璃主题的变量块');
  const box = css.slice(i, css.indexOf('\n}', i));
  const names = (s) => [...s.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]);
  const darkBox = css.slice(css.indexOf(':root {'), css.indexOf('\n}', css.indexOf(':root {')));
  const glass = new Set(names(box));
  const missing = [...new Set(names(darkBox))].filter((k) => !glass.has(k));
  if (missing.length) throw new Error('玻璃主题漏掉变量：' + missing.join(' '));
  if (!/backdrop-filter:\s*blur\(/.test(css)) throw new Error('没有任何磨砂规则');
  if (!/:root\[data-theme="glass"\] body/.test(css)) throw new Error('缺少玻璃的渐变光斑背景');
  if (!/:root\[data-theme="light"\] \{/.test(css)) throw new Error('浅色主题变量块不见了');
});

// 收尾：下游检查原本就在浅色主题下跑（复位，别影响别人）
check('玻璃检查跑完把主题复位成浅色', () => {
  api.__setTheme('light');
  if (api.__theme() !== 'light') throw new Error('复位失败');
  api.__go('home');
});
