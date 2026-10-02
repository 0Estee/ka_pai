/** § 目标高亮：国王作为可指定目标 */
import { api, elements, check } from './harness.mjs';

console.log('\n§ 目标高亮：国王作为可指定目标');

check('__demoKingTarget 高亮敌方国王、不高亮自己国王，并渲染出 targetable', () => {
  api.__newGame();
  api.__playTurns(4);
  const info = api.__demoKingTarget();
  if (!info) throw new Error('__demoKingTarget 返回空');

  const HUMAN = 0;
  const foe = 1 - HUMAN;

  if (!info.kingTargets.includes(foe)) {
    throw new Error(`应把敌方国王(${foe})列为可指定目标，实际 ${JSON.stringify(info.kingTargets)}`);
  }
  if (info.kingTargets.includes(HUMAN)) {
    throw new Error('不应把自己的国王列为可指定目标');
  }

  const html = elements.get('stage').innerHTML;
  if (!html.includes(`data-king="${foe}"`)) throw new Error('渲染结果缺少敌方国王元素');
  if (!html.includes(`class="sb-king targetable" data-king="${foe}"`)) {
    throw new Error('敌方国王未被渲染成高亮状态（targetable）');
  }
  if (html.includes(`class="sb-king targetable" data-king="${HUMAN}"`)) {
    throw new Error('自己的国王不应被渲染成高亮状态');
  }
  if (!html.includes('国王')) {
    throw new Error('提示文案里应提到国王');
  }
  // 阶段标签必须真的是"打出锦囊"，否则说明高亮状态和阶段对不上
  if (!html.includes('打出锦囊')) {
    throw new Error('阶段标签应为「打出锦囊」，渲染结果与状态不一致');
  }
});

check('__demoKingTarget 同时高亮敌方单位，且阶段切到了玩家的锦囊阶段', () => {
  const state = api.__game();
  const humanIsFirst = state.firstPlayer === 0;
  const expected = humanIsFirst ? 'SPELL_FIRST' : 'SPELL_SECOND';
  if (state.phase !== expected) {
    throw new Error(`阶段应为 ${expected}，实际 ${state.phase}`);
  }
  if (api.__game().players[0].mana < 1) throw new Error('应给足费用');
});
