/** § 融合进化 / 单位打出选目标（作者 2026-09 报的两个 bug） */
import { api, check } from './harness.mjs';

console.log('\n§ 融合进化 / 单位打出选目标（作者 2026-09 报的两个 bug）');

check('融合进化：点场上的队友就能把新牌打到他身上', () => {
  if (typeof api.__demoFuse !== 'function') throw new Error('缺少 __demoFuse 钩子');
  const r = api.__demoFuse();
  if (r.error) throw new Error('打出失败：' + r.error);
  if (!r.highlighted) throw new Error('队友所在格没被算成合法落点（界面不高亮，玩家不知道该点哪）');
  if (!r.fused) throw new Error('点了队友但没融合：' + r.beforeName + ' 还在');
  if (r.afterName === r.beforeName) throw new Error('融合后场上还是原来那张牌');
});

check('单位「打出:」需要指定目标时，界面会停下来让玩家点', () => {
  if (typeof api.__demoUnitTarget !== 'function') throw new Error('缺少 __demoUnitTarget 钩子');
  const r = api.__demoUnitTarget();
  if (!r.pending) throw new Error('引擎没挂起 —— 玩家没机会指定目标，效果会被自动代答');
  if (r.type !== 'chooseUnit') throw new Error('应该请求选单位，实际是 ' + r.type);
  if (!r.options.length) throw new Error('请求里一个可选目标都没有');
  if (!r.hasMask) throw new Error('挂起了但界面上没渲染出选择面板');
});
