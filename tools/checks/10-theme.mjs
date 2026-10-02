/** § 深色 / 浅色主题 */
import { api, elements, sandbox, check } from './harness.mjs';

// ── 主题 ──────────────────────────────────────────────────
console.log('\n§ 深色 / 浅色主题');

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
