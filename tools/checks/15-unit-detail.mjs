/** § 场上卡牌详情：点一下就能看到它在场上干什么 */
import { api, elements, check } from './harness.mjs';

// ── 场上卡牌详情 ──────────────────────────────────────────
console.log('\n§ 场上卡牌详情：点一下就能看到它在场上干什么');

check('棋盘上每个单位都能点出详情面板（攻击力 / 生命 / 卡面效果 / 打向谁）', () => {
  // 棋盘格子只有那么点大，塞不下卡面文字。以前点场上单位毫无反应
  // （handleUnitClick 在没有选中手牌时直接 return），
  // 于是「这张牌在场上的攻击/效果」在界面上完全看不见。
  let sawKeywords = false;
  let sawEffect = false;
  let tapped = 0;

  // 场上出现哪些单位是随机的，牌库里也有白板牌，
  // 所以多开几局，直到既见到词条全文、也见到真正的卡面效果文字。
  // ⚠ 只推进到第 3 回合：卡池变大之后对局平均 7~8 回合就结束，
  //    推进到第 8 回合经常已经分出胜负（那条路径点不出面板），整条测试会偶发失败。
  for (let g = 0; g < 12 && !(sawKeywords && sawEffect); g++) {
    api.__newGame();
    api.__playTurns(3);

    // 已经分出胜负的局会被结算浮层盖住，此时点场上单位是刻意不响应的
    // （和对局内其它操作一致），跳过它换下一局。
    if (api.__game().winner !== null) continue;

    const html0 = elements.get('stage').innerHTML;
    const uids = [...html0.matchAll(/data-uid="(\d+)"/g)].map((m) => Number(m[1]));
    if (!uids.length) continue; // 这一局场上还没单位，换下一局（不判失败）

    for (const uid of uids) {
      const r = api.__tapUnit(uid);
      tapped++;
      if (!r.hasPanel) throw new Error(`点场上单位 uid=${uid} 没有弹出详情面板`);
      for (const marker of ['ui-atk', 'ui-hp']) {
        if (!r.html.includes(marker)) throw new Error(`uid=${uid} 的详情面板缺少 ${marker}`);
      }
      // 攻击力为 0 的单位不写「开战打向」，而是明确说明这一击不造成伤害
      if (!r.html.includes('开战打向') && !r.html.includes('开战不会造成伤害')) {
        throw new Error(`uid=${uid} 的详情面板没有说清开战会打向谁`);
      }
      if (r.html.includes('ui-kws')) sawKeywords = true;
      if (r.html.includes('ui-effect') && !r.html.includes('这张牌没有额外效果')) sawEffect = true;

      api.__nav('close-info');
      if (elements.get('stage').innerHTML.includes('unit-info')) {
        throw new Error('点了关闭，详情面板却还在');
      }
    }
  }

  if (!tapped) throw new Error('12 局都没能点到场上单位，这条测试没覆盖到目标场景');
  if (!sawKeywords) throw new Error(`点了 ${tapped} 个场上单位，一条词条全文都没渲染出来`);
  if (!sawEffect) throw new Error(`点了 ${tapped} 个场上单位，一次卡面效果文字都没渲染出来`);

  api.__pause(false);
});
