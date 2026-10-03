/**  提示条：锦囊的放大展示 + 伤害掉字不被裁掉（作者 2026-10 报的两条界面问题） */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, api, elements, timers, check } from './harness.mjs';

console.log('\n 提示条：锦囊放大展示与伤害掉字');

/**
 * 打出一张能指定敌方国王、且带效果文本的锦囊，走玩家实际点的那两下（选牌 -> 点国王）。
 * 为什么要走这条路：横幅是 flashPlayPresentation 在对局通道里弹出的，
 * 直接调 showBanner 测不到「谁在什么时候弹了什么」。
 */
function playSpellOnKing() {
  api.__go('home');
  api.__newGame();
  api.__pause(true);
  // 挑一张有卡面文本、且能指定敌方国王的锦囊：横幅第二行要显示它的效果文本。
  // 不能用 __demoKingTarget 的 U01：攻击这张卡在卡定义里没有 text 字段，横幅第二行会是空的。
  const lib = Object.values(api.__game().cardLib);
  const cands = lib.filter((d) => d && d.type === 'spell' && d.text && (d.actions || []).some((a) => JSON.stringify(a).includes('chosenEnemyTarget')));
  const def = cands.find((d) => !JSON.stringify(d.actions).includes('allowKing')) || cands[0];
  if (!def) throw new Error('卡库里找不到能指定敌方国王、且带效果文本的锦囊');
  api.__demoHand([def.id]);
  api.selectCard(api.__game().players[0].hand[0].iid);
  const foe = 1;
  if (typeof api.handleKingClick !== 'function') {
    throw new Error('打包作用域里拿不到 handleKingClick（顶层函数应当被暴露到同一个作用域）');
  }
  api.handleKingClick(foe);
  return { foe, name: def.name };
}

check('锦囊打出后横幅是「卡名 + 效果文本」两行，不会把标签字样显示给玩家', () => {
  const { foe, name } = playSpellOnKing();
  const html = elements.get('stage').innerHTML;
  const at = html.indexOf('class="banner"');
  if (at < 0) throw new Error('打出锦囊后没有渲染出横幅');
  const end = html.indexOf('</div>', at);
  const banner = html.slice(at, end < 0 ? at + 400 : end);
  if (!banner.includes(name)) throw new Error('横幅里没有卡名：' + banner.slice(0, 120));
  if (!banner.includes('<small>')) throw new Error('横幅里没有小字第二行（效果文本应当是 small 元素）：' + banner.slice(0, 160));
  if (banner.includes('&lt;small&gt;')) throw new Error('横幅把 small 标签当成文本转义显示了（这正是作者报的问题）');
  const st = api.__game();
  if (!st.log.some((e) => e.type === 'king-damage' && e.side === foe)) throw new Error('这发锦囊没有打到国王，场面不成立');
});

check('源码里不再把 HTML 标签塞进横幅文本（showBanner 走第三个参数）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'js', 'game-flow.js'), 'utf8');
  const bad = [];
  let i = -1;
  while ((i = src.indexOf('showBanner(', i + 1)) >= 0) {
    const seg = src.slice(i, i + 220);
    if (seg.includes('<small')) bad.push(seg.slice(0, 70));
  }
  if (bad.length) throw new Error('横幅调用把标签塞进了文本，应改成第三个参数：' + bad.join(' | '));
  const third = (src.match(/, 2000, /g) || []).length;
  if (third < 3) throw new Error('三处横幅（陷阱触发 / 已埋伏 / 锦囊效果）应当都传第二个文本参数，实际只有 ' + third + ' 处');
});

check('掉字不会被格子裁掉，也不会被相邻格子盖住', () => {
  // 先剥掉 CSS 注释：注释里写着 overflow: hidden 这样的字眼会误伤下面的断言。
  const rawCss = fs.readFileSync(path.join(ROOT, 'app', 'style.css'), 'utf8');
  // strip CSS comments first (a comment may itself mention overflow: hidden); no regex needed
  const css = rawCss.split('/*').map((part, i) => (i === 0 ? part : part.slice(part.indexOf('*/') + 2))).join('');
  const slotAt = css.indexOf('.slot {');
  if (slotAt < 0) throw new Error('找不到 .slot 样式块');
  const slotBlock = css.slice(slotAt, css.indexOf('}', slotAt));
  if (slotBlock.includes('overflow: hidden')) {
    throw new Error('.slot 又在裁剪了（掉字一飘出格子就被切掉，作者 2026-10 报的遮挡就是它）：' + slotBlock.replace(/\s+/g, ' '));
  }
  const floatAt = css.indexOf('.fx-float {');
  if (floatAt < 0) throw new Error('找不到 .fx-float 样式块');
  const floatBlock = css.slice(floatAt, css.indexOf('}', floatAt));
  const m = floatBlock.match(/z-index:\s*(\d+)/);
  if (!m) throw new Error('.fx-float 没有 z-index：相邻格子的背景会盖住掉字');
  if (Number(m[1]) < 2) throw new Error('.fx-float 的 z-index 太小：' + m[1]);
});


function pumpTimers(rounds) {
  for (let i = 0; i < rounds; i++) {
    const pending = [...timers.entries()];
    if (!pending.length) break;
    for (const [id, t] of pending) {
      timers.delete(id);
      try { t.fn(); } catch { /* 桩里其它定时器抛错不影响这条断言 */ }
    }
  }
}

/** 只把「横幅自己 2 秒后消失」这件事提前，别把特效那条长定时器也一起烧掉 */
function fireBannerTimer() {
  for (const [id, t] of [...timers.entries()]) {
    if (t.ms === 2000) { timers.delete(id); try { t.fn(); } catch { /* 忽略 */ } }
  }
}

/** HTML 里那条横幅的片段（避免把陷阱格上的字样也算进来） */
function bannerBlock(html) {
  const at = html.indexOf('class="banner');
  if (at < 0) return '';
  const end = html.indexOf('</div>', at);
  return html.slice(at, end < 0 ? at + 240 : end);
}

/** 只烧掉指定时长的定时器（别把横幅那条 2 秒的也烧了，否则看不到横幅） */
function fireMs(...durations) {
  for (const [id, t] of [...timers.entries()]) {
    if (durations.includes(t.ms)) { timers.delete(id); try { t.fn(); } catch { /* 忽略 */ } }
  }
}

check('AI 打出锦囊也会放大展示（作者报的「敌方使用锦囊时没有提示」）', () => {
  // AI 出牌走 tick 的 AI 分支（aiTakeTurn），和玩家的 commitPlay 是两条路，要单独守一条。
  // 不同锦囊 AI 的评估分数不同（有的它根本不肯打），所以逐个候选试到有一张真打出来为止。
  api.__go('home');
  api.__newGame();
  const lib = Object.values(api.__game().cardLib);
  const cands = lib.filter((d) => d && d.type === 'spell' && d.text && !d.token && !(d.keywords || []).includes('trap'));
  const tried = [];
  for (const def of cands) {
    if (typeof api.setDifficulty === 'function') api.setDifficulty('normal');
    api.__go('home');
    api.__pause(true);
    api.__newGame();
    api.__pause(true);
    // startNewGame 里可能已经排了自动阶段定时器：清干净，否则它会在我们摆完场面之后乱推
    // 开局可能已经排了自动阶段定时器（清掉，否则它会在我们摆完场面之后乱推），
    // 但**横幅**（2600ms）要照常触发：不清掉它，下面断言「AI 的锦囊横幅」时
    // 看到的还是开局那条「抽到超能力」的横幅。
    for (const [id, t] of [...timers.entries()]) {
      timers.delete(id);
      if (t.ms >= 2000) { try { t.fn(); } catch { /* 忽略 */ } }
    }
    const st = api.__game();
    st.humanSide = 0;
    st.players[0].hand.length = 0;
    st.players[1].hand.length = 0;
    st.players[1].hand.push({ iid: st.nextIid++, cardId: def.id });
    st.players[1].mana = 9;
    st.players[1].manaCap = 9;
    // 摆到「真人的那个阶段」，结束它就轮到 AI（走的是真实路由，不是直接调 AI 函数）
    st.phase = st.firstPlayer === 0 ? 'SPELL_FIRST' : 'DEPLOY_SECOND';
    api.__pause(false);
    api.__nav('end', {});
    fireMs(420); // AI 思考 420ms：出牌 -> presentCasts()
    const st2 = api.__game();
    if (!st2.log.some((e) => e && e.type === 'cast' && e.side === 1)) { tried.push(def.name); continue; }
    const banner = bannerBlock(elements.get('stage').innerHTML);
    if (!banner) throw new Error('AI 打出了锦囊「' + def.name + '」但棋盘上没有横幅');
    if (!banner.includes(def.name)) throw new Error('横幅里不是 AI 刚打出的那张锦囊：' + def.name + ' / ' + banner.slice(0, 90));
    api.__pause(true);
    return;
  }
  throw new Error('遍历 ' + cands.length + ' 张带文本的锦囊，AI 一张都不肯打（试过 ' + tried.length + ' 张）');
});

check('横幅的入场动画只播一次：重渲染之后不会又弹一遍', () => {
  // 作者 2026-10：在自动结束回合的同时按下结束回合，锦囊提示会多次出现。
  // 根因是 refresh() 整块重建 #stage，每重渲染一次入场动画就重启一次。
  const { name } = playSpellOnKing();
  const first = elements.get('stage').innerHTML;
  if (!bannerBlock(first)) throw new Error('打出锦囊后没有横幅');
  if (first.includes('banner-rest')) throw new Error('第一次渲染就带了 banner-rest，入场动画根本不会播');
  if (typeof api.refresh !== 'function') throw new Error('打包作用域里拿不到 refresh');
  // 动画播完之后标记才会关（220ms）；先把那个定时器烧掉，再重渲染一次
  for (const [id, t] of [...timers.entries()]) {
    if (t.ms <= 300) { timers.delete(id); try { t.fn(); } catch { /* 忽略 */ } }
  }
  api.refresh(); // 模拟战斗特效步进 / tick / 任何一次重渲染
  const again = elements.get('stage').innerHTML;
  if (!again.includes('banner-rest')) {
    throw new Error('重渲染之后横幅又带上了入场动画，玩家看到的就是「提示反复出现」');
  }
  if (!bannerBlock(again).includes(name)) throw new Error('重渲染之后横幅内容丢了：' + name);
});

check('陷阱触发的横幅不会在之后的推进里重复弹出', () => {
  // 以前 flashPlayPresentation 是「回看最后 4 条日志找 trap-triggered」，
  // 那条还在窗口里的时候，之后每一次出牌/推进都会再弹一次同一个横幅。
  api.__go('home');
  api.__newGame();
  api.__pause(true);
  const st = api.__game();
  st.humanSide = 0;
  api.__demoHand(['U371']); // 反应装甲：目前唯一的陷阱卡
  const iid = st.players[0].hand[st.players[0].hand.length - 1].iid;
  st.players[0].mana = 9;
  st.players[0].manaCap = 9;
  st.phase = st.firstPlayer === 0 ? 'DEPLOY_FIRST' : 'DEPLOY_SECOND';
  api.commitPlay(iid, {}); // 埋伏：陷阱不受阶段类型限制
  api.__place(1, 'W04', 'mountain', 'front');
  api.__place(0, 'W02', 'mountain', 'front');
  let n = 0;
  while (api.__game().phase !== 'COMBAT' && n++ < 14) api.__advance();
  api.__advance(); // 对手打过来 -> 陷阱触发
  const html1 = elements.get('stage').innerHTML;
  if (!bannerBlock(html1).includes('陷阱触发')) {
    throw new Error('陷阱触发了却没有横幅（场面可能不成立）');
  }
  fireBannerTimer(); // 让这条横幅自己消失（2 秒）
  api.__pause(false);
  api.__advance(); // 再推进一次：这一步以前会把同一条陷阱横幅再弹一遍
  const html2 = elements.get('stage').innerHTML;
  if (bannerBlock(html2).includes('陷阱触发')) {
    throw new Error('同一个陷阱触发被重复展示了（作者报的「锦囊提示会多次出现」）');
  }
  api.__pause(true);
  api.__newGame();
});
