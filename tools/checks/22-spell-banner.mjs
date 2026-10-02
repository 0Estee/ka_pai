/**  提示条：锦囊的放大展示 + 伤害掉字不被裁掉（作者 2026-10 报的两条界面问题） */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, api, elements, check } from './harness.mjs';

console.log('\n 提示条：锦囊放大展示与伤害掉字');

/**
 * 打出一张能指定敌方国王、且带效果文本的锦囊，走玩家实际点的那两下（选牌 -> 点国王）。
 * 为什么要走这条路：横幅是 flashPlayPresentation 在对局通道里弹出的，
 * 直接调 showBanner 测不到「谁在什么时候弹了什么」。
 */
function playSpellOnKing() {
  api.__go('home');
  api.__newGame();
  api.__pause(true);
  // 挑一张有卡面文本、且能指定敌方国王的锦囊：横幅第二行要显示它的效果文本。
  // 不能用 __demoKingTarget 的 U01：攻击这张卡在卡定义里没有 text 字段，横幅第二行会是空的。
  const lib = Object.values(api.__game().cardLib);
  const cands = lib.filter((d) => d && d.type === 'spell' && d.text && (d.actions || []).some((a) => JSON.stringify(a).includes('chosenEnemyTarget')));
  const def = cands.find((d) => !JSON.stringify(d.actions).includes('allowKing')) || cands[0];
  if (!def) throw new Error('卡库里找不到能指定敌方国王、且带效果文本的锦囊');
  api.__demoHand([def.id]);
  api.selectCard(api.__game().players[0].hand[0].iid);
  const foe = 1;
  if (typeof api.handleKingClick !== 'function') {
    throw new Error('打包作用域里拿不到 handleKingClick（顶层函数应当被暴露到同一个作用域）');
  }
  api.handleKingClick(foe);
  return { foe, name: def.name };
}

check('锦囊打出后横幅是「卡名 + 效果文本」两行，不会把标签字样显示给玩家', () => {
  const { foe, name } = playSpellOnKing();
  const html = elements.get('stage').innerHTML;
  const at = html.indexOf('class="banner"');
  if (at < 0) throw new Error('打出锦囊后没有渲染出横幅');
  const end = html.indexOf('</div>', at);
  const banner = html.slice(at, end < 0 ? at + 400 : end);
  if (!banner.includes(name)) throw new Error('横幅里没有卡名：' + banner.slice(0, 120));
  if (!banner.includes('<small>')) throw new Error('横幅里没有小字第二行（效果文本应当是 small 元素）：' + banner.slice(0, 160));
  if (banner.includes('&lt;small&gt;')) throw new Error('横幅把 small 标签当成文本转义显示了（这正是作者报的问题）');
  const st = api.__game();
  if (!st.log.some((e) => e.type === 'king-damage' && e.side === foe)) throw new Error('这发锦囊没有打到国王，场面不成立');
});

check('源码里不再把 HTML 标签塞进横幅文本（showBanner 走第三个参数）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'js', 'game-flow.js'), 'utf8');
  const bad = [];
  let i = -1;
  while ((i = src.indexOf('showBanner(', i + 1)) >= 0) {
    const seg = src.slice(i, i + 220);
    if (seg.includes('<small')) bad.push(seg.slice(0, 70));
  }
  if (bad.length) throw new Error('横幅调用把标签塞进了文本，应改成第三个参数：' + bad.join(' | '));
  const third = (src.match(/, 2000, /g) || []).length;
  if (third < 3) throw new Error('三处横幅（陷阱触发 / 已埋伏 / 锦囊效果）应当都传第二个文本参数，实际只有 ' + third + ' 处');
});

check('掉字不会被格子裁掉，也不会被相邻格子盖住', () => {
  // 先剥掉 CSS 注释：注释里写着 overflow: hidden 这样的字眼会误伤下面的断言。
  const rawCss = fs.readFileSync(path.join(ROOT, 'app', 'style.css'), 'utf8');
  // strip CSS comments first (a comment may itself mention overflow: hidden); no regex needed
  const css = rawCss.split('/*').map((part, i) => (i === 0 ? part : part.slice(part.indexOf('*/') + 2))).join('');
  const slotAt = css.indexOf('.slot {');
  if (slotAt < 0) throw new Error('找不到 .slot 样式块');
  const slotBlock = css.slice(slotAt, css.indexOf('}', slotAt));
  if (slotBlock.includes('overflow: hidden')) {
    throw new Error('.slot 又在裁剪了（掉字一飘出格子就被切掉，作者 2026-10 报的遮挡就是它）：' + slotBlock.replace(/\s+/g, ' '));
  }
  const floatAt = css.indexOf('.fx-float {');
  if (floatAt < 0) throw new Error('找不到 .fx-float 样式块');
  const floatBlock = css.slice(floatAt, css.indexOf('}', floatAt));
  const m = floatBlock.match(/z-index:\s*(\d+)/);
  if (!m) throw new Error('.fx-float 没有 z-index：相邻格子的背景会盖住掉字');
  if (Number(m[1]) < 2) throw new Error('.fx-float 的 z-index 太小：' + m[1]);
});

