/** § 首次渲染：首页 */
import { api, elements, check } from './harness.mjs';

console.log('\n§ 首次渲染：首页');
check('启动后进的是首页，不是直接开局', () => {
  if (api.__screen() !== 'home') throw new Error(`初始屏幕应为 home，实际 ${api.__screen()}`);
  if (api.__game()) throw new Error('首页阶段不该已经建好对局');
});

check('首页渲染出三个入口 + 右上角金币与等级', () => {
  const html = elements.get('stage')?.innerHTML ?? '';
  if (!html) throw new Error('stage.innerHTML 为空');
  for (const marker of ['data-act="start-game"', 'data-act="open-replays"', 'data-act="open-settings"',
    '开始游戏', '回放对局', '设置', 'hud-gold', 'hud-lv']) {
    if (!html.includes(marker)) throw new Error(`首页缺少 ${marker}`);
  }
});

check('新档发 100 初始金币，且不计入累计（不白送等级）', () => {
  const p = api.__profile();
  if (!p) throw new Error('没有档案');
  if (p.gold !== 100) throw new Error(`初始金币应为 100，实际 ${p.gold}`);
  if (p.lifetimeGold !== 0) throw new Error(`初始累计金币应为 0，实际 ${p.lifetimeGold}`);
});
