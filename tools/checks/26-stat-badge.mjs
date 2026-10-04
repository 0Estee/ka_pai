/**
 * § 属性徽记（攻击星 / 生命盾）
 *
 * 作者 2026-10 选定的方案 A：内联 SVG。宝石是图片（app/img/badge-*.png），
 * 数字是 SVG 文字，靠 paint-order: stroke 做真描边。
 *
 * 为什么不用「CSS 背景图 + span 数字」：数字压在宝石高光上，高光处对比度天然不足，
 * 浅色主题里橙字挤在亮底上几乎读不出来；CSS 的 text-shadow 八向模拟在浅底上会糊。
 *
 * 这里断言的是「标记 + 资源 + 样式」三件事都对上。
 * 故意**不**断言截图里的宝石像素：实测这条路不可判别 —— 棋盘 UI 自带的蓝红像素
 * 比两颗 22px 徽记还多（没有徽记的旧中局截图 strongBlue=1682，带徽记的只有 1888），
 * 数出来只会是噪声。真实观感靠 verify-apk 的截图人工核对。
 */
import fs from 'node:fs';
import { ROOT, api, elements, check } from './harness.mjs';

console.log('\n§ 属性徽记（攻击星 / 生命盾）');

const CSS = fs.readFileSync(ROOT + '/app/style.css', 'utf8');
const UI = fs.readFileSync(ROOT + '/app/js/ui.js', 'utf8');

/** 取一条 CSS 规则的内容（从 sel 起，到紧随其后的第一个行首 } 为止） */
function ruleBlock(css, sel) {
  const i = css.indexOf(sel);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('\n}', i));
}

check('徽记图片在仓库里，是 128x128 带 alpha 的合法 PNG', () => {
  for (const name of ['badge-atk.png', 'badge-hp.png']) {
    const p = ROOT + '/app/img/' + name;
    if (!fs.existsSync(p)) throw new Error('缺少 ' + p);
    const buf = fs.readFileSync(p);
    const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < magic.length; i++) {
      if (buf[i] !== magic[i]) throw new Error(name + ' 不是 PNG');
    }
    if (buf.length < 8000) throw new Error(name + ' 只有 ' + buf.length + ' 字节，不像正式素材');
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if (w !== 128 || h !== 128) throw new Error(name + ' 应为 128x128，实际 ' + w + 'x' + h);
    // IHDR 第 25 字节是 color type：6 = RGBA。宝石的透明角就是靠它。
    if (buf[25] !== 6) throw new Error(name + ' 必须带 alpha 通道（color type 应为 6，实际 ' + buf[25] + '）');
  }
});

check('徽记样式：内联 SVG 真描边 + 图片底光，不是 CSS 阴影模拟', () => {
  const text = ruleBlock(CSS, '.stat-badge text {');
  if (!text) throw new Error('style.css 里没有 .stat-badge text 规则');
  if (!/paint-order:\s*stroke/.test(text)) throw new Error('.stat-badge text 少了 paint-order: stroke');
  if (!/stroke:\s*var\(--stat-stroke\)/.test(text)) throw new Error('描边颜色没接 --stat-stroke');
  const badge = ruleBlock(CSS, '.stat-badge {');
  if (!/width:\s*var\(--badge-size,\s*22px\)/.test(badge)) throw new Error('.stat-badge 宽度没接 --badge-size');
  const bottom = ruleBlock(CSS, '.u-bottom {');
  if (!/justify-content:\s*space-between/.test(bottom)) throw new Error('.u-bottom 不是两侧分列（徽记要占卡片左右下角）');
  if (!/pointer-events:\s*none/.test(bottom)) throw new Error('.u-bottom 没关掉 pointer-events，徽记会吃掉点击');
});

check('三套主题都定义了徽记的底光与描边变量', () => {
  for (const sel of [':root {', ':root[data-theme="light"] {', ':root[data-theme="glass"] {']) {
    const box = ruleBlock(CSS, sel);
    if (!box) throw new Error('style.css 里找不到 ' + sel + ' 变量块');
    for (const v of ['--gem-atk:', '--gem-hp:', '--stat-stroke:']) {
      if (!box.includes(v)) throw new Error(sel + ' 缺少 ' + v);
    }
  }
});

check('场上单位渲染出攻击星与生命盾，数字等于攻击力 / 当前生命', () => {
  api.__go('home');
  api.__newGame();
  api.__pause(true);
  const lib = Object.values(api.__game().cardLib);
  // 挑「无词条、无效果」的普通单位：这样 atk/hp 不会被光环或异能改写，
  // 断言就能拿卡面数字直接比。
  const plain = lib.filter((d) => d && d.type === 'unit' && !d.token
    && !(d.keywords || []).length && !(d.actions || []).length
    && (d.atk || 0) > 0 && (d.hp || 0) > 1);
  if (plain.length < 2) throw new Error('卡库里找不到两张无词条的普通单位，没法测徽记');
  let mine = null;
  let foe = null;
  for (const d of plain) {
    if (!mine) mine = api.__place(0, d.id, 'mountain', 'front');
    if (!foe) foe = api.__place(1, d.id, 'plainR', 'front');
    if (mine && foe) break;
  }
  if (!mine || !foe) throw new Error('摆牌失败: ' + JSON.stringify([mine, foe]));
  api.__go('game');
  const html = elements.get('stage').innerHTML;
  for (const u of [mine, foe]) {
    const atkMark = 'class="stat-badge sb-atk" data-kind="atk" data-value="' + u.atk + '"';
    const hpMark = 'class="stat-badge sb-hp" data-kind="hp" data-value="' + u.hp + '"';
    if (!html.includes(atkMark)) throw new Error(u.name + ' 的攻击徽记没渲染出来（期望 data-value=' + u.atk + '）');
    if (!html.includes(hpMark)) throw new Error(u.name + ' 的生命徽记没渲染出来（期望 data-value=' + u.hp + '）');
  }
  if (!html.includes('img/badge-atk.png') || !html.includes('img/badge-hp.png')) {
    throw new Error('徽记标记里没有引用宝石图片');
  }
  if (html.includes('class="u-atk"') || html.includes('class="u-hp"')) {
    throw new Error('单位还在用旧的文本属性行（u-atk / u-hp）');
  }
});

check('受伤单位在生命盾上补出 /上限', () => {
  // 这一条只测**渲染**，所以直接改 state 里的 hp 再重绘：
  // 真去打一架的话，先手方是随机的、还有挂起交互，断言会变成掷骰子。
  const st = api.__game();
  const u = st && st.board.mountain.units[0].front;
  if (!u) throw new Error('前置场景没跑通：山上没有我方单位');
  if (u.maxHp < 2) throw new Error('这个单位的生命上限太小（' + u.maxHp + '），换一张卡再测');
  u.hp = u.maxHp - 1;
  api.__go('game');
  const html = elements.get('stage').innerHTML;
  const want = 'class="b-max" x="50" y="88">/' + u.maxHp + '<';
  if (!html.includes(want)) throw new Error('受伤单位的徽记上没有 /' + u.maxHp + '（应随生命盾一起显示上限）');
  api.__pause(false);
  api.__go('home');
});

check('阵亡残影也用徽记（源码级：ghostHTML 不再写文本属性行）', () => {
  const i = UI.indexOf('function ghostHTML(');
  if (i < 0) throw new Error('ui.js 里找不到 ghostHTML');
  const body = UI.slice(i, UI.indexOf('\n}', i));
  if (!body.includes("statBadge('atk'")) throw new Error('阵亡残影的攻击不是徽记');
  if (!body.includes("statBadge('hp'")) throw new Error('阵亡残影的生命不是徽记');
});