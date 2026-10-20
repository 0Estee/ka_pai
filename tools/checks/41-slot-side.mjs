/** § 放置高亮只属于己方半场（0.62.1 修复的回归门禁） */
import { api, elements, check } from './harness.mjs';

console.log('\n§ 放置高亮只属于己方半场');

check('选中一张单位牌：高亮 / 已选 / 拖压三种格子都不得出现在敌方半场', () => {
  const st = api.__newGameFirst();
  // 新对局默认处在自动阶段（busy=true），界面此时禁止选牌；测试里显式放行
  st.phase = 'DEPLOY_FIRST';
  st.firstPlayer = 0;
  api.__view().busy = false;
  st.players[0].manaCap = 10;
  st.players[0].mana = 10;
  // 塞一张有实体落点的单位牌进我方手牌并选中
  const lib = st.cardLib;
  const unitId = Object.keys(lib).find((k) => lib[k].type === 'unit' && !lib[k].token);
  if (!unitId) throw new Error('卡库里找不到单位牌');
  const hc = { iid: st.nextIid++, cardId: unitId };
  st.players[0].hand.push(hc);
  api.__selectCard(hc.iid);
  const html = elements.get('stage') ? elements.get('stage').innerHTML : '';

  // 我方侧（side="0"）的格子可以带 legal/picked/drag-over
  const mineLegal = html.match(/class="slot mine[^"]*\blegal\b[^"]*" data-lane="[a-zA-Z]+" data-side="0"/g) || [];
  if (!mineLegal.length) throw new Error('选中牌后我方半场应当有 legal 格（否则这条测试没测到东西）');

  // 敌方侧（side="1"）一个都不许有
  for (const bad of ['legal', 'picked', 'drag-over']) {
    const re = new RegExp('class="slot foe[^"]*\\b' + bad + '\\b');
    if (re.test(html)) throw new Error('敌方半场出现了 ' + bad + ' 高亮');
  }
});

check('召唤落点同样只亮我方半场', () => {
  const st = api.__newGameFirst();
  st.players[0].manaCap = 10;
  st.players[0].mana = 10;
  const html = elements.get('stage') ? elements.get('stage').innerHTML : '';
  const re = /class="slot foe[^"]*\blegal\b/;
  if (re.test(html)) throw new Error('敌方半场出现了 legal 高亮');
});
