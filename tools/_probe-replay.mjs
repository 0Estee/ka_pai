/** 临时探针：验证「出牌需要选目标 / 需要抉择」时，回放能不能精确重演 */
import { api } from './checks/harness.mjs';

const state = () => api.__game();

function dump(tag) {
  const s = state();
  console.log(`--- ${tag} ---`);
  console.log('  phase', s.phase, 'turn', s.turn,
    'pending', s.pending ? s.pending.request.type : null,
    'auto', s.autoResolveChoices,
    'mana', s.players[0].mana);
}

/** 造一个「轮到我出锦囊/单位」的干净场面 */
function setup(cardId, phase) {
  api.__newGameFirst();
  api.__place(1, 'W03', 'plainL', 'front');
  const s = state();
  s.phase = phase;
  s.players[0].manaCap = 20;
  s.players[0].mana = 20;
  const iid = s.nextIid++;
  s.players[0].hand.push({ iid, cardId });
  return iid;
}

console.log('\n===== 场景 A：锦囊需要点选敌方目标（攻击 U01）=====');
{
  const iid = setup('U01', 'SPELL_FIRST');
  dump('出牌前');
  const foeUid = state().board.plainL.units[1].front.uid;
  api.commitPlay(iid, { targetUid: foeUid });
  dump('出牌后');
  console.log('  录制动作:', JSON.stringify(api.__recordingActions()));
  console.log('  重放:', JSON.stringify(api.__replayVerifyLive()));
}

console.log('\n===== 场景 B：单位带「抉择」（歼-10 U393）=====');
{
  const iid = setup('U393', 'DEPLOY_FIRST');
  dump('出牌前');
  api.commitPlay(iid, { lane: 'mountain', row: 'front' });
  dump('出牌后');
  console.log('  录制动作（抉择前）:', JSON.stringify(api.__recordingActions()));
  if (state().pending) {
    const rq = state().pending.request;
    console.log('  挂起请求:', rq.type, JSON.stringify((rq.options || []).map((o) => o.label)));
    api.__nav('choose-option', { idx: 1, id: '1' });
  }
  dump('抉择后');
  console.log('  录制动作（抉择后）:', JSON.stringify(api.__recordingActions()));
  console.log('  重放:', JSON.stringify(api.__replayVerifyLive()));
}

console.log('\n===== 场景 C：打出后引擎反问的锦囊（每张需要点选的锦囊都试一遍）=====');
{
  const lib = api.__game().cardLib;
  const ids = Object.keys(lib).filter((id) => {
    const d = lib[id];
    if (d.type !== 'spell') return false;
    return (d.actions || []).some((a) => {
      const k = a.target && a.target.kind;
      return k === 'chosenEnemyUnit' || k === 'chosenOwnUnit' || k === 'chosenEnemyTarget';
    });
  });
  console.log('  需要点选目标的锦囊:', ids.join(', '));
  for (const id of ids.slice(0, 4)) {
    api.__newGameFirst();
    api.__place(1, 'W03', 'plainL', 'front');
    api.__place(0, 'W03', 'mountain', 'front');
    const s = state();
    s.phase = 'SPELL_FIRST';
    s.players[0].manaCap = 30;
    s.players[0].mana = 30;
    const iid = s.nextIid++;
    s.players[0].hand.push({ iid, cardId: id });
    const def = s.cardLib[id];
    // 猜一个合法目标参数（引擎会做最终校验）
    const foeUid = s.board.plainL.units[1].front.uid;
    try {
      api.commitPlay(iid, { targetUid: foeUid });
      const pend = state().pending;
      if (pend) {
        const rq = pend.request;
        console.log(`  ${id} ${def.name}: 挂起 ${rq.type}，选项 ${JSON.stringify((rq.options || []).map((o) => o.label || o.uid))}`);
        api.__nav('choose-option', { idx: 0, id: '0' });
      }
      console.log(`  ${id} ${def.name}: 动作 ${JSON.stringify(api.__recordingActions())} 重放 ${JSON.stringify(api.__replayVerifyLive())}`);
    } catch (err) {
      console.log(`  ${id} ${def.name}: 出牌失败 ${err.message}`);
    }
  }
}
