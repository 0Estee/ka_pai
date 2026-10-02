/** § 联机大厅：对手进来了，主机能不能点「开始对战」 */
import { api, check } from './harness.mjs';

console.log('\n§ 联机大厅：对手进来了，主机能不能点「开始对战」');

check('对手已连接时，「开始对战」必须可点（以前永远灰着 → 能进房间但开不了局）', () => {
  const r = api.__demoLobby('张三');
  if (r.startDisabled) {
    throw new Error('对手已经连上了，但「开始对战」还是 disabled —— 主机永远开不了局');
  }
  if (!r.showsPeer) throw new Error('大厅没有显示「已连接：张三」（对手名字没同步进界面状态）');
});

check('没有对手时，按钮保持不可点（对照）', () => {
  const r = api.__demoLobby('');
  if (!r.startDisabled) throw new Error('还没人进来就能开始，这条对照不成立');
});
