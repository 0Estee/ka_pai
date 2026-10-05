/**
 *  0.46.0 三处界面修复（作者 2026-10-05 报的）
 *
 * 1. 回放里打开「战报 / 菜单」不该出现「重新开局」「认输」回放是只读的，
 *    点了会把 screen 拉回对局、把正在看的那条回放踢掉。
 * 2. 浏览器里打开联机模式，提示装的是「APK」，不是笔误的「PPK」。
 * 3. 对局终局要**立刻**结算金币：以前终局分支排在演出闸后面，
 *    打死国王那一下的伤害演出没播完就不结算，金币与结算面板都要晚好几秒。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, api, elements, check } from './harness.mjs';

console.log('\n 0.46.0 界面修复（回放菜单 / 安装包文案 / 终局立刻结算）');

const stageHTML = () => (elements.get('stage') && elements.get('stage').innerHTML) || '';

function openSomeReplay() {
  api.__go('home');
  let r = api.__replayDemo(0, 3);
  if (r.error) { api.__autoPlay(); r = api.__replayDemo(0, 3); }
  if (r.error) throw new Error('拿不到一条回放：' + r.error);
  if (r.screen !== 'replay') throw new Error('没有进入回放画面，实际 ' + r.screen);
  return r;
}

check('回放里打开战报菜单：不给「重新开局」和「认输」', () => {
  openSomeReplay();
  const m = api.__menuLog(true);
  if (!m.html || !m.html.includes('战报')) throw new Error('回放里没打开战报菜单');
  if (m.html.includes('data-act="restart"')) throw new Error('回放菜单里还有「重新开局」按钮');
  if (m.html.includes('data-act="surrender"')) throw new Error('回放菜单里还有「认输」按钮');
  api.__menuLog(false);
  api.__go('home');
});

check('对局里打开战报菜单：这两个按钮还在', () => {
  api.__newGame();
  api.__go('game');
  const m = api.__menuLog(true);
  if (!m.html.includes('data-act="restart"') || !m.html.includes('data-act="surrender"')) {
    throw new Error('对局菜单里少了「重新开局」或「认输」');
  }
  api.__menuLog(false);
  api.__go('home');
});

check('回放里点「重新开局」「认输」也不生效（兜底守卫）', () => {
  openSomeReplay();
  api.__nav('restart', {});
  if (api.__screen() !== 'replay') throw new Error('回放里「重新开局」把画面切走了：' + api.__screen());
  api.__nav('surrender', {});
  if (api.__screen() !== 'replay') throw new Error('回放里「认输」把画面切走了：' + api.__screen());
  api.__go('home');
});

check('浏览器里的联机页提示「安装 APK」，不是 PPK', () => {
  try { if (api.KapaiNative) delete api.KapaiNative; } catch (e) { /* stub */ }
  api.__go('lan');
  const html = stageHTML();
  if (html.includes('PPK')) throw new Error('联机页还写着 PPK（笔误，应为 APK）');
  if (!html.includes('安装 APK')) throw new Error('联机页没有「安装 APK」的提示（当前环境不支持局域网时应当显示）');
  api.__go('home');
});

check('终局分支排在演出闸之前（金币不会等演出播完）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app/js/game-flow.js'), 'utf8');
  const iWinner = src.indexOf('if (state.winner !== null) {');
  const iFx = src.indexOf('if (view.fx || view.fxTimer');
  if (iWinner < 0) throw new Error('找不到终局分支');
  if (iFx < 0) throw new Error('找不到演出闸');
  if (iWinner > iFx) throw new Error('终局分支排在演出闸后面：金币要等演出播完才结算');
  const iSettle = src.indexOf('settleIfNeeded();');
  if (iSettle < 0 || iSettle > iFx) throw new Error('settleIfNeeded() 没有排在演出闸之前');
});
