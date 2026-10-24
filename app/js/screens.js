/**
 * 首页 / 设置 / 回放列表 / 回放播放器 的 HTML 渲染。
 *
 * 与 ui.js 同样的思路：纯函数，输入数据输出 HTML 字符串，不持有状态。
 * 状态由 main.js 的 `view` 持有，事件用 data-act 委托给 main.js。
 *
 * 注意：**不要用 alert / confirm / prompt**。Android WebView 里
 * 默认的 WebChromeClient 不会实现它们（会静默返回 false），
 * 删除确认这类交互一律在页面内做。
 */

import { incompatibleReason } from './replay.js';
import {
  fmtNum, enhanceGoldCost, masteryDustCost, ENHANCE_MAX, MASTERY_MAX, SKILL_BY_ID, RARITY,
} from './enhance.js';
/**
 * HTML 转义只有一个实现，在 ui.js —— 打包器把各模块拍进同一作用域，
 * 再写第二份同名常量会直接报重名。
 */
import { esc } from './ui.js';
// 等级是由表现分推算出来的（economy.levelFor），管理后台要让管理员看到「这么多数是几级」
import { levelFor } from './economy.js';

/** 版本号（改版本时和 tools/build-apk.ps1 一起改） */
export const APP_VERSION = '0.69.0';

/**
 * 把毫秒时间戳格式化成「YYYY-MM-DD HH:mm」。
 *
 * 入参来自回放档案的 startedAt / endedAt（replay.js 写入，见那边的 newRecording）。
 * 旧档案没这两个字段、或录制还没收尾时它们是 undefined —— 这里的 `!ts` 兜底
 * 直接返回空串，而不是让 `new Date(undefined)` 渲染出一个 `Invalid Date` 摆在列表里。
 */
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// ══════════════════════════════════════════════════════════
// 开始游戏：二级菜单（AI 对决 / 局域网对决）
// ══════════════════════════════════════════════════════════

//  菜单入场动画的方向标记 
// 由 render.js 在屏幕切换时设置：'forward'（前进，从右侧滑入）/ 'back'（返回，从左侧滑入）/ ''（同屏刷新，不做动画）。
// 标记是渲染时写在容器上的 data-nav 属性，而不是挂在 #stage 的类上：
// 同一屏幕的后续刷新会重新生成 HTML，挂在类上的话动画会从头重放一遍
// （作者 2026-10-05 反馈的「卡一下、动画过快」）。属性只在切换那一次渲染里出现，所以只播一次。
let NAV_DIR = '';
export function setNavDir(dir) {
  NAV_DIR = dir === 'back' ? 'in-left' : dir === 'forward' ? 'in-right' : '';
}
const navAttr = () => (NAV_DIR ? ' data-nav="' + NAV_DIR + '"' : '');

/** 通用：带返回按钮的二级页面外壳（管理后台要回账户页，所以 backAct 可覆盖） */
function subScreen(title, body, backAct = 'back-home') {
  return `
  <div class="screen"${navAttr()}>
    <div class="screen-head">
      <button class="btn-back" data-act="${backAct}">‹ 返回</button>
      <h1>${esc(title)}</h1>
    </div>
    <div class="screen-body">${body}</div>
  </div>`;
}

export function playMenuHTML({ difficulty, lanSupported, profile }) {
  const d = difficulty || { name: '普通', tagline: '' };
  const dust = (profile && profile.dust) || 0;
  return subScreen('开始游戏', `
    <button class="hm-btn hm-primary" data-act="choose-ai">
      <span class="hm-text">AI 对决</span>
      <span class="hm-sub">${esc(d.name)}</span>
    </button>
    <button class="hm-btn" data-act="lan-menu">
      <span class="hm-text">联机对决</span>
      <span class="hm-sub">公网房间号，或同一 Wi-Fi 下两台设备</span>
    </button>
    <button class="hm-btn" data-act="start-sandbox">
      <span class="hm-text">靶场</span>
      <span class="hm-sub">试卡用：任意摆牌、超能力全发、换边换阵营</span>
    </button>
    ${lanSupported ? '' : '<div class="set-tip">当前环境不支持联机（需要在手机 App 里运行，或从线上地址打开）</div>'}
    <div class="set-tip">普通模式：双方都用卡面原值，强化与精通不生效。</div>
  `);
}

/**
 * 强化模式（作者 2026-10-17：单独一个模式，和普通模式分开）。
 *
 * 进来的每一局都会读取档案里的强化/精通；AI 也会按难度强化自己的牌。
 * 工坊也放在这里 —— 强化是这套模式的东西，不该混进普通模式的菜单。
 */
export function forgeMenuHTML({ difficulty, lanSupported, profile }) {
  const dust = (profile && profile.dust) || 0;
  const gold = (profile && profile.gold) || 0;
  return subScreen('强化模式', `
    <div class="forge-mode-tip">这一模式里，你的强化 / 精通会真正生效；AI 也会按难度强化它的牌。<br>
      普通模式不受影响 —— 两边完全分开。</div>
    <button class="hm-btn hm-primary" data-act="choose-ai">
      <span class="hm-text">强化 AI 对决</span>
      <span class="hm-sub">${esc((difficulty && difficulty.name) || '普通')}</span>
    </button>
    <button class="hm-btn" data-act="lan-menu">
      <span class="hm-text">强化 联机对决</span>
      <span class="hm-sub">双方各自带上自己的强化卡组</span>
    </button>
    <button class="hm-btn" data-act="start-sandbox">
      <span class="hm-text">靶场</span>
      <span class="hm-sub">试卡用：任意摆牌、超能力全发，强化与精通在这里生效</span>
    </button>
    <button class="hm-btn" data-act="open-forge">
      <span class="hm-text">强化工坊</span>
      <span class="hm-sub">金币 ${gold} · 星尘 ${dust}</span>
    </button>
    ${lanSupported ? '' : '<div class="set-tip">当前环境不支持联机（需要在手机 App 里运行，或从线上地址打开）</div>'}
  `);
}

export function difficultyHTML({ current, difficulties, faction, factions, mode, openFaction = '' }) {
  const cur = difficulties.find((d) => d.key === current) || difficulties[0] || { name: '' };
  // 选中那行不再额外挂一个 ✓：选中态已经由 .diff-row.on 的金边 + 高一档底色说全了，
  // 再补一个勾是同一条信息的第二个信号（CSS 里 .diff-check 的样式上轮也撤了，
  // 那行注释写得很清楚——「第三个金色信号只会让这一行更吵」）。删掉它，DOM 少一层。
  const rows = difficulties.map((d) => {
    const on = d.key === current;
    const cheat = d.bonus
      ? `<div class="diff-cheat">额外优势：${[
        d.bonus.hand ? `起手多 ${d.bonus.hand} 张` : '',
        d.bonus.manaPerTurn ? `每回合多 ${d.bonus.manaPerTurn} 费` : '',
        d.bonus.kingHp ? `国王 +${d.bonus.kingHp} 生命上限` : '',
      ].filter(Boolean).join('  ')}</div>`
      : '';
    return `
      <button class="diff-row ${on ? 'on' : ''}" data-act="set-difficulty" data-key="${d.key}">
        <div class="diff-main">
          <div class="diff-name">${esc(d.name)}</div>
          <div class="diff-tag">${esc(d.tagline)}</div>
          ${cheat}
        </div>
      </button>`;
  }).join('');

  // 阵营（作者 2026-10-03）：对局开始前自选，本局可用该阵营的超能力。
  const facList = factions && factions.length ? factions : [];
  const curFac = facList.find((f) => f.key === faction) || facList[0] || null;
  /**
   * 阵营行：点一下就是「选它」，长按 / 点右边的「介绍」展开说明（作者 2026-10-22 第 4 条）。
   *
   * 展开的是**这一段文字**，不是弹窗：手机上弹窗一大块会盖住整个难度页，
   * 而作者要的是「边看边选」。展开状态存在 main.js 的 view.facOpen 里，
   * 换一个阵营只换高亮，不会把已经展开的那一段收起来。
   */
  const facRows = facList.map((f) => {
    const on = curFac && f.key === curFac.key;
    const open = f.key === openFaction;
    return `
      <div class="fac-item${open ? ' open' : ''}">
        <div class="fac-line">
          <button class="diff-row fac-row ${on ? 'on' : ''}" data-act="set-faction" data-key="${f.key}">
            <div class="diff-main">
              <div class="diff-name">${esc(f.name)}</div>
              <div class="diff-tag">${esc(f.tagline || '')}</div>
            </div>
          </button>
          <button class="fac-more${open ? ' on' : ''}" data-act="faction-info" data-key="${f.key}"
            aria-label="${esc(f.name)}的介绍">${open ? '收起' : '介绍'}</button>
        </div>
        ${open ? `<div class="fac-intro">
          ${(f.intro || []).length ? '' : `<p class="fac-intro-lead">${esc(f.tagline || '')}</p>`}
          ${(f.intro || []).map((line) => `<p class="fac-intro-line">${esc(line)}</p>`).join('')}
          ${(f.cards || []).length ? `<p class="fac-intro-cards">超能力 ${f.cards.length} 张：${esc(f.cards.join(' · '))}</p>` : ''}
        </div>` : ''}
      </div>`;
  }).join('');
  const facBlock = facRows ? `
    <div class="set-head">阵营（本局超能力）</div>
    <div class="diff-list">${facRows}</div>` : '';

  return subScreen(mode === 'forge' ? '强化模式 · AI 难度与阵营' : 'AI 难度与阵营', `
    ${mode === 'forge'
      ? '<div class="forge-mode-tip">强化模式：本局你会用强化 / 精通后的卡牌；AI 也会按难度强化它的牌。</div>'
      : ''}
    <div class="diff-list">${rows}</div>
    <div class="set-tip">难度主要影响 AI 的决策水平。<b>困难和噩梦</b>另外会多几张起手牌、国王血量更高（<b>但不会多费用</b>）；<b>不可能</b>不加任何优势，只是会真的推演后面几步，已在上方逐条写明。</div>
    ${facBlock}
    <button class="hm-btn hm-primary diff-go" data-act="start-ai">
      <span class="hm-ico"></span>
      <span class="hm-text">开始对战</span>
      <span class="hm-sub">${esc(cur.name)}${curFac ? '  ' + esc(curFac.name) : ''}</span>
    </button>
  `);
}

// ══════════════════════════════════════════════════════════
// 局域网
// ══════════════════════════════════════════════════════════

export function lanMenuHTML({ lanSupported, localIp, online, native = false }) {
  if (!lanSupported) {
    return subScreen('联机对决', `
      <div class="rp-empty">当前环境不支持联机<br><span>需要在手机上安装 APK，或用浏览器打开线上地址</span></div>
    `);
  }
  // 公网与局域网共用这一个菜单：对玩家来说都是「开一间房，把入口告诉对面」，
  // 只是对面拿到的是房间号还是一串内网地址。两种宿主同时可用时优先公网。
  const onlineOnly = online && !native;
  const hostSub = online ? '我来当主机 · 公网房间' : '我来当主机 · 同一 Wi-Fi';
  const joinSub = onlineOnly
    ? '输入主机大厅里显示的 6 位房间号'
    : (online ? '输入对面的房间号，或扫同一 Wi-Fi 下的房' : '扫描同一 Wi-Fi 下的房间');
  return subScreen('联机对决', `
    <button class="hm-btn hm-primary" data-act="lan-host">
      <span class="hm-ico">＋</span><span class="hm-text">创建房间</span>
      <span class="hm-sub">${hostSub}</span>
    </button>
    <button class="hm-btn" data-act="lan-scan">
      <span class="hm-ico">⌕</span><span class="hm-text">${onlineOnly ? '输入房间号' : '加入房间'}</span>
      <span class="hm-sub">${joinSub}</span>
    </button>
    <button class="hm-btn" data-act="watch-join">
      <span class="hm-ico">◎</span><span class="hm-text">观战</span>
      <span class="hm-sub">${online ? '输入房间号，进去只看不打' : '输入主机地址，进去只看不打'}</span>
    </button>
    <div class="hf-warn">主机中途退出会导致房间消失，对手将直接判负。</div>
    ${localIp ? `<div class="set-tip">本机地址：${esc(localIp)}</div>` : ''}
  `);
}

export function lanScanHTML({ rooms, scanning, manualError, online, native = false }) {
  // 手动兜底：UDP 广播在很多路由器上会被拦（「PP 隔离」/访客网络/企业 Wi-Fi），
  // 这时扫描永远是空的 —— 让玩家照抄主机屏幕上那串地址就能连上。
  // 公网房间则根本扫不到：房间不在同一网段，只能靠房间号。
  // 不能用 prompt()：WebView 里它是静默失效的（会什么都不发生），必须内嵌输入框。
  const manualTip = online
    ? '让主机把大厅里显示的<b>房间号</b>念给你，填在这里（也可以直接粘整条链接）：'
    : '搜不到房间？让主机把大厅里显示的那串地址念给你，填在这里：';
  const manualPh = online ? '例如 K7QM2P' : '例如 192.168.1.7:8765';
  const manual = `
    <div class="lan-manual">
      <div class="lan-manual-tip">${manualTip}</div>
      <input id="lan-manual-ip" class="lan-input" type="text" inputmode="${online ? 'text' : 'decimal'}"
             autocomplete="off" autocapitalize="${online ? 'characters' : 'off'}" spellcheck="false"
             placeholder="${manualPh}">
      <button class="rp-btn" data-act="lan-join-manual">加入</button>
      ${manualError ? `<div class="lan-err">${esc(manualError)}</div>` : ''}
    </div>`;

  // 公网站点没有原生桥：扫描永远为空。直接给房间号输入，不显示「找到 0 个」。
  if (online && !native) {
    return subScreen('加入房间', `
      <div class="rp-empty">公网房间不能扫描<br><span>房间在别的网络里，输入主机大厅里显示的 6 位房间号</span></div>
      ${manual}
    `);
  }

  if (scanning) {
    return subScreen('加入房间', `
      <div class="rp-empty">正在扫描同一 Wi-Fi 下的房间…</div>
      ${manual}
    `);
  }
  const list = rooms.length
    ? rooms.map((r) => `
      <button class="room-row ${r.started ? 'room-full' : ''}" data-act="lan-join"
              data-url="http://${esc(r.ip)}:${r.port}/?net=guest"
              ${r.started ? 'disabled' : ''}>
        <div class="room-main">
          <div class="room-name">${esc(r.room || '未命名房间')}</div>
          <div class="room-sub">${esc(r.ip)}:${r.port} · 主机 ${esc(r.host || '?')}</div>
        </div>
        <span class="room-badge">${r.started ? '已开始' : '可加入'}</span>
      </button>`).join('')
    : `<div class="rp-empty">${online ? '公网房间扫不到' : '没找到房间'}<br><span>${
      online
        ? '房间在别的网络里，只能靠房间号加入 —— 填下面的房间号'
        : '确认两台设备连的是同一个 Wi-Fi，且主机已经创建房间'
    }</span></div>`;

  return subScreen('加入房间', `
    <div class="rp-summary">找到 ${rooms.length} 个房间</div>
    ${list}
    <button class="rp-btn" data-act="lan-scan">重新扫描</button>
    ${manual}
  `);
}

/** 联机大厅：主机等对手，客人等主机开始 */
/**
 * 观战入口：和「加入房间」同一个输入框，只是进去以后是**只读**的。
 *
 * 说明里把三件事讲清楚（作者 2026-10-23）：
 *   · 不占座位：两个人照常对局，观战的人来几个都行
 *   · 看不到手牌：默认只画双方手牌张数（作者可以自己打开「公开手牌」）
 *   · 只读：点什么都不出牌
 */
export function watchJoinHTML({ online, native = false, manualError = '' } = {}) {
  const tip = online
    ? '把主机大厅里显示的<b>房间号</b>填在这里（也可以直接粘整条链接）：'
    : '让主机把大厅里显示的那串地址念给你，填在这里：';
  const ph = online ? '例如 K7QM2P' : '例如 192.168.1.7:8765';
  return subScreen('观战', `
    <div class="watch-hero">
      <div class="watch-hero-title">进去看，不占座位</div>
      <div class="watch-hero-line">双方照常对局；观战者只读——点什么都不出牌，也不影响胜负与金币。</div>
      <div class="watch-hero-line">默认看不到手牌（只显示张数），想看可以进去以后自己打开。</div>
    </div>
    <div class="lan-manual">
      <div class="lan-manual-tip">${tip}</div>
      <input id="watch-input" class="lan-input" type="text" inputmode="${online ? 'text' : 'decimal'}"
             autocomplete="off" autocapitalize="${online ? 'characters' : 'off'}" spellcheck="false"
             placeholder="${ph}">
      <button class="rp-btn" data-act="watch-enter">开始观战</button>
      ${manualError ? `<div class="lan-err">${esc(manualError)}</div>` : ''}
    </div>
    ${native ? '<div class="set-tip">同一 Wi-Fi 下：主机开好房间后，把「本机地址」那一行念给你。</div>' : ''}
  `);
}

/** 观战等待页：已经连上房间，等两位玩家开局 */
export function watchingHTML({ roomName, code, status, error, online }) {
  const stateText = status === 'closed'
    ? '连接已断开'
    : (status === 'reconnecting' ? '重连中…' : '等待这局开始…');
  return subScreen('观战中', `
    <div class="watch-room">
      <span class="watch-room-label">房间</span>
      <b class="watch-room-code">${esc(code || roomName || '—')}</b>
    </div>
    <div class="watch-status">${esc(stateText)}</div>
    <div class="set-tip">
      两位玩家进房并开局之后，画面会自动出来。<br>
      观战是只读的：不出牌、不结算金币，也不会影响对局。
    </div>
    ${error ? `<div class="lan-err">${esc(error)}</div>` : ''}
    <button class="rp-btn watch-exit" data-act="watch-exit">退出观战</button>
    ${online ? '<div class="set-tip">房间号不对？回上一页重新输入。</div>' : ''}
  `);
}

export function lobbyHTML({ mode, roomName, peerName, myName, discoverError, status, localIp, port, gameReady, gold, canPvp, faction, factions, forgeMode, peerForge, online, joinUrl, code, watchers = 0 }) {
  const isHost = mode === 'host';
  const seat = isHost ? '玩家1' : '玩家2';
  const seatRole = myName && myName !== seat ? `${myName}（${seat} · ${isHost ? '主机' : '客人'}）` : `${seat}（${isHost ? '主机' : '客人'}）`;
  const statusText = {
    connected: peerName ? `已连接：${peerName}` : '等待对手加入…',
    reconnecting: '连接中断，正在等待重连…',
    closed: '对方已离开',
  }[status] || status;

  // 主机要把「对面怎么进来」告诉玩家：
  //  · 公网：房间号（口念六个字符）+ 完整链接（微信里发过去就能点）
  //  · 局域网：内网地址（靠扫描或手抄）
  //
  // 房间号和链接各自占一行：链接是一串没有空格的字符，混在句子里一定会顶出卡片
  // （作者截图看到的就是右侧被裁掉的半截 URL）。分成块级元素后，长链接在自己那行里折行。
  const lanUrl = !online && isHost && localIp ? `http://${localIp}:${port}/` : '';
  const invite = online && code
    ? `<div class="lobby-url">
         <div>把这个房间号念给对面：</div>
         <b class="lobby-code">${esc(code)}</b>
         <div class="lobby-link-tip">或者把这串地址发给他：</div>
         <b class="lobby-link">${esc(joinUrl || '')}</b>
       </div>`
    : (isHost && lanUrl
      ? `<div class="lobby-url">同一 Wi-Fi 下的另一台设备可以扫描到这个房间，<br>或直接访问 <b>${esc(lanUrl)}</b></div>`
      : '');

  /**
   * 阵营（作者 2026-10-05：联机选不了阵营）。
   *
   * 以前阵营选择只在「AI 难度与阵营」页里，联机开局用的是主机的 myFaction，
   * 客人既看不到也选不了。这里复用同一套 set-faction 行，两边各自在房间里选，
   * 换一次广播一次（见 play-input.js）。
   */
  const facList = factions && factions.length ? factions : [];
  const curFac = facList.find((f) => f.key === faction) || facList[0] || null;
  const facRows = facList.map((f) => {
    const on = curFac && f.key === curFac.key;
    return `
      <button class="diff-row fac-row ${on ? 'on' : ''}" data-act="set-faction" data-key="${f.key}">
        <div class="diff-main">
          <div class="diff-name">${esc(f.name)}</div>
          <div class="diff-tag">${esc(f.tagline || '')}</div>
        </div>
      </button>`;
  }).join('');
  const facBlock = facRows ? `
    <div class="set-head">阵营（本局超能力）</div>
    <div class="diff-list">${facRows}</div>` : '';

  // 联机要金币 > 0。余额 ≤ 0 时按钮点不动，并明确告诉玩家去打 AI ——
  // 联机**没有保底**（输了真扣），所以这里必须说清楚为什么进不去。
  const broke = canPvp === false;
  const canStart = peerName && !gameReady && !broke;

  const startBlock = isHost
    ? `${broke ? `<div class="lobby-broke">金币为 <b>${esc(String(gold))}</b>，不能和真人对决。<br>先去打 AI 赚金币，再回来联机。</div>` : ''}
       <button class="hm-btn hm-primary" data-act="lan-start" ${canStart ? '' : 'disabled'}>
         <span class="hm-ico">▶</span><span class="hm-text">开始对战</span>
         ${broke ? '<span class="hm-sub">金币不足</span>' : ''}
       </button>`
    : '<div class="set-tip">等待主机开始对战…</div>';

  return `
  <div class="screen"${navAttr()}>
    <div class="screen-head">
      <button class="btn-back" data-act="lan-quit">‹ 退出房间</button>
      <h1>联机大厅</h1>
    </div>
    <div class="screen-body">
      <div class="lobby-card">
        <div class="lobby-role">${esc(seatRole)}</div>
        <div class="lobby-room">${esc(roomName || '未命名房间')}</div>
        ${invite}
        <div class="lobby-status lobby-${status}">${esc(statusText)}</div>
        ${watchers > 0 ? `<div class="lobby-watch">有 ${watchers} 人在观战</div>` : ''}
        ${isHost && discoverError ? `<div class="hf-warn">${esc(discoverError)}</div>` : ''}
        <div class="lobby-mode">房间模式：${forgeMode ? '强化模式（双方各带自己的强化卡组）' : '普通模式（卡面原值）'}${peerName
          ? `　·　对手：${peerForge ? '强化模式' : '普通模式'}${!!peerForge !== !!forgeMode ? '（与房间不一致，开局以主机为准）' : ''}`
          : ''}</div>
      </div>

      ${startBlock}

      ${facBlock}

      <div class="hf-warn">联机中请勿退出 App 或切换网络；中途掉线会暂停并等待最多 60 秒重连。<br>注意：联机对局<b>没有金币保底</b>：赢了加金币，输了扣金币，扣到 0 就只能先打 AI。</div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════
// 首页
// ══════════════════════════════════════════════════════════

export function homeHTML({ profile, level, storageMode, replays = [], cloud = null }) {
  const pct = Math.round(level.ratio * 100);
  // 云存档行的副标题：未登录提示登录 / 注册，已登录显示账号（用户名来自 Cloud.cloudStatus()）
  const cloudUser = cloud && cloud.user && cloud.user.username ? String(cloud.user.username) : '';
  const dust = (profile && profile.dust) || 0;
  const recent = Array.isArray(replays) ? replays.length : 0;
  return `
  <div class="home"${navAttr()}>
    <header class="home-top">
      <div class="home-brand">
        <span class="home-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        <span class="home-version">v${APP_VERSION}</span>
      </div>
      <div class="hud">
        <div class="hud-gold" title="金币">
          <span class="hud-label">金币</span><b>${profile.gold}</b>
        </div>
        <div class="hud-dust" title="星尘（用于精通）">
          <span class="hud-label">星尘</span><b>${dust}</b>
        </div>
      </div>
    </header>

    <section class="home-hero">
      <h1 class="home-logo">王座交锋</h1>
      <p class="home-kicker">四线战场 · 王座争夺</p>
      <p class="home-lead">四条线路，一座王座。<br>把对手的国王打到 0 点生命。</p>
      <button class="hm-btn hm-primary" data-act="start-game">
        <span class="hm-text">开始游戏</span>
        <span class="hm-sub">单机 AI · 联机对战</span>
      </button>
    </section>

    <nav class="home-menu" aria-label="更多入口">
      <button class="hm-btn" data-act="start-forge">
        <span class="hm-text">强化模式</span>
        <span class="hm-sub">9 次强化 / 精通 · 星尘 ${dust}</span>
      </button>
      <button class="hm-btn" data-act="open-replays">
        <span class="hm-text">回放对局</span>
        <span class="hm-sub">${recent ? '最近 ' + recent + ' 局' : '还没有对局'}</span>
      </button>
      <button class="hm-btn" data-act="open-account">
        <span class="hm-text">云存档</span>
        <span class="hm-sub">${cloudUser ? '已登录 · ' + esc(cloudUser) : '登录 / 注册'}</span>
      </button>
      <button class="hm-btn" data-act="open-settings">
        <span class="hm-text">设置</span>
        <span class="hm-sub">主题 · 本地数据</span>
      </button>
    </nav>

    <section class="home-foot" aria-label="战绩与等级">
      <div class="hf-stats">
        <div class="hf-stat"><span>对局</span><b>${profile.games}</b></div>
        <div class="hf-stat"><span>胜</span><b>${profile.wins}</b></div>
        <div class="hf-stat"><span>负</span><b>${profile.losses}</b></div>
        <div class="hf-stat"><span>平</span><b>${profile.draws}</b></div>
      </div>
      <div class="hf-level hud-lv" title="等级">
        <div class="hf-level-top">
          <span class="hud-lv-num">Lv.${level.level}</span>
          <span class="hf-level-note">还差 <b>${level.remain}</b> 表现分</span>
        </div>
        <span class="hud-lv-bar"><i style="width:${pct}%"></i></span>
      </div>
      ${storageMode === 'memory'
        ? '<div class="hf-warn">当前环境无法保存进度，金币与回放只在本回合有效</div>'
        : ''}
    </section>
  </div>`;
}

// ══════════════════════════════════════════════════════════
// 设置
// ══════════════════════════════════════════════════════════

export function settingsHTML({ settings, storageMode, replaysBytes, cloud = null }) {
  // 三个外观选项：深色 / 浅色 / 玻璃（认不出的取值一律当深色，和 render.js 的白名单一致）
  const theme = settings.theme === 'light' || settings.theme === 'glass' ? settings.theme : 'dark';
  const cloudUser = cloud && cloud.user && cloud.user.username ? String(cloud.user.username) : '';
  return `
  <div class="screen">
    <div class="screen-head">
      <button class="btn-back" data-act="back-home">‹ 返回</button>
      <h1>设置</h1>
    </div>

    <div class="screen-body">
      <div class="set-group">
        <div class="set-row">
          <div class="set-label">
            <div class="set-name">外观</div>
          </div>
          <div class="seg">
            <button class="seg-item ${theme === 'dark' ? 'on' : ''}" data-act="set-theme" data-theme="dark">深色</button>
            <button class="seg-item ${theme === 'light' ? 'on' : ''}" data-act="set-theme" data-theme="light">浅色</button>
            <button class="seg-item ${theme === 'glass' ? 'on' : ''}" data-act="set-theme" data-theme="glass">玻璃</button>
          </div>
        </div>
      </div>

      <div class="set-group">
        <div class="set-row">
          <div class="set-label">
            <div class="set-name">云存档</div>
            <div class="set-desc">同步金币、等级与强化进度；回放只保留在本机</div>
          </div>
          <button class="cloud-btn" data-act="open-account">${cloudUser ? '已登录 · ' + esc(cloudUser) : '登录 / 注册'}</button>
        </div>
      </div>

      <div class="set-group">
        <div class="set-row">
          <div class="set-label">
            <div class="set-name">本地数据</div>
            <div class="set-desc">
              ${storageMode === 'local'
                ? `已启用本地保存 · 回放占用约 ${fmtSize(replaysBytes)}`
                : '当前环境不支持本地保存，关闭后会丢失进度'}
            </div>
          </div>
        </div>
      </div>

      <div class="set-tip">更多设置待补充。</div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════
// 云存档（账户页 / 管理后台）
// ══════════════════════════════════════════════════════════

/** 服务端时间既可能是毫秒数，也可能是 ISO 字符串；认不出就返回空串 */
function cloudTime(value) {
  if (value === undefined || value === null || value === '') return '';
  let ts = 0;
  if (typeof value === 'number') ts = value;
  else if (typeof value === 'string') ts = Date.parse(value);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  return fmtDate(ts);
}

/** 云存档的范围说明：回放不同步是作者口径，账户页要写清楚 */
function cloudScopeNote() {
  return '<div class="cloud-note">云存档同步金币、等级与强化进度；回放仍只保留在本机。</div>';
}

/**
 * 账户页：未登录显示登录 / 注册；已登录显示同步状态、冲突二选一、改密码。
 * 纯 HTML 函数，不调 Cloud 的任何方法 —— 动作全部交给 play-input 的 data-act 路由。
 */
export function accountHTML({ cloud } = {}) {
  const c = cloud && typeof cloud === 'object' ? cloud : {};
  const user = c.user && c.user.username ? c.user : null;
  const busy = !!c.busy;
  const conflict = c.conflict || null;
  const messages = [
    c.error ? `<div class="cloud-err">${esc(c.error)}</div>` : '',
    c.notice ? `<div class="cloud-ok">${esc(c.notice)}</div>` : '',
  ].join('');

  if (!user) {
    return subScreen('云存档', `
      ${cloudScopeNote()}
      ${messages}
      <div class="cloud-card">
        <div class="cloud-card-head">登录 / 注册</div>
        <div class="cloud-field">
          <label class="cloud-label" for="cloud-user">用户名</label>
          <input id="cloud-user" class="cloud-input" type="text" autocomplete="username"
                 autocapitalize="off" autocorrect="off" spellcheck="false"
                 placeholder="2~20 个字符，中文 / 字母 / 数字 / 下划线">
        </div>
        <div class="cloud-field">
          <label class="cloud-label" for="cloud-pass">密码</label>
          <input id="cloud-pass" class="cloud-input" type="password" autocomplete="current-password"
                 placeholder="6~128 位">
        </div>
        <div class="cloud-actions">
          <button class="cloud-btn primary" data-act="cloud-login" ${busy ? 'disabled' : ''}>${busy ? '请稍候…' : '登录'}</button>
          <button class="cloud-btn" data-act="cloud-register" ${busy ? 'disabled' : ''}>注册新账号</button>
        </div>
      </div>
      <div class="cloud-hint">第一次使用请点「注册新账号」；用户名大小写不敏感。登录后本机进度会与云端对齐，换设备登录可以接着玩。</div>
    `);
  }

  const versionText = c.lastVersion ? 'v' + esc(String(c.lastVersion)) : '还没有存档';
  const syncedText = c.lastSavedAt ? cloudTime(c.lastSavedAt) : '';
  const remoteMeta = conflict
    ? '云端' + (conflict.remoteVersion ? ' v' + esc(String(conflict.remoteVersion)) : '存档')
      + (conflict.remoteUpdatedAt ? ' · ' + esc(cloudTime(conflict.remoteUpdatedAt)) : '')
    : '';
  const conflictBlock = conflict
    ? `
    <div class="cloud-conflict">
      <div class="cloud-conflict-title">云端和本地都有进度</div>
      <div class="cloud-conflict-meta">${esc(remoteMeta)}。选一份继续；选之前不会自动覆盖任何一边。</div>
      <div class="cloud-actions">
        <button class="cloud-btn primary" data-act="cloud-use-cloud" ${busy ? 'disabled' : ''}>用云端存档</button>
        <button class="cloud-btn" data-act="cloud-use-local" ${busy ? 'disabled' : ''}>用本地存档</button>
      </div>
    </div>`
    : '';

  const adminEntry = user.role === 'admin'
    ? `<button class="cloud-btn cloud-btn-wide" data-act="cloud-admin-open">用户管理（管理员）</button>`
    : '';

  return subScreen('云存档', `
    ${cloudScopeNote()}
    ${messages}
    <div class="cloud-user">
      <div class="cloud-user-main">
        <div class="cloud-user-name">${esc(user.username)}</div>
        <div class="cloud-user-meta">${user.role === 'admin' ? '管理员账号' : '普通账号'} · 登录态只保存在本机</div>
      </div>
      <button class="cloud-btn" data-act="cloud-logout">退出登录</button>
    </div>

    ${conflictBlock}

    <div class="cloud-card">
      <div class="cloud-card-head">同步</div>
      <div class="cloud-rows">
        <div class="cloud-row"><span>云端版本</span><b>${versionText}</b></div>
        <div class="cloud-row"><span>最近同步</span><b>${syncedText ? esc(syncedText) : '—'}</b></div>
      </div>
      <div class="cloud-actions">
        <button class="cloud-btn primary" data-act="cloud-push" ${busy ? 'disabled' : ''}>上传本地</button>
        <button class="cloud-btn" data-act="cloud-pull" ${busy ? 'disabled' : ''}>拉取云端</button>
      </div>
      <div class="cloud-hint">上传 = 用本机进度覆盖云端；拉取 = 先看云端有什么，再决定用哪一份。</div>
    </div>

    ${adminEntry}

    <div class="cloud-card">
      <div class="cloud-card-head">修改密码</div>
      <div class="cloud-field">
        <label class="cloud-label" for="cloud-oldpass">当前密码</label>
        <input id="cloud-oldpass" class="cloud-input" type="password" autocomplete="current-password" placeholder="当前密码">
      </div>
      <div class="cloud-field">
        <label class="cloud-label" for="cloud-newpass">新密码</label>
        <input id="cloud-newpass" class="cloud-input" type="password" autocomplete="new-password" placeholder="6~128 位">
      </div>
      <div class="cloud-actions">
        <button class="cloud-btn" data-act="cloud-change-password" ${busy ? 'disabled' : ''}>修改密码</button>
      </div>
      <div class="cloud-hint">改完密码后，其它设备上的登录会失效，需要重新登录。</div>
    </div>
  `);
}

/** 管理后台：用户列表 / 重置密码 / 删除（删除是两次点击确认） */
export function adminHTML({ cloud } = {}) {
  const c = cloud && typeof cloud === 'object' ? cloud : {};
  const admin = c.admin && typeof c.admin === 'object' ? c.admin : {};
  const user = c.user && c.user.username ? c.user : null;
  const isAdmin = !!(user && user.role === 'admin');
  const messages = [
    c.error ? `<div class="cloud-err">${esc(c.error)}</div>` : '',
    c.notice ? `<div class="cloud-ok">${esc(c.notice)}</div>` : '',
    admin.error ? `<div class="cloud-err">${esc(admin.error)}</div>` : '',
  ].join('');

  if (!isAdmin) {
    return subScreen('用户管理', `
      ${messages}
      <div class="cloud-err">需要管理员权限</div>
      <div class="cloud-hint">这个页面只对管理员账号开放。请用管理员账号登录后再来。</div>
    `, 'cloud-admin-back');
  }

  const users = Array.isArray(admin.users) ? admin.users : [];
  const rows = users.map((u) => {
    const name = String(u.username || '');
    const confirming = String(admin.confirmDelete || '') === name;
    const saving = u.save && typeof u.save === 'object' ? u.save : null;
    const summary = saving && saving.summary ? saving.summary : null;
    const stats = summary
      ? '对局 ' + (summary.games || 0) + ' · 胜 ' + (summary.wins || 0)
        + ' · 表现分 ' + (summary.perf || 0) + ' · 金币 ' + (summary.gold || 0)
      : '还没有云存档';
    const saveLine = saving
      ? '云端 v' + (saving.version || 0) + ' · ' + fmtSize(saving.bytes || 0)
        + (saving.updatedAt ? ' · ' + cloudTime(saving.updatedAt) : '')
      : '';
    const ops = confirming
      ? `<button class="cloud-btn danger" data-act="cloud-admin-delete-confirm" data-user="${esc(name)}">确认删除</button>
         <button class="cloud-btn" data-act="cloud-admin-delete-cancel" data-user="${esc(name)}">取消</button>`
      : `<button class="cloud-btn" data-act="cloud-admin-edit" data-user="${esc(name)}">改数据</button>
         <button class="cloud-btn" data-act="cloud-admin-reset" data-user="${esc(name)}">重置密码</button>
         <button class="cloud-btn danger" data-act="cloud-admin-delete" data-user="${esc(name)}">删除</button>`;
    return `
    <div class="cloud-admin-card">
      <div class="cloud-admin-head">
        <b class="cloud-user-name">${esc(name)}</b>
        <span class="cloud-role">${u.role === 'admin' ? '管理员' : '玩家'}</span>
      </div>
      <div class="cloud-admin-line">${esc(stats)}</div>
      ${saveLine ? `<div class="cloud-admin-line cloud-admin-sub">${esc(saveLine)}</div>` : ''}
      <div class="cloud-admin-line cloud-admin-sub">上次登录 ${cloudTime(u.lastLoginAt) || '—'}</div>
      <div class="cloud-actions">${ops}</div>
      ${admin.edit && String(admin.edit.username).toLowerCase() === name.toLowerCase()
        ? adminEditHTML(name, admin.edit, levelFor)
        : ''}
    </div>`;
  }).join('');

  return subScreen('用户管理', `
    ${messages}
    <div class="cloud-admin-bar">
      <span class="cloud-admin-count">共 ${users.length} 个用户${admin.loading ? ' · 正在加载…' : ''}</span>
      <button class="cloud-btn" data-act="cloud-admin-refresh" ${admin.loading ? 'disabled' : ''}>刷新</button>
    </div>

    <div class="cloud-card">
      <div class="cloud-card-head">重置密码用的新口令</div>
      <div class="cloud-field">
        <label class="cloud-label" for="cloud-admin-pass">新密码（6~128 位）</label>
        <input id="cloud-admin-pass" class="cloud-input" type="password" autocomplete="new-password"
               spellcheck="false" placeholder="先填这里，再点某个用户的「重置密码」">
      </div>
      <div class="cloud-hint">重置后该用户所有已登录设备都会失效；管理员不能删除自己。</div>
    </div>

    <div class="cloud-admin-list">
      ${rows || `<div class="rp-empty">${admin.loading ? '正在加载用户…' : '还没有用户数据'}<br><span>点「刷新」从云端读取</span></div>`}
    </div>

    ${adminLogHTML(admin.log)}
  `, 'cloud-admin-back');
}

/**
 * 管理员「改数据」面板（0.69.0）。
 *
 * 为什么长在用户卡片里：改数据前一定要先看清楚「这个人现在是什么样」，
 * 弹窗那种把原值盖住的做法反而容易改错人。
 *
 * 字段只给**数值类**的（金币 / 星尘 / 表现分 / 对局 / 胜 / 负 / 平），
 * 其它结构（强化表）走「高级：改整份 JSON」或「清空强化」——
 * 手机键盘上敲嵌套 JSON 不现实，但真要动的时候得留一条路。
 */
function adminEditHTML(name, edit, levelFn) {
  const e = edit && typeof edit === 'object' ? edit : {};
  const form = e.form && typeof e.form === 'object' ? e.form : {};
  const val = (k) => {
    const n = Math.floor(Number(form[k]));
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const field = (label, id, v, tip) => `
    <label class="cloud-edit-field">
      <span class="cloud-edit-label">${esc(label)}</span>
      <input id="${id}" class="cloud-input cloud-edit-input" type="number" inputmode="numeric"
             min="0" step="1" value="${v}" data-adm="${id}">
      ${tip ? `<span class="cloud-edit-tip">${esc(tip)}</span>` : ''}
    </label>`;
  const lv = levelFn(val('perf'));
  const forgeTip = e.forgeCount > 0 ? '（现在 ' + e.forgeCount + ' 张牌有强化）' : '（现在没有任何强化）';
  return `
  <div class="cloud-admin-edit">
    <div class="cloud-admin-edit-head">
      <b>改「${esc(name)}」的数据</b>
      <span class="cloud-edit-version">云端 v${e.version || 0}${e.exists ? '' : ' · 还没有云存档'}</span>
    </div>
    ${e.loading ? '<div class="cloud-hint">正在读取这个人的存档…</div>' : ''}
    ${e.error ? `<div class="cloud-err">${esc(e.error)}</div>` : ''}
    ${e.hint ? `<div class="cloud-ok">${esc(e.hint)}</div>` : ''}
    <div class="cloud-edit-grid">
      ${field('金币', 'admin-gold', val('gold'), '上限 1000')}
      ${field('星尘', 'admin-dust', val('dust'), '上限 500')}
      ${field('表现分', 'admin-perf', val('perf'), 'Lv.' + lv)}
      ${field('对局数', 'admin-games', val('games'), '')}
      ${field('胜', 'admin-wins', val('wins'), '')}
      ${field('负', 'admin-losses', val('losses'), '')}
      ${field('平', 'admin-draws', val('draws'), '')}
    </div>
    <div class="cloud-actions">
      <button class="cloud-btn primary" data-act="cloud-admin-save" ${e.saving || e.loading ? 'disabled' : ''}>保存数值</button>
      <button class="cloud-btn" data-act="cloud-admin-clear-forge" ${e.saving || e.loading ? 'disabled' : ''}>清空强化${forgeTip}</button>
      <button class="cloud-btn" data-act="cloud-admin-raw">${e.rawOpen ? '收起整份 JSON' : '高级：改整份 JSON'}</button>
      <button class="cloud-btn" data-act="cloud-admin-edit-close">关闭</button>
    </div>
    ${e.rawOpen ? `
      <div class="cloud-hint">整份替换：最外层必须是 { }，保存后云端版本 +1。改坏了只能在这里再改回来。</div>
      <textarea id="admin-raw" class="cloud-input cloud-raw" rows="9" spellcheck="false"
                autocapitalize="off" autocomplete="off">${esc(e.raw || '{}')}</textarea>
      <div class="cloud-actions">
        <button class="cloud-btn danger" data-act="cloud-admin-save-raw" ${e.saving || e.loading ? 'disabled' : ''}>用这份 JSON 覆盖</button>
      </div>
    ` : ''}
  </div>`;
}

/** 最近的管理操作（服务端审计），给管理员一个「我刚才改了什么」的回头账 */
function adminLogHTML(log) {
  const list = Array.isArray(log) ? log.slice(0, 6) : [];
  if (!list.length) return '';
  const fieldName = {
    gold: '金币', dust: '星尘', perf: '表现分', games: '对局', wins: '胜',
    losses: '负', draws: '平', forge: '强化', data: '整份存档', lifetimeGold: '累计金币',
  };
  const lines = list.map((e) => {
    const who = String(e.username || '?');
    const fields = Array.isArray(e.fields) ? e.fields.map((f) => fieldName[f] || f).join(' / ') : '';
    return `<li>${esc(cloudTime(e.at))} · ${esc(String(e.by || '管理员'))} 改了 ${esc(who)} 的 ${esc(fields || '数据')}（v${Number(e.version) || 0}）</li>`;
  }).join('');
  return `
  <div class="cloud-card cloud-admin-log">
    <div class="cloud-card-head">最近的管理操作</div>
    <ul class="cloud-log-list">${lines}</ul>
    <div class="cloud-hint">只保留最近 50 条，存在服务端；管理员改的是**云端存档**。</div>
  </div>`;
}

// ══════════════════════════════════════════════════════════
// 回放列表
// ══════════════════════════════════════════════════════════

function resultLabel(rec) {
  if (rec.winner === 'draw') return { text: '平', cls: 'draw' };
  if (rec.winner === 0) return { text: '玩家0 胜', cls: 'p0' };
  if (rec.winner === 1) return { text: '玩家1 胜', cls: 'p1' };
  return { text: '未完成', cls: 'none' };
}

export function replayListHTML({ records, cardLib, editingNoteId, confirmDelId, storageMode, replaysBytes }) {
  const rows = records.map((rec) => {
    const res = resultLabel(rec);
    const bad = incompatibleReason(rec, cardLib);
    const editing = editingNoteId === rec.id;
    const confirming = confirmDelId === rec.id;

    const noteLine = editing
      ? `<div class="rp-note-edit">
           <input id="note-input" class="rp-input" maxlength="40" placeholder="给这局写个备注" value="${esc(rec.note || '')}">
           <button class="rp-mini" data-act="replay-note-save" data-id="${rec.id}">保存</button>
           <button class="rp-mini" data-act="replay-note-cancel" data-id="${rec.id}">取消</button>
         </div>`
      : `<div class="rp-note ${rec.note ? '' : 'rp-note-empty'}">${rec.note ? esc(rec.note) : '（点「备注」给这局写点什么）'}</div>`;

    const ops = confirming
      ? `<button class="rp-mini danger" data-act="replay-del-confirm" data-id="${rec.id}">确认删除</button>
         <button class="rp-mini" data-act="replay-del-cancel" data-id="${rec.id}">取消</button>`
      : `<button class="rp-mini" data-act="replay-open" data-id="${rec.id}" ${bad ? 'disabled' : ''}>回放</button>
         <button class="rp-mini" data-act="replay-note" data-id="${rec.id}">备注</button>
         <button class="rp-mini danger" data-act="replay-del" data-id="${rec.id}">删除</button>`;

    return `
    <div class="rp-row ${bad ? 'rp-row-bad' : ''}">
      <div class="rp-main">
        <div class="rp-line1">
          <b class="rp-res ${res.cls}">${res.text}</b>
          <span class="rp-date">${fmtDate(rec.endedAt || rec.startedAt)}</span>
          <span class="rp-turn">第 ${rec.turns || '?'} 回合</span>
        </div>
        ${noteLine}
        ${bad ? `<div class="rp-bad">注意：${esc(bad)}</div>` : ''}
      </div>
      <div class="rp-ops">${ops}</div>
    </div>`;
  }).join('');

  return `
  <div class="screen"${navAttr()}>
    <div class="screen-head">
      <button class="btn-back" data-act="back-home">‹ 返回</button>
      <h1>回放对局</h1>
    </div>
    <div class="screen-body">
      <div class="rp-summary">共 ${records.length} 局${records.length ? ` · 占用约 ${fmtSize(replaysBytes || 0)}` : ''}</div>
      ${records.length ? rows : '<div class="rp-empty">还没有对局记录<br><span>打完一局就会自动存下来</span></div>'}
      ${storageMode === 'memory' ? '<div class="hf-warn">当前环境无法保存，关闭后会丢失</div>' : ''}
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════
// 回放播放器控制条
// ══════════════════════════════════════════════════════════

const SPEEDS = [0.5, 1, 2, 4];

export function replayBarHTML({ record, index, total, playing, speed, error }) {
  const pct = total > 0 ? Math.round((index / total) * 100) : 0;
  const res = resultLabel(record);
  return `
  <div class="rp-bar">
    <div class="rp-bar-top">
      <button class="rp-mini" data-act="replay-exit">退出</button>
      <span class="rp-bar-title">
        <b class="rp-res ${res.cls}">${res.text}</b>
        <span class="rp-date">${fmtDate(record.endedAt || record.startedAt)}</span>
        ${record.note ? `<span class="rp-bar-note">${esc(record.note)}</span>` : ''}
      </span>
    </div>
    <input class="rp-seek" id="rp-seek" type="range" min="0" max="${total}" value="${index}">
    <div class="rp-bar-ctl">
      <button class="rp-btn" data-act="replay-prev" title="上一步">◀◀</button>
      <button class="rp-btn rp-btn-play" data-act="replay-toggle">${playing ? '⏸ 暂停' : '▶ 播放'}</button>
      <button class="rp-btn" data-act="replay-next" title="下一步">▶▶</button>
      <span class="rp-count">${index} / ${total}</span>
      <button class="rp-btn" data-act="replay-speed">${speed}×</button>
    </div>
    ${error ? `<div class="rp-err">${esc(error)}</div>` : ''}
  </div>`;
}

export function nextSpeed(speed) {
  const i = SPEEDS.indexOf(speed);
  return SPEEDS[(i + 1) % SPEEDS.length];
}

// ══════════════════════════════════════════════════════════
// 强化工坊（强化 / 精通 / 洗掉 / 星尘合成）
// ══════════════════════════════════════════════════════════

/** 九个小格表示强化进度（点亮 = 已强化） */
function forgePips(lvl) {
  let html = '';
  for (let i = 0; i < ENHANCE_MAX; i++) html += `<i class="${i < lvl ? 'on' : ''}"></i>`;
  return html;
}

/** 一张牌在工坊里的一行 */
function forgeCardHTML(card, profile) {
  const def = card.def;
  const rec = card.rec;
  const st = card.stats;
  const lvl = Number(rec.lvl) || 0;
  const mast = (rec.masteries || []).length;
  const isSpell = card.type === 'spell';
  const gold = Number(profile && profile.gold) || 0;
  const dust = Number(profile && profile.dust) || 0;

  const enhanceCost = enhanceGoldCost(lvl);
  const masterCost = masteryDustCost(mast);
  const canEnh = lvl < ENHANCE_MAX && gold >= enhanceCost;
  const canMast = lvl >= ENHANCE_MAX && mast < MASTERY_MAX && dust >= masterCost;
  const canWash = mast > 0;

  // 数值只显示「现在实际是多少」，改过的再补一句原来的值
  const stats = isSpell
    ? `<span class="fc-stat">${fmtNum(st.cost)} 费</span>`
      + (st.cost !== def.cost ? `<span class="fc-was">原 ${fmtNum(def.cost)}</span>` : '')
    : `<span class="fc-stat fc-stat-atk">${fmtNum(st.atk)} 攻</span>`
      + `<span class="fc-stat fc-stat-hp">${fmtNum(st.hp)} 血</span>`
      + (st.atk !== def.atk || st.hp !== def.hp ? `<span class="fc-was">原 ${fmtNum(def.atk)}/${fmtNum(def.hp)}</span>` : '');

  const mastNames = (rec.masteries || []).map((id) => {
    if (id === 'spell_cost') return '减费';
    const s = SKILL_BY_ID[id];
    return s ? s.name : id;
  });
  const tip = mastNames.length
    ? `已挂：${mastNames.join('、')}`
    : (lvl >= ENHANCE_MAX
      ? (isSpell ? '已练满：可以精通（费用 −1）' : '已练满：可以精通或洗掉')
      : `再强化 ${ENHANCE_MAX - lvl} 次可精通`);

  return `
    <div class="forge-card">
      <div class="fc-main">
        <div class="fc-line">
          <b class="fc-name">${esc(def.name)}</b>
          <span class="fc-tag">${isSpell ? '锦囊' : '基础'}</span>
          ${mast ? `<span class="fc-mast">精通 ${mast}/${MASTERY_MAX}</span>` : ''}
        </div>
        <div class="fc-stats">${stats}</div>
        <div class="fc-pips">${forgePips(lvl)}</div>
        <div class="fc-tip">${esc(tip)}</div>
      </div>
      <div class="fc-ops">
        <button class="fc-btn" data-act="forge-enhance" data-id="${esc(card.id)}" ${canEnh ? '' : 'disabled'}>
          ${lvl >= ENHANCE_MAX ? '已练满' : `强化 ${enhanceCost}金`}
        </button>
        <button class="fc-btn fc-btn-mast" data-act="forge-master" data-id="${esc(card.id)}" ${canMast ? '' : 'disabled'}>
          ${mast >= MASTERY_MAX ? '精通满' : `精通 ${masterCost}尘`}
        </button>
        ${canWash ? `<button class="fc-btn fc-btn-wash" data-act="forge-wash" data-id="${esc(card.id)}">洗掉</button>` : ''}
      </div>
    </div>`;
}

/** 精通时三选一的面板 */
function forgePickHTML(pick) {
  const opts = (pick.options || []).map((s) => {
    const r = RARITY[s.rarity] || RARITY.white;
    return `
      <button class="skill-opt" data-act="forge-pick" data-skill="${esc(s.id)}" style="--rar:${r.color}">
        <span class="skill-rar">${esc(r.label)}</span>
        <b class="skill-name">${esc(s.name)}</b>
        <span class="skill-text">${esc(s.text)}</span>
      </button>`;
  }).join('');
  return `
    <div class="overlay">
      <div class="result forge-pick">
        <h2>选一个技能</h2>
        <p>${esc(pick.name)} 精通：失去全部强化数值，永久获得所选技能</p>
        <div class="skill-list">${opts}</div>
        <button class="btn-home" data-act="forge-pick-cancel">再想想</button>
      </div>
    </div>`;
}

export function workshopHTML({ profile, groups, groupBy, pick, hint }) {
  const gold = Number(profile && profile.gold) || 0;
  const dust = Number(profile && profile.dust) || 0;
  const list = (groups || []).map((g) => `
    <div class="forge-group">
      <div class="forge-group-head">${esc(g.label)}</div>
      ${g.cards.map((c) => forgeCardHTML(c, profile)).join('')}
    </div>`).join('');

  return `
  <div class="screen" ${navAttr()}>
    <div class="screen-head">
      <button class="btn-back" data-act="back-play">‹ 返回</button>
      <h1>强化工坊</h1>
    </div>

    <div class="screen-body">
      <div class="forge-wallet">
        <div class="hud-gold" title="金币"><i class="coin"></i><b>${gold}</b></div>
        <div class="hud-dust" title="星尘（精通用）"><i class="dust"></i><b>${dust}</b></div>
        <button class="fc-btn fc-btn-buy" data-act="forge-buy-dust" ${gold >= 10 && dust < 500 ? '' : 'disabled'}>10 金 → 1 星尘</button>
      </div>

      <div class="seg forge-seg">
        <button class="seg-item ${groupBy === 'initial' ? 'on' : ''}" data-act="forge-group" data-key="initial">按首字母</button>
        <button class="seg-item ${groupBy === 'type' ? 'on' : ''}" data-act="forge-group" data-key="type">按类型</button>
      </div>

      ${hint ? `<div class="forge-hint">${esc(hint)}</div>` : ''}
      <div class="set-tip">强化一次花金币（单位每次 +0.1 攻/+0.1 血，第 9 次 +0.2；锦囊只攒次数）。练满 9 次后可精通：单位失去强化数值、换一个永久技能，锦囊永久减费。精通会消耗星尘。</div>

      <div class="forge-list">${list || '<div class="rp-empty">没有可强化的卡牌</div>'}</div>
    </div>
    ${pick ? forgePickHTML(pick) : ''}
  </div>`;
}

