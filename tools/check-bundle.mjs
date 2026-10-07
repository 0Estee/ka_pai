/**
 * 打包产物集成测试（无浏览器）
 *
 * 做法：给一个最小 DOM 桩，把 app/dist/modules/ 下的脚本按依赖顺序求值，
 * 然后通过 window.__autoPlay 驱动「引擎 + AI + 渲染」整条链路跑完整局。
 *
 * 能抓到的问题：
 *   · 打包器漏剥 import/export 导致语法错误
 *   · 渲染函数在真实 state 上抛异常
 *   · AI 出牌越界 / 死循环
 *   · 引擎与 UI 对状态的假设不一致
 *
 * 用法：node tools/check-bundle.mjs
 *
 * 结构（2026-09 拆分，检查内容与输出完全不变）：
 *   tools/checks/harness.mjs   DOM 桩 + 按序加载 app/dist/modules/ + check / softCheck + 共享结果数组
 *   tools/checks/NN-*.mjs      每个 § 分组一个文件，**按下面 import 的先后顺序**执行
 *   本文件                     瘦入口：跑完各分组后打印统计与汇总，最后给退出码
 */

import { results, failures, warnings } from './checks/harness.mjs';

import './checks/01-home-render.mjs';
import './checks/02-screen-nav.mjs';
import './checks/03-enter-game.mjs';
import './checks/04-turn-loop.mjs';
import './checks/05-integrated-game.mjs';
import './checks/06-gold-level.mjs';
import './checks/07-replay.mjs';
import './checks/08-mp-lockstep.mjs';
import './checks/09-ai-difficulty.mjs';
import './checks/10-theme.mjs';
import './checks/11-choice.mjs';
import './checks/12-fusion-unit-target.mjs';
import './checks/13-lan-lobby.mjs';
import './checks/14-king-target.mjs';
import './checks/15-unit-detail.mjs';
import './checks/16-target-registry.mjs';
import './checks/17-combat-target.mjs';
import './checks/18-replay-choice.mjs';
import './checks/19-combat-fx.mjs';
import './checks/21-combat-start-trigger.mjs';
import './checks/20-combat-suspend.mjs';
import './checks/22-spell-banner.mjs';
import './checks/23-lan-choice.mjs';
import './checks/24-faction.mjs';
import './checks/25-summon-cell.mjs';
import './checks/26-stat-badge.mjs';
import './checks/27-battle-log.mjs';
import './checks/28-ui-fixes.mjs';
import './checks/29-motion.mjs';
import './checks/30-card-fx.mjs';

// ── 统计 ──────────────────────────────────────────────────
if (results.length) {
  const win = results.filter((r) => r.winner === 0).length;
  const lose = results.filter((r) => r.winner === 1).length;
  const draw = results.filter((r) => r.winner === 'draw').length;
  const avgTurn = results.reduce((a, r) => a + r.turn, 0) / results.length;
  const avgCards = results.reduce((a, r) => a + r.cardsPlayed, 0) / results.length;
  const avgKills = results.reduce((a, r) => a + r.unitsDestroyed, 0) / results.length;

  console.log('\n§ 统计（人类方由 AI 代打，仅验证链路，不代表平衡）');
  console.log(`  我方胜 ${win}   AI 胜 ${lose}   平局 ${draw}`);
  console.log(`  平均回合 ${avgTurn.toFixed(1)}   平均出牌 ${avgCards.toFixed(1)}   平均消灭 ${avgKills.toFixed(1)}`);
}

console.log(`\n${'─'.repeat(52)}`);
if (warnings.length) {
  console.log(`\n⚠ 有 ${warnings.length} 条统计型观测没达到预期（不挡构建，请写进报告）：`);
  for (const w of warnings) console.log(`   · ${w.name}\n     ${w.message.split('\n')[0]}`);
}

if (failures.length === 0) {
  console.log('✅ 打包产物集成测试全部通过');
  process.exit(0);
} else {
  console.log(`❌ ${failures.length} 项失败`);
  for (const f of failures) console.log(`   · ${f.name}\n     ${f.message.split('\n')[0]}`);
  process.exit(1);
}
