/** § 整合对局（AI 接管双方，跑完整局）—— 组内跑出的 results 供最后 § 统计 汇总 */
import { api, check, results } from './harness.mjs';

console.log('\n§ 整合对局（AI 接管双方，跑完整局）');

/** 本节的局数：§ 金币与等级 / § 回放 也按它断言，所以导出给它们 import */
export const N = 30;

let crashes = 0;

for (let i = 0; i < N; i++) {
  api.__newGame();
  const r = api.__autoPlay();
  if (r.error) {
    crashes++;
    console.error(`  ✗ 第 ${i + 1} 局出错: ${r.error}`);
    break;
  }
  if (!r.htmlOk) {
    crashes++;
    console.error(`  ✗ 第 ${i + 1} 局渲染异常（htmlLength=${r.htmlLength}）`);
    break;
  }
  results.push(r);
}

check(`${N} 局全部跑完且渲染正常`, () => {
  if (crashes > 0) throw new Error(`有 ${crashes} 局出错`);
  if (results.length !== N) throw new Error(`只完成 ${results.length}/${N} 局`);
});

check('所有对局都正常终局（无卡死）', () => {
  const stalled = results.filter((r) => r.stalled || r.winner === null);
  if (stalled.length) throw new Error(`${stalled.length} 局未终局`);
});

check('终局结果只有 胜/负/平 三种', () => {
  for (const r of results) {
    if (![0, 1, 'draw'].includes(r.winner)) throw new Error(`异常 winner: ${r.winner}`);
  }
});

check('渲染输出有合理体积（不是空白页）', () => {
  const min = Math.min(...results.map((r) => r.htmlLength));
  if (min < 1200) throw new Error(`最小渲染体积仅 ${min} 字节，疑似渲染失败`);
});
