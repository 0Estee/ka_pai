/**
 * § 融合 / 融合进化 / 单位打出选目标
 *
 * 作者 2026-10-25 把「融合」和「融合进化」拆成了**两条词条**：
 *   融合     = D78 新口径：带融合的那张被消灭，另一边留在场上
 *   融合进化 = D34 原口径：队友「消失」、新牌顶替（不触发任何被消灭效果）
 * 两种打法都必须能在界面上点出来（点场上的队友就是落点），这里各验一遍。
 */
import { api, check } from './harness.mjs';

console.log('\n§ 融合进化 / 单位打出选目标（作者 2026-09 报的两个 bug）');

check('融合：点场上的队友就能把融合牌打到他身上（队友留在场上，融合牌被消灭）', () => {
  if (typeof api.__demoFuse !== 'function') throw new Error('缺少 __demoFuse 钩子');
  const r = api.__demoFuse();
  if (r.error) throw new Error('打出失败：' + r.error);
  if (!r.highlighted) throw new Error('队友所在格没被算成合法落点（界面不高亮，玩家不知道该点哪）');
  if (!r.keptAlly) throw new Error('融合后队友不该消失：' + r.beforeName + ' → ' + r.afterName);
  if (!r.fuseCardDiscarded) throw new Error('融合牌自己应当算作被消灭（进弃牌堆）');
});

check('融合进化：点场上的队友开打 —— 队友「消失」（进弃牌堆）、新牌顶替', () => {
  if (typeof api.__demoFuse !== 'function') throw new Error('缺少 __demoFuse 钩子');
  const r = api.__demoFuse('evolve');
  if (r.error) throw new Error('打出失败：' + r.error);
  if (r.kind !== 'evolve') throw new Error('演示用的词条不对：' + r.kind);
  if (!r.highlighted) throw new Error('队友所在格没被算成合法落点');
  if (r.keptAlly) throw new Error('融合进化后队友应当「消失」并被新牌顶替');
  if (!r.allyVanished) throw new Error('被顶掉的队友应当进弃牌堆');
});

check('单位「打出:」需要指定目标时，界面会停下来让玩家点', () => {
  if (typeof api.__demoUnitTarget !== 'function') throw new Error('缺少 __demoUnitTarget 钩子');
  const r = api.__demoUnitTarget();
  if (!r.pending) throw new Error('引擎没挂起 —— 玩家没机会指定目标，效果会被自动代答');
  if (r.type !== 'chooseUnit') throw new Error('应该请求选单位，实际是 ' + r.type);
  if (!r.options.length) throw new Error('请求里一个可选目标都没有');
  if (!r.hasMask) throw new Error('挂起了但界面上没渲染出选择面板');
});
