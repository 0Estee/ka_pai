/** § 战斗特效：源头（爪痕）、阵亡残影、爪印大小 */
import fs from 'node:fs';
import path from 'node:path';
import { api, check, ROOT } from './harness.mjs';

console.log('\n§ 战斗特效的源头与爪印');

const dbg = () => {
  const d = api.__fxDebug;
  if (!d) throw new Error('缺少 __fxDebug 自检钩子');
  return d;
};

check('被打死的那张牌还画在格子里（残影），且爪印是按**格子**找它的', () => {
  api.__newGame();
  const st = api.__game();
  const d = dbg();
  const cardId = Object.keys(st.cardLib).find((id) => st.cardLib[id].type === 'unit');
  const html = d.ghost(st, { uid: 7, cardId, hpWait: 3 }, true);
  if (!html.includes('ghost')) throw new Error('残影丢了 ghost 类：' + html.slice(0, 120));
  // 残影**不能**带 data-uid：它在引擎里已经不存在了，带上就会让「点单位看详情」
  // 点到一块残影（点不出面板），也会把死人混进按 uid 收集的名单。
  if (html.includes('data-uid=')) throw new Error('残影不该带 data-uid：' + html.slice(0, 120));

  // 所以爪印必须按格子定位：格子在阵亡前后都在，位置也对
  const src = fs.readFileSync(path.join(ROOT, 'app', 'js', 'render.js'), 'utf8');
  const fn = src.slice(src.indexOf('function spawnClawFx'));
  const body = fn.slice(0, fn.indexOf('\nfunction ', 10) + 1 || 4000);
  if (!body.includes('.slot[data-lane=')) throw new Error('spawnClawFx 没有按格子定位，致死的那一下会找不到落点');
});

check('爪印大小跟着伤害走：1 点 < 5 点 < 同一记 5 点在致死时', () => {
  const d = dbg();
  const s1 = d.clawScale({ amount: 1 });
  const s5 = d.clawScale({ amount: 5 });
  const s5k = d.clawScale({ amount: 5, hp: 0 });
  if (!(s1 < s5)) throw new Error(`1 点(${s1}) 不该大于等于 5 点(${s5})`);
  if (!(s5 < s5k)) throw new Error(`致死的那一下(${s5k}) 应该更大，却小于等于 ${s5}`);
  // 口径：1 点是"浅浅一道"（卡面九成大小以内），重击要明显溢出卡面
  if (!(s1 <= 0.75)) throw new Error('1 点伤害的爪印太大：' + s1);
  if (!(s5k >= 1.2)) throw new Error('致死重击的爪印太小：' + s5k);
  // 越界钳制：0 / 负数 / 超大值都不能把爪印画成不存在或铺满全屏
  if (!(d.clawScale({ amount: 0 }) > 0.5)) throw new Error('伤害 0 时爪印消失了');
  if (!(d.clawScale({ amount: 99 }) <= 1.75)) throw new Error('超大伤害没有钳制上限');
});
