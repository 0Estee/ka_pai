/**
 * 回放档案（增删改）与回放播放器：打开 / 播放 / 单步 / 变速 / 拖动进度条。
 *
 * 与 app/js 其它模块共享同一个打包作用域（见 tools/build-web.mjs）：
 * screen/state/view/replays/paused/replayCtx/bannerTimer/autoAdvanceTimer 等
 * 共享状态直接按裸名字读写，以及 refresh/tick/goHome 等同作用域函数，
 * 都不需要 import。
 */

import * as RP from './replay.js';
import * as Store from './store.js';
import { TEST_CARD_LIB } from '../../engine/cards/test-cards.js';
import { nextSpeed } from './screens.js';

// ══════════════════════════════════════════════════════════
// 回放档案的增删改
// ══════════════════════════════════════════════════════════

function persistReplays(list) {
  if (Store.saveReplays(list)) { replays = list; return true; }
  return false;
}

function updateReplay(id, patch) {
  const list = replays.map((r) => (r.id === id ? { ...r, ...patch } : r));
  persistReplays(list);
}

function deleteReplay(id) {
  persistReplays(replays.filter((r) => r.id !== id));
}

// ══════════════════════════════════════════════════════════
// 回放播放
// ══════════════════════════════════════════════════════════

function openReplay(id) {
  const record = replays.find((r) => r.id === id);
  if (!record) return;
  if (!RP.isCompatible(record, TEST_CARD_LIB)) {
    view.hint = RP.incompatibleReason(record, TEST_CARD_LIB);
    refresh();
    return;
  }

  clearTimeout(bannerTimer);
  clearTimeout(autoAdvanceTimer);
  paused = false;

  replayCtx = {
    record,
    player: RP.createReplayPlayer(record, TEST_CARD_LIB),
    playing: false,
    speed: 1,
    timer: null,
  };
  screen = 'replay';
  refresh();
}

function stopReplay() {
  if (replayCtx && replayCtx.timer) clearTimeout(replayCtx.timer);
  replayCtx = null;
}

/** 播放速度 → 每步间隔毫秒 */
function replayDelay(speed) {
  return Math.max(60, Math.round(700 / speed));
}

function scheduleReplay() {
  if (!replayCtx) return;
  clearTimeout(replayCtx.timer);
  if (!replayCtx.playing) return;

  replayCtx.timer = setTimeout(() => {
    if (!replayCtx || !replayCtx.playing) return;
    const moved = replayCtx.player.next();
    if (!moved) {
      replayCtx.playing = false;
      refresh();
      return;
    }
    refresh();
    scheduleReplay();
  }, replayDelay(replayCtx.speed));
}

function toggleReplayPlay() {
  if (!replayCtx) return;
  if (replayCtx.player.atEnd()) replayCtx.player.reset();
  replayCtx.playing = !replayCtx.playing;
  refresh();
  scheduleReplay();
}

function stepReplay(delta) {
  if (!replayCtx) return;
  replayCtx.playing = false;
  clearTimeout(replayCtx.timer);
  replayCtx.player.seekTo(replayCtx.player.index + delta);
  refresh();
}

function cycleReplaySpeed() {
  if (!replayCtx) return;
  replayCtx.speed = nextSpeed(replayCtx.speed);
  refresh();
  if (replayCtx.playing) scheduleReplay();
}

/** 拖动进度条 */
function seekReplayTo(value) {
  if (!replayCtx) return;
  replayCtx.playing = false;
  clearTimeout(replayCtx.timer);
  replayCtx.player.seekTo(Number(value) || 0);
  refresh();
}

export {
  persistReplays, updateReplay, deleteReplay, openReplay, stopReplay, replayDelay,
  scheduleReplay, toggleReplayPlay, stepReplay, cycleReplaySpeed, seekReplayTo,
};
