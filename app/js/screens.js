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

/**
 * HTML 转义。
 * 注意名字不能叫 `esc` —— ui.js 里已经有一个同名的模块级常量，
 * 打包器把各模块拼进同一个作用域，重名会直接报「Identifier 'esc' has already been declared」。
 */
const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 版本号（改版本时和 tools/build-apk.ps1 一起改） */
export const APP_VERSION = '0.42.0';

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

/** 通用：带返回按钮的二级页面外壳 */
function subScreen(title, body) {
  return `
  <div class="screen">
    <div class="screen-head">
      <button class="btn-back" data-act="back-home">‹ 返回</button>
      <h2>${escHtml(title)}</h2>
    </div>
    <div class="screen-body">${body}</div>
  </div>`;
}

export function playMenuHTML({ difficulty, lanSupported }) {
  const d = difficulty || { name: '普通', tagline: '' };
  return subScreen('开始游戏', `
    <button class="hm-btn hm-primary" data-act="choose-ai">
      <span class="hm-ico">⚔</span>
      <span class="hm-text">AI 对决</span>
      <span class="hm-sub">${escHtml(d.name)}</span>
    </button>
    <button class="hm-btn" data-act="lan-menu">
      <span class="hm-ico">⇄</span>
      <span class="hm-text">局域网对决</span>
      <span class="hm-sub">同一 Wi-Fi 下两台设备</span>
    </button>
    ${lanSupported ? '' : '<div class="set-tip">⚠ 当前环境不支持局域网（需要在手机 App 里运行）</div>'}
  `);
}

export function difficultyHTML({ current, difficulties, faction, factions }) {
  const cur = difficulties.find((d) => d.key === current) || difficulties[0] || { name: '' };
  const CHK = String.fromCharCode(0x2713);
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
          <div class="diff-name">${escHtml(d.name)}${on ? `<span class="diff-check">${CHK}</span>` : ''}</div>
          <div class="diff-tag">${escHtml(d.tagline)}</div>
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
          <div class="diff-name">${escHtml(f.name)}${on ? `<span class="diff-check">${CHK}</span>` : ''}</div>
          <div class="diff-tag">${escHtml(f.tagline || '')}</div>
        </div>
      </button>`;
  }).join('');
  const facBlock = facRows ? `
    <div class="set-head">阵营（本局超能力）</div>
    <div class="diff-list">${facRows}</div>` : '';

  return subScreen('AI 难度与阵营', `
    <div class="diff-list">${rows}</div>
    <div class="set-tip">难度主要影响 AI 的决策水平。<b>困难和噩梦</b>另外会多几张起手牌、国王血量更高（<b>但不会多费用</b>），已在上方逐条写明。</div>
    ${facBlock}
    <button class="hm-btn hm-primary diff-go" data-act="start-ai">
      <span class="hm-ico"></span>
      <span class="hm-text">开始对战</span>
      <span class="hm-sub">${escHtml(cur.name)}${curFac ? '  ' + escHtml(curFac.name) : ''}</span>
    </button>
  `);
}

// ══════════════════════════════════════════════════════════
// 局域网
// ══════════════════════════════════════════════════════════

export function lanMenuHTML({ lanSupported, localIp }) {
  if (!lanSupported) {
    return subScreen('局域网对决', `
      <div class="rp-empty">当前环境不支持局域网<br><span>需要在手机上安装 PPK 后使用</span></div>
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
    ${localIp ? `<div class="set-tip">本机地址：${escHtml(localIp)}</div>` : ''}
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
      ${manualError ? `<div class="lan-err">${escHtml(manualError)}</div>` : ''}
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
              data-url="http://${escHtml(r.ip)}:${r.port}/?net=guest"
              ${r.started ? 'disabled' : ''}>
        <div class="room-main">
          <div class="room-name">${escHtml(r.room || '未命名房间')}</div>
          <div class="room-sub">${escHtml(r.ip)}:${r.port} · 主机 ${escHtml(r.host || '?')}</div>
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
export function lobbyHTML({ mode, roomName, peerName, status, localIp, port, gameReady, gold, canPvp }) {
  const isHost = mode === 'host';
  const statusText = {
    connected: peerName ? `已连接：${peerName}` : '等待对手加入…',
    reconnecting: '连接中断，正在等待重连…',
    closed: '对方已离开',
  }[status] || status;

  const joinUrl = isHost && localIp ? `http://${localIp}:${port}/` : '';

  // 联机要金币 > 0。余额 ≤ 0 时按钮点不动，并明确告诉玩家去打 AI ——
  // 联机**没有保底**（输了真扣），所以这里必须说清楚为什么进不去。
  const broke = canPvp === false;
  const canStart = peerName && !gameReady && !broke;

  const startBlock = isHost
    ? `${broke ? `<div class="lobby-broke">金币为 <b>${escHtml(String(gold))}</b>，不能和真人对决。<br>先去打 AI 赚金币，再回来联机。</div>` : ''}
       <button class="hm-btn hm-primary" data-act="lan-start" ${canStart ? '' : 'disabled'}>
         <span class="hm-ico">▶</span><span class="hm-text">开始对战</span>
         ${broke ? '<span class="hm-sub">金币不足</span>' : ''}
       </button>`
    : '<div class="set-tip">等待主机开始对战…</div>';

  return `
  <div class="screen">
    <div class="screen-head">
      <button class="btn-back" data-act="lan-quit">‹ 退出房间</button>
      <h2>联机大厅</h2>
    </div>
    <div class="screen-body">
      <div class="lobby-card">
        <div class="lobby-role">${isHost ? '你是主机' : '你是客人'}</div>
        <div class="lobby-room">${escHtml(roomName || '未命名房间')}</div>
        ${isHost && joinUrl ? `<div class="lobby-url">同一 Wi-Fi 下的另一台设备可以扫描到这个房间，<br>或直接访问 <b>${escHtml(joinUrl)}</b></div>` : ''}
        <div class="lobby-status lobby-${status}">${escHtml(statusText)}</div>
      </div>

      ${startBlock}

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
  <div class="home">
    <div class="home-top">
      <div class="hud">
        <div class="hud-gold" title="金币">
          <i class="coin"></i><b>${profile.gold}</b>
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
        距 Lv.${level.level + 1} 还差 <b>${level.remain}</b> 金币
        <span class="hf-dim">（累计 ${level.lifetimeGold}）</span>
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
            <div class="set-desc">深色 / 浅色 / 玻璃</div>
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
           <input id="note-input" class="rp-input" maxlength="40" placeholder="给这局写个备注" value="${escHtml(rec.note || '')}">
           <button class="rp-mini" data-act="replay-note-save" data-id="${rec.id}">保存</button>
           <button class="rp-mini" data-act="replay-note-cancel" data-id="${rec.id}">取消</button>
         </div>`
      : `<div class="rp-note ${rec.note ? '' : 'rp-note-empty'}">${rec.note ? escHtml(rec.note) : '（点「备注」给这局写点什么）'}</div>`;

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
          <span class="rp-date">${fmtDate(rec.endedPt || rec.startedPt)}</span>
          <span class="rp-turn">第 ${rec.turns || '?'} 回合</span>
        </div>
        ${noteLine}
        ${bad ? `<div class="rp-bad">⚠ ${escHtml(bad)}</div>` : ''}
      </div>
      <div class="rp-ops">${ops}</div>
    </div>`;
  }).join('');

  return `
  <div class="screen">
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
        <span class="rp-date">${fmtDate(record.endedPt || record.startedPt)}</span>
        ${record.note ? `<span class="rp-bar-note">${escHtml(record.note)}</span>` : ''}
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
    ${error ? `<div class="rp-err">${escHtml(error)}</div>` : ''}
  </div>`;
}

export function nextSpeed(speed) {
  const i = SPEEDS.indexOf(speed);
  return SPEEDS[(i + 1) % SPEEDS.length];
}

export { SPEEDS, fmtDate, fmtSize };
