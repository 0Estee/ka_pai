/** § 心驭阵营（作者 2026-10-24）：控制机制的界面表现 + 阵营接入 */
import fsx from 'node:fs';
import pathx from 'node:path';
import { api, check, elements, ROOT } from './harness.mjs';

console.log('\n§ 心驭阵营：控制');

const stageHTML = () => (elements.get('stage') ? elements.get('stage').innerHTML : '') || '';
const readSource = (rel) => fsx.readFileSync(pathx.join(ROOT, rel), 'utf8');

/** 摆一局靶场（任意摆牌、不花费用），返回 state */
function sandbox() {
  api.__sandbox();
  api.__advance();
  api.__view().busy = false;
  api.__revealAll();
  return api.__game();
}

check('卡库里五张心驭牌都在，令牌标记正确', () => {
  const st = sandbox();
  const defs = ['U478', 'U479', 'U480', 'U481', 'U482'].map((id) => st.cardLib[id]);
  for (const d of defs) if (!d) throw new Error('卡库缺牌：' + JSON.stringify(defs));
  const token = defs.filter((d) => d.token).map((d) => d.id);
  if (token.length !== 1 || token[0] !== 'U480') throw new Error('令牌应当只有「最强の诱惑」(U480)，实际 ' + JSON.stringify(token));
  if (defs.some((d) => d.faction !== 'heart')) throw new Error('五张牌都该属于 heart 阵营');
});

check('难度页能选「心驭」', () => {
  api.__go('difficulty');
  const html = stageHTML();
  if (!html.includes('data-key="heart"')) throw new Error('难度页没有心驭阵营这一行');
  if (!html.includes('心驭')) throw new Error('心驭这个名字没渲染出来');
});

check('控制成功：卡面出现「被控制」标签 + 粉红纹路（.charmed）', () => {
  const st = sandbox();
  const prey = api.__sbPlay(1, 'U242', { lane: 'mountain', row: 'front', placeSide: 1 });
  if (!prey.ok) throw new Error('先在对面摆一张失败：' + prey.err);
  const target = st.board.mountain.units[1].front;
  const res = api.__sbPlay(0, 'U478', { targetUid: target.uid });
  if (!res.ok) throw new Error('控制失败：' + res.err);
  api.__clearFlights();
  api.__revealAll();
  const now = api.__game().board.mountain.units[0].front;
  if (!now || now.uid !== target.uid) throw new Error('单位没有被搬到我方（界面层看到的还是对面）');
  const html = stageHTML();
  if (!html.includes('charmed')) throw new Error('场上卡面没有 charmed 类（粉红纹路靠它）');
  if (!html.includes('u-charm')) throw new Error('卡面没有「被控制」那颗标签');
  if (!html.includes('被控制')) throw new Error('标签文字没渲染出来');
});

check('点开被控制的单位：详情里写明「被控制 · 原属敌方」', () => {
  const st = api.__game();
  const u = st.board.mountain.units[0].front;
  api.__tapUnit(u.uid);
  const html = stageHTML();
  if (!html.includes('unit-info')) throw new Error('详情面板没打开');
  if (!html.includes('被控制')) throw new Error('详情里没写被控制');
  if (!html.includes('原属')) throw new Error('详情里没写原主人');
});

check('手牌上的卡面文字用作者原文（不是兜底翻译）', () => {
  const st = sandbox();
  api.__sbPlay(0, 'U478', { lane: 'plainL' });   // 没有合法目标 → 不生效，但牌进了手里又打出去了
  // 直接塞进手牌看渲染更稳
  const hand = st.players[0].hand;
  hand.push({ iid: st.nextIid++, cardId: 'U482' });
  api.__clearFlights();
  api.__revealAll();
  const html = stageHTML();
  if (!html.includes('魔醉の臣服')) throw new Error('手牌里没看到这张牌');
  if (!html.includes('控制一名敌人并将其冻结')) throw new Error('卡面文字没有按作者原文显示');
});

check('样式契约（源码级）：粉红纹路用主题变量，三套主题各有一份', () => {
  const css = readSource('app/style.css');
  for (const bit of ['.unit.charmed', '.unit.charmed .u-charm', '--charm:', '--charm-line-1:', '--charm-line-2:']) {
    if (!css.includes(bit)) throw new Error('style.css 缺少 ' + bit);
  }
  if ((css.match(/--charm-line-1:/g) || []).length < 3) throw new Error('--charm-line-1 应当在三套主题里各定义一次（深色 / 浅色 / 玻璃）');
  if (css.includes('color-mix(')) throw new Error('用了 color-mix：老 WebView 不支持，会让整条 background-image 失效');
  const ui = readSource('app/js/ui.js');
  if (!ui.includes("charmed ? 'charmed' : ''")) throw new Error('ui.js 没把被控制的单位标成 .charmed');
  if (!ui.includes('u-charm')) throw new Error('ui.js 没画「被控制」标签');
});

check('AI 认识新动作：control / duel 都有估值，不会当没见过', () => {
  const ai = readSource('app/js/ai.js');
  for (const bit of ["case 'control':", "case 'duel':", 'findControlSpot']) {
    if (!ai.includes(bit)) throw new Error('ai.js 缺少 ' + bit);
  }
  const input = readSource('app/js/play-input.js');
  if (!input.includes('spec.controlRoom')) throw new Error('界面的目标高亮没有考虑 controlRoom（会亮出打不出去的敌人）');
});
