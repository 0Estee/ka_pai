/** § 战报：显示卡名 + 谁 / 动作 / 目标 分色 */
import fs from 'node:fs';
import { ROOT, api, check } from './harness.mjs';

console.log('\n§ 战报（卡名 + 分色）');

const css = fs.readFileSync(ROOT + '/app/style.css', 'utf8');

check('三套主题都给战报分色定义了变量', () => {
  // 玻璃主题必须覆盖深色主题的全部变量（见 10-theme），所以三块都要有
  const blocks = [
    ['深色', ':root {'],
    ['浅色', ':root[data-theme="light"] {'],
    ['玻璃', ':root[data-theme="glass"] {'],
  ];
  for (const [name, sel] of blocks) {
    const i = css.indexOf(sel);
    if (i < 0) throw new Error('找不到' + name + '主题变量块');
    const box = css.slice(i, css.indexOf('\n}', i));
    for (const v of ['--lg-act:', '--lg-tgt:']) {
      if (!box.includes(v)) throw new Error(name + '主题缺少变量 ' + v);
    }
  }
});

check('动作与目标的着色规则都在', () => {
  if (!css.includes('.lg-who {')) throw new Error('缺少 .lg-who 规则');
  if (!css.includes('.lg-act { color: var(--lg-act); }')) throw new Error('缺少 .lg-act 规则');
  if (!css.includes('.lg-tgt { color: var(--lg-tgt);')) throw new Error('缺少 .lg-tgt 规则');
});

check('引擎的消灭日志带上卡名（否则界面只能显示 U401 这种编号）', () => {
  const src = fs.readFileSync(ROOT + '/engine/src/board.js', 'utf8');
  const i = src.indexOf("type: 'destroy'");
  if (i < 0) throw new Error('board.js 里找不到 destroy 日志');
  const line = src.slice(src.lastIndexOf('\n', i), src.indexOf('\n', i));
  if (!line.includes('name:')) throw new Error('destroy 日志缺 name 字段：' + line.trim());
});

check('战报里显示卡名而不是内部编号，并且带分段着色的 span', () => {
  api.__go('home');
  api.__newGame();
  api.__pause(true);
  api.__go('game');
  const st = api.__game();
  const def = st.cardLib['U396'] || Object.values(st.cardLib)[0];
  if (!def || !def.name) throw new Error('卡库里取不到卡牌定义');
  // 直接塞日志：真打一架是掷骰子（随机先后手 + 可能挂起交互），这里要确定性
  st.log.push({ type: 'deploy', cardId: def.id, name: def.name, side: 0, lane: 'mountain', row: 'front' });
  // 老版本存档里的消灭日志没有 name  必须能靠 cardId 兜出卡名
  st.log.push({ type: 'destroy', cardId: def.id, side: 1, reason: 'lethal-damage', lane: 'mountain', row: 'front' });
  st.log.push({ type: 'king-damage', side: 0, amount: 3, hp: 17 });
  const log = api.__menuLog(true);
  const text = log.html.replace(/<[^>]*>/g, ' ');
  if (!text.includes(def.name)) throw new Error('战报里没有卡名：' + def.name);
  if (text.includes(def.id)) throw new Error('战报里出现了内部编号：' + def.id);
  for (const cls of ['lg-who', 'lg-act', 'lg-tgt']) {
    if (!log.html.includes('class="' + cls + '"')) throw new Error('战报缺少 ' + cls + ' 的分段');
  }
  if (!text.includes('致命伤害')) throw new Error('消灭原因没翻成中文（还印着英文标识）');
  api.__menuLog(false);
});
