/** § 联机名字：玩家1（先手）/ 玩家2（后手），注册账号用账号名 */
import { api, elements, check } from './harness.mjs';

console.log('\n§ 联机名字');

function stageText() {
  return (elements.get('stage') ? elements.get('stage').innerHTML : '') || '';
}

check('主机侧：自己是玩家1先手，对手是玩家2后手，不再出现 AI', () => {
  api.__demoLanStart({ mySide: 0, myName: '张三', peerName: '李四' });
  api.__go('game');
  const html = stageText();
  if (!html.includes('张三')) throw new Error('状态条没有显示自己的账号名 张三');
  if (!html.includes('李四')) throw new Error('状态条没有显示对手的账号名 李四');
  if (!html.includes('先手') || !html.includes('后手')) throw new Error('没有标出先手 / 后手');
  if (/<b>AI<\/b>/.test(html)) throw new Error('联机状态条仍然把对手写成 AI');
  api.__demoLanEnd();
});

check('客人侧：座位仍是玩家2后手，名字按 hello 显示', () => {
  api.__demoLanStart({ mySide: 1, myName: '李四', peerName: '张三' });
  api.__go('game');
  const html = stageText();
  if (!html.includes('张三') || !html.includes('李四')) throw new Error('客人侧名字没有显示');
  if (/<b>AI<\/b>/.test(html)) throw new Error('客人侧仍然把对手写成 AI');
  api.__demoLanEnd();
});

check('没登录时退回玩家1 / 玩家2，不再叫 AI', () => {
  api.__demoLanStart({ mySide: 0, myName: '', peerName: '' });
  api.__go('game');
  const html = stageText();
  if (!html.includes('玩家1') || !html.includes('玩家2')) throw new Error('未登录时没有退回玩家1 / 玩家2');
  if (/<b>AI<\/b>/.test(html)) throw new Error('未登录联机仍然把对手写成 AI');
  api.__demoLanEnd();
});
