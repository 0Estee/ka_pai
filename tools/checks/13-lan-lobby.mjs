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

check('大厅里也能选阵营（以前只有难度页有，联机只能被主机安排）', () => {
  const r = api.__demoLobby('张三');
  if (!r.factionRows) throw new Error('大厅里没有阵营选项（联机阵营选不了）');
  if (r.factionRows !== 6) throw new Error('阵营选项应当是 6 个，实际 ' + r.factionRows);
});

check('联机认输会作为一条操作交给会话发出去（对手那边要跟着结算）', () => {
  const r = api.__demoSurrender(0);
  api.__nav('surrender', {});
  const st = api.__game();
  const sent = r.sent.slice();
  const winner = st.winner;
  const reason = st.winReason;
  r.finish();
  if (sent.length !== 1) throw new Error('认输没有作为操作交给会话（对手收不到，所以不结算）：' + JSON.stringify(sent));
  if (sent[0].k !== "s" || sent[0].s !== 0) throw new Error('认输操作应当是 {k:s, s:0}，实际 ' + JSON.stringify(sent[0]));
  if (winner !== 1) throw new Error('认输后应当判对方胜（winner=1），实际 ' + winner);
  if (reason !== '一方认输') throw new Error('终局文案必须两端一致（锁步逐字节比状态），实际：' + reason);
});
