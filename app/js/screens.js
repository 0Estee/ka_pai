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

/** 版本号（改版本时和 tools/build-apk.ps1 一起改） */
export const APP_VERSION = '0.59.0';

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

/** 通用：带返回按钮的二级页面外壳 */
function subScreen(title, body) {
  return `
  <div class="screen"${navAttr()}>
    <div class="screen-head">
      <button class="btn-back" data-act="back-home">‹ 返回</button>
      <h2>${esc(title)}</h2>
    </div>
    <div class="screen-body">${body}</div>
  </div>`;
}

export function playMenuHTML({ difficulty, lanSupported, profile }) {
  const d = difficulty || { name: '普通', tagline: '' };
  const dust = (profile && profile.dust) || 0;
  return subScreen('开始游戏', `
    <button class="hm-btn hm-primary" data-act="choose-ai">
      <span class="hm-ico">⚔</span>
      <span class="hm-text">AI 对决</span>
      <span class="hm-sub">${esc(d.name)}</span>
    </button>
    <button class="hm-btn" data-act="lan-menu">
      <span class="hm-ico">⇄</span>
      <span class="hm-text">局域网对决</span>
      <span class="hm-sub">同一 Wi-Fi 下两台设备</span>
    </button>
    ${lanSupported ? '' : '<div class="set-tip">⚠ 当前环境不支持局域网（需要在手机 App 里运行）</div>'}
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
      <span class="hm-ico">⚔</span>
      <span class="hm-text">强化 AI 对决</span>
      <span class="hm-sub">${esc((difficulty && difficulty.name) || '普通')}</span>
    </button>
    <button class="hm-btn" data-act="lan-menu">
      <span class="hm-ico">⇄</span>
      <span class="hm-text">强化 联机对决</span>
      <span class="hm-sub">双方各自带上自己的强化卡组</span>
    </button>
    <button class="hm-btn" data-act="open-forge">
      <span class="hm-ico">✦</span>
      <span class="hm-text">强化工坊</span>
      <span class="hm-sub">金币 ${gold} · 星尘 ${dust}</span>
    </button>
    ${lanSupported ? '' : '<div class="set-tip">⚠ 当前环境不支持局域网（需要在手机 App 里运行）</div>'}
  `);
}

export function difficultyHTML({ current, difficulties, faction, factions, mode }) {
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

export function lanMenuHTML({ lanSupported, localIp }) {
  if (!lanSupported) {
    return subScreen('局域网对决', `
      <div class="rp-empty">当前环境不支持局域网<br><span>需要在手机上安装 APK 后使用</span></div>
    `);
  }
  return subScreen('局域网对决', `
    <button class="hm-btn hm-primary" data-act="lan-host">
      <span class="hm-ico">＋</span><span class="hm-text">创建房间</span>
      <span class="hm-sub">我来当主机</span>
    </button>
    <button class="hm-btn" data-act="lan-scan">
      <span class="hm-ico">⌕</span><span class="hm-text">加入房间</span>
      <span class="hm-sub">扫描同一 Wi-Fi 下的房间</span>
    </button>
    <div class="hf-warn">主机中途退出会导致房间消失，对手将直接判负。</div>
    ${localIp ? `<div class="set-tip">本机地址：${esc(localIp)}</div>` : ''}
  `);
}

export function lanScanHTML({ rooms, scanning, manualError }) {
  // 手动兜底：UDP 广播在很多路由器上会被拦（「PP 隔离」/访客网络/企业 Wi-Fi），
  // 这时扫描永远是空的 —— 让玩家照抄主机屏幕上那串地址就能连上。
  // 不能用 prompt()：WebView 里它是静默失效的（会什么都不发生），必须内嵌输入框。
  const manual = `
    <div class="lan-manual">
      <div class="lan-manual-tip">搜不到房间？让主机把大厅里显示的那串地址念给你，填在这里：</div>
      <input id="lan-manual-ip" class="lan-input" type="text" inputmode="decimal"
             autocomplete="off" autocapitalize="off" spellcheck="false"
             placeholder="例如 192.168.1.7:8765">
      <button class="rp-btn" data-act="lan-join-manual">手动连接</button>
      ${manualError ? `<div class="lan-err">${esc(manualError)}</div>` : ''}
    </div>`;

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
    : '<div class="rp-empty">没找到房间<br><span>确认两台设备连的是同一个 Wi-Fi，且主机已经创建房间</span></div>';

  return subScreen('加入房间', `
    <div class="rp-summary">找到 ${rooms.length} 个房间</div>
    ${list}
    <button class="rp-btn" data-act="lan-scan">重新扫描</button>
    ${manual}
  `);
}

/** 联机大厅：主机等对手，客人等主机开始 */
export function lobbyHTML({ mode, roomName, peerName, status, localIp, port, gameReady, gold, canPvp, faction, factions, forgeMode, peerForge }) {
  const isHost = mode === 'host';
  const statusText = {
    connected: peerName ? `已连接：${peerName}` : '等待对手加入…',
    reconnecting: '连接中断，正在等待重连…',
    closed: '对方已离开',
  }[status] || status;

  const joinUrl = isHost && localIp ? `http://${localIp}:${port}/` : '';

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
      <h2>联机大厅</h2>
    </div>
    <div class="screen-body">
      <div class="lobby-card">
        <div class="lobby-role">${isHost ? '你是主机' : '你是客人'}</div>
        <div class="lobby-room">${esc(roomName || '未命名房间')}</div>
        ${isHost && joinUrl ? `<div class="lobby-url">同一 Wi-Fi 下的另一台设备可以扫描到这个房间，<br>或直接访问 <b>${esc(joinUrl)}</b></div>` : ''}
        <div class="lobby-status lobby-${status}">${esc(statusText)}</div>
        <div class="lobby-mode">房间模式：${forgeMode ? '强化模式（双方各带自己的强化卡组）' : '普通模式（卡面原值）'}${peerName
          ? `　·　对手：${peerForge ? '强化模式' : '普通模式'}${!!peerForge !== !!forgeMode ? '（与房间不一致，开局以主机为准）' : ''}`
          : ''}</div>
      </div>

      ${startBlock}

      ${facBlock}

      <div class="hf-warn">联机中请勿退出 App 或切换 Wi-Fi；中途掉线会暂停并等待最多 60 秒重连。<br>⚠ 联机对局<b>没有金币保底</b>：赢了加金币，输了扣金币，扣到 0 就只能先打 AI。</div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════
// 首页
// ══════════════════════════════════════════════════════════

export function homeHTML({ profile, level, storageMode }) {
  const pct = Math.round(level.ratio * 100);
  return `
  <div class="home"${navAttr()}>
    <div class="home-top">
      <div class="hud">
        <div class="hud-gold" title="金币">
          <i class="coin"></i><b>${profile.gold}</b>
        </div>
        <div class="hud-dust" title="星尘（用于精通）">
          <i class="dust"></i><b>${profile.dust || 0}</b>
        </div>
        <div class="hud-lv" title="等级">
          <span class="hud-lv-num">Lv.${level.level}</span>
          <span class="hud-lv-bar"><i style="width:${pct}%"></i></span>
        </div>
      </div>
    </div>

    <div class="home-hero">
      <div class="home-logo">王座交锋</div>
      <div class="home-sub">原型 v${APP_VERSION}</div>
    </div>

    <div class="home-menu">
      <button class="hm-btn hm-primary" data-act="start-game">
        <span class="hm-ico">⚔</span><span class="hm-text">开始游戏</span>
      </button>
      <button class="hm-btn" data-act="start-forge">
        <span class="hm-ico">✦</span><span class="hm-text">强化模式</span>
        <span class="hm-sub">强化 / 精通 · 星尘 ${(profile && profile.dust) || 0}</span>
      </button>
      <button class="hm-btn" data-act="open-replays">
        <span class="hm-ico">⟲</span><span class="hm-text">回放对局</span>
      </button>
      <button class="hm-btn" data-act="open-settings">
        <span class="hm-ico">⚙</span><span class="hm-text">设置</span>
      </button>
    </div>

    <div class="home-foot">
      <div class="hf-stats">
        <span>共 ${profile.games} 局</span>
        <span>胜 ${profile.wins}</span>
        <span>负 ${profile.losses}</span>
        <span>平 ${profile.draws}</span>
      </div>
      <div class="hf-level">
        距 Lv.${level.level + 1} 还差 <b>${level.remain}</b> 表现分
        <span class="hf-dim">（累计 ${level.perf}）</span>
      </div>
      ${storageMode === 'memory'
        ? '<div class="hf-warn">⚠ 当前环境无法保存进度，金币与回放只在本回合有效</div>'
        : ''}
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════
// 设置
// ══════════════════════════════════════════════════════════

export function settingsHTML({ settings, storageMode, replaysBytes }) {
  // 三个外观选项：深色 / 浅色 / 玻璃（认不出的取值一律当深色，和 render.js 的白名单一致）
  const theme = settings.theme === 'light' || settings.theme === 'glass' ? settings.theme : 'dark';
  return `
  <div class="screen">
    <div class="screen-head">
      <button class="btn-back" data-act="back-home">‹ 返回</button>
      <h2>设置</h2>
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
        ${bad ? `<div class="rp-bad">⚠ ${esc(bad)}</div>` : ''}
      </div>
      <div class="rp-ops">${ops}</div>
    </div>`;
  }).join('');

  return `
  <div class="screen"${navAttr()}>
    <div class="screen-head">
      <button class="btn-back" data-act="back-home">‹ 返回</button>
      <h2>回放对局</h2>
    </div>
    <div class="screen-body">
      <div class="rp-summary">共 ${records.length} 局${records.length ? ` · 占用约 ${fmtSize(replaysBytes || 0)}` : ''}</div>
      ${records.length ? rows : '<div class="rp-empty">还没有对局记录<br><span>打完一局就会自动存下来</span></div>'}
      ${storageMode === 'memory' ? '<div class="hf-warn">⚠ 当前环境无法保存，关闭后会丢失</div>' : ''}
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
      <h2>强化工坊</h2>
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

