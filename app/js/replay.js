/**
 * 对局录制与回放。
 *
 * ── 为什么记「操作」而不是记「棋盘快照」────────────────────
 * 引擎是完全确定性的：所有随机数都来自 `state.rng`（由种子初始化），
 * AI 决策里唯一的随机项也是 `state.rng.state`，没有用 Math.random。
 * 所以**「初始牌库 + 种子 + 每一步操作」就足以精确复现整局**。
 *
 * 好处是体积差了将近 30 倍：
 *   操作日志 ≈ 3~6 KB / 局  →  5 MB 的 localStorage 存得下几百局
 *   棋盘快照 ≈ 150 KB / 局  →  存三十几局就满了
 * 作者要求「存所有的」，所以必须走操作日志这条路。
 *
 * ── 代价 ──────────────────────────────────────────────────
 * 操作里记的是手牌实例 id（iid），它由抽牌顺序决定。
 * 只要牌库构成不变，重放时 iid 一定对得上；牌库一变，旧回放就失效。
 * 所以每条回放都存一个 `cardSet` 指纹，对不上就标记为「不兼容」，
 * 只允许删除，不允许播放 —— 而不是播到一半崩掉。
 *
 * 依赖方向：engine ← replay（本文件不碰 DOM，可以单独测试）
 */

import * as G from '../../engine/src/engine.js';
import { applyBonusObject } from './ai.js';

/**
 * 回放记录格式版本。字段结构变了就 +1，旧记录会被标记为不兼容。
 *
 * v2：加了 `bonuses` —— 难度给 AI 的**额外优势**必须一起存。
 *     不存的话，有加成的对局重放到第 N 步会因为「费用不足」崩掉
 *     （AI 当年正是靠多出来的那点费用才打得出那张牌）。
 * v3：加了 `humanSide` —— **哪一方是真人**决定了引擎的哪些提问会挂起等人。
 *     以前回放里把它写死成 -1（两侧都不是真人），于是真人那一侧录下来的
 *     答案（`{k:'c'}`）在重放时找不到挂起的请求，直接报
 *     `当前没有待处理的交互请求` —— 这就是「出牌带选择的卡牌回放会错」。
 */
export const REPLAY_VERSION = 3;

/** 单局最多记多少步（防御性上限，正常一局 100~200 步） */
const MAX_ACTIONS = 4000;

/** 棋盘线路顺序（指纹里要稳定，不能依赖对象键序） */
const LANE_ORDER = ['mountain', 'plainL', 'plainR', 'water'];

/**
 * 牌库指纹：把所有卡牌 id 排序后做 FNV-1a 哈希。
 * 加卡 / 删卡 / 改 id 都会让它变化。
 */
export function cardSetId(cardLib) {
  const ids = Object.keys(cardLib || {}).sort();
  let h = 2166136261 >>> 0;
  for (const id of ids) {
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= 44; // 分隔符，避免 "ab"+"c" 和 "a"+"bc" 撞车
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

// ══════════════════════════════════════════════════════════
// 录制
// ══════════════════════════════════════════════════════════

/** 开一份新的录制。seed / firstPlayer / deck 必须和 createGame 用的完全一致。 */
export function newRecording({ seed, firstPlayer, deck, cardSet, bonuses, humanSide, opening, factions }) {
  return {
    v: REPLAY_VERSION,
    cardSet,
    seed,
    firstPlayer,
    deck: (deck || []).slice(),
    /**
     * 这份 `deck` 是**一局开始时已经洗好的牌库**（`game-flow.js` 先
     * `buildTestDeck(80, seed)` 抽子集、`createGame` 再洗一次，之后才存进录制）。
     * 所以重放时必须**原样照用、不能再洗**：再洗一次等于把牌库又打乱一遍，
     * 手牌与抽牌顺序全变，重放到第二步就报分叉。
     *
     * `true` = 「别再洗了」，`false`/缺省 = 「照种子自己洗」（早期格式，没有这份牌库）。
     */
    shuffled: true,
    /**
     * 开局**发牌之前**的一刻：`{ deck, rngState }`。
     *
     * 少了它，重建方只能「照种子自己洗牌自己发牌」，而它手里的 `deck` 是**已经洗过**的
     * 那一份、`rng` 却是**没动过**的 —— 两者的历史对不上，抽牌顺序从第一步就歪。
     * 存下它，重建方就能先把「发牌前的一刻」复原，再照原样发牌。
     *（旧格式没有这个字段，回落到「照种子自己洗」。）
     */
    opening: opening && opening.deck ? { deck: opening.deck.slice(), rngState: opening.rngState >>> 0 } : null,
    // 哪一方是真人（决定重放时哪些提问会挂起等人），-1 = 没有真人
    humanSide: humanSide === undefined ? 0 : humanSide,
    /**
     * 双方的阵营（数组下标就是座位号，见 engine/src/factions.js）。
     * 少了它，重建这一局时双方都抽不到超能力 / 抽到的是别人的那一套，
     * 而超能力是**发牌之后第一件事**就进手牌的，往后每一步都会分叉。
     */
    factions: (factions || []).slice(),
    // 难度给 AI 的额外优势（[{side, hand, manaPerTurn, kingHp}]），重放时要原样加回去
    bonuses: (bonuses || []).map((b) => ({ ...b })),
    /**
     * 这一局里**每一问的答案流水**（`[{type, v}]`），真人点的与引擎代答的混在一起、
     * 按提问顺序排。回放靠它逐问装回，见 `createReplayPlayer` 的 `replayChooser`。
     */
    choiceLog: [],
    actions: [],
    // 下面这些在 finish() 时填
    startedAt: Date.now(),
    endedAt: null,
    winner: null,
    winReason: '',
    turns: 0,
    settled: false,
  };
}

/** 只保留引擎真正需要的字段，避免把 undefined 也塞进存档 */
function compactOpts(opts) {
  const o = {};
  if (!opts) return o;
  if (opts.lane !== undefined) o.lane = opts.lane;
  if (opts.row !== undefined) o.row = opts.row;
  if (opts.targetUid !== undefined) o.targetUid = opts.targetUid;
  if (opts.targetKing !== undefined) o.targetKing = opts.targetKing;
  return o;
}

export function recPlay(rec, side, iid, opts) {
  if (!rec || rec.actions.length >= MAX_ACTIONS) return;
  rec.actions.push({ k: 'p', s: side, i: iid, o: compactOpts(opts) });
}

export function recAdvance(rec) {
  if (!rec || rec.actions.length >= MAX_ACTIONS) return;
  rec.actions.push({ k: 'a' });
}

export function recChoice(rec, choice) {
  if (!rec || rec.actions.length >= MAX_ACTIONS) return;
  rec.actions.push({ k: 'c', v: choice });
}

/**
 * 记一条「已经成型的」操作。
 *
 * 联机协议里传的就是这个格式（见 docs/联机协议.md §4），
 * 和回放里存的操作**完全一样** —— 所以联机和回放本质是同一件事，
 * 这里不需要再转一道，转换多一次就多一个不一致的机会。
 */
export function recAction(rec, action) {
  if (!rec || !action || rec.actions.length >= MAX_ACTIONS) return;
  if (action.k === 'p') {
    rec.actions.push({ k: 'p', s: action.s, i: action.i, o: compactOpts(action.o) });
  } else if (action.k === 'a') {
    rec.actions.push({ k: 'a' });
  } else if (action.k === 'x') {
    // 主动献祭（恶魔阵营的界面按钮）：谁把场上的哪个单位献祭了
    rec.actions.push({ k: 'x', s: action.s, u: action.u });
  } else if (action.k === 'c') {
    rec.actions.push({ k: 'c', v: action.v });
    /**
     * ⚠ **不要**把真人的答案也塞进 `choiceLog` —— 这是踩了很久才找到的坑。
     *
     * `choiceLog` 只装**引擎自己代答的**那些问（AI 侧、自动阶段），
     * 真人的答案只装 `actions` 里的 `{k:'c'}`，两条通道各管各的：
     *   · 回放遇到「流水里还有条目」→ 那是引擎代答的，照原样装回去；
     *   · 回放遇到「流水用尽」→ 说明实战里这一问是**挂起等真人**的，
     *     于是原样挂起，由紧随其后的 `{k:'c'}` 喂回来。
     *
     * 把真人答案两边都记，这第二路就废了：回放分不清「流水里这条是引擎答的，
     * 还是真人答的」，于是把真人条目当成引擎代答**就地吃掉**，
     * 紧接着的 `{k:'c'}` 就变成孤儿，报 `当前没有待处理的交互请求`；
     * 或者反过来把引擎代答的当真人条目而挂起，实战却没人答 → 卡死。
     */
  }
  /**
   * 自检用：把「这一刻的局面指纹」按记录条数存下来（见 main.js 的 `__snapLive`）。
   *
   * 必须**在这里**存，不能在外部按「记录条数变没变」观察着存 ——
   * `tick()` 里一次循环可能连着推进好几个阶段（AI 侧尤其如此），
   * 等外部看到时局面已经走到好几步之后了，存下来的位置全错。
   * 调用方在跑对拍之前把 `window.__liveDigests` 设成数组即可；
   * 没设（正常玩）就完全不做这件事。
   */
  if (typeof window !== 'undefined' && Array.isArray(window.__liveDigests) && !window.__liveDigests[rec.actions.length]) {
    window.__snapLiveAt(rec.actions.length);
  }
}

/** 收尾：填入结果。返回可以直接存进档案的纯数据对象。 */
export function finishRecording(rec, state) {
  rec.endedAt = Date.now();
  rec.winner = state.winner;
  rec.winReason = state.winReason || '';
  rec.turns = state.turn;
  rec.settled = true;
  return {
    v: rec.v,
    cardSet: rec.cardSet,
    seed: rec.seed,
    firstPlayer: rec.firstPlayer,
    deck: rec.deck,
    /**
     *  下面这四个字段**以前漏了**，而它们是 `createReplayPlayer` 重建这一局时
     *   必须要读的  漏掉的后果是「**存档里的回放**播不对」：
     *      shuffled  少了它，重建时会把**已经洗好的牌库再洗一遍**，手牌全变
     *      opening   少了它，只能「照种子自己洗牌自己发牌」，rng 与牌库的历史
     *                 对不上，**抽牌顺序从第一步就歪**
     *      choiceLog 少了它，回放里每一问都落进「流水用尽」兜底  真人当时选的
     *                 第 2 项被换成第 1 项，紧随其后的 `{k:'c'}` 成了孤儿，
     *                 报 `当前没有待处理的交互请求`
     *      humanSide 少了它，联机（客人是 1 号）会错认成 0 号
     *   为什么以前没被发现：内存里那份 `recording` 是完整的，只有「录完  存进
     *   档案  再播」这条路才暴露  而当时的自检偏偏是拿内存那份在验。
     *   （`__replayVerifyLive` 后来加了 recordOverride，门禁里现在两条路都验。）
     */
    shuffled: rec.shuffled,
    opening: rec.opening,
    humanSide: rec.humanSide,
    factions: rec.factions || [],
    choiceLog: rec.choiceLog,
    bonuses: rec.bonuses || [],
    actions: rec.actions,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    winner: rec.winner,
    winReason: rec.winReason,
    turns: rec.turns,
  };
}

// ══════════════════════════════════════════════════════════
// 档案操作（纯数据，不碰存储）
// ══════════════════════════════════════════════════════════

export function makeReplayId() {
  return `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** 这条回放能不能在当前版本的卡牌库上播放 */
export function isCompatible(record, cardLib) {
  if (!record) return false;
  if (record.v !== REPLAY_VERSION) return false;
  if (record.cardSet !== cardSetId(cardLib)) return false;
  return Array.isArray(record.actions) && record.actions.length > 0;
}

/** 不兼容的原因（给界面显示） */
export function incompatibleReason(record, cardLib) {
  if (!record) return '记录为空';
  if (record.v !== REPLAY_VERSION) return `旧版记录（v${record.v}），当前 v${REPLAY_VERSION}`;
  if (record.cardSet !== cardSetId(cardLib)) return '卡牌库已变动，无法复现';
  if (!Array.isArray(record.actions) || record.actions.length === 0) return '没有记录到操作';
  return '';
}

/** 人话描述结果 */
export function describeWinner(record) {
  if (record.winner === null || record.winner === undefined) return '未完成';
  if (record.winner === 'draw') return '平局';
  return record.winner === 0 ? '玩家0 胜' : '玩家1 胜';
}

// ══════════════════════════════════════════════════════════
// 播放
// ══════════════════════════════════════════════════════════

/**
 * 播放器：重建一个同种子、同牌库的对局，然后按记录逐步重放操作。
 *
 * 刻意做成「从头重建 + 重放 N 步」而不是「缓存快照」：
 * 一局只有几十步，重放本身是毫秒级的，换来的实现简单得多。
 */
export function createReplayPlayer(record, cardLib) {
  let state = null;
  let index = 0;
  let error = '';
  /** `state.choiceLog` 的读数游标：录那一局时引擎自己答的每一问，按顺序装回来 */
  let replayCursor = 0;

  /**
   * 录制流里紧跟着的那条答案 —— **只在这一问确实需要它的时候**才消费。
   *
   * 判据（`applicableAnswer`）：答案与某个选项完全相同，或者带着
   * `index` / `uid` / `king` / `lane` / `row` 这类**答案特征字段**。
   *
   * 为什么必须验一下才消费：录制流里的 `{k:'c'}` 来自**真人那一侧**的提问，
   * 而回放里「引擎自己答掉、本来不进录制」的提问（AI 那一侧的选目标）
   * 也会经过这个口子。如果不验，一条 AI 侧的提问就会白白吃掉后面那条
   * 属于真人的答案，之后整条流**错位**，报出更难查的错。
   * 对了不上就**不消费**：留给 `applyOne` 的 `{k:'c'}` 分支去处理（那里会明确报错）。
   */
  function recordedAnswer(req) {
    const ans = record.actions[index];
    if (!ans || ans.k !== 'c') return undefined;
    if (!applicableAnswer(req, ans.v)) return undefined;
    index++;
    return ans.v;
  }

  /**
   * 录制里那条答案**是不是真的对应这一问**？
   *
   * 判据：与某个选项完全相同（快照进 cardLib 的对象会走 JSON 比较），
   * 或者带着 `index` / `uid` / `king` / `lane` 这类**答案特征字段**。
   */
  function applicableAnswer(req, v) {
    if (!v || typeof v !== 'object') return false;
    const key = (o) => JSON.stringify(o);
    for (const o of req.options || []) if (key(o) === key(v)) return true;
    return ['index', 'uid', 'king', 'lane', 'row'].some((k) => v[k] !== undefined);
  }

  /**
   * `state.chooser`：驱动器在每个提问上做的裁定 —— 「这一问是谁答的」。
   *
   * 两路答案**分别对齐、绝不交叉**：
   *   · `record.choiceLog` 只装**引擎自己代答**的问（AI 侧选目标、自动阶段的
   *     弃牌/抉择）。流水里还有条目 → 照原样装回去。
   *   · 流水**用尽** → 实战里这一问是**挂起等真人**的（真人那一问不会进流水，
   *     只进 `actions` 的 `{k:'c'}`）。于是这里原样挂起，由紧随其后的
   *     `{k:'c'}` 用 `G.resolveChoice` 喂回来。
   *
   * 为什么非要这一个口子：`takeChoice` 不认「哪一方是真人」，只要
   * `autoResolveChoices` 是 true，「抉择」和真人那侧的选目标请求都会被它
   * 「取第一个选项」静默答掉 —— 真人选的第 2 项就丢了，而实战里那一问是挂起的
   *（`play-input.js` 出牌前把 `autoResolveChoices` 关掉），录下来的 `{k:'c'}`
   * 因此变成孤儿，重放到它报 `当前没有待处理的交互请求`。
   * **这就是「出牌带选择的卡牌回放会错」。**
   *
   * ⚠ 挂起必须返回 `G.PENDING`，**不能返回 `undefined`**：返回 `undefined`
   * 会落进 `takeChoice` 的 `autoResolveChoices` 分支被静默代答，症状同上。
   */
  function replayChooser(request) {
    const log = Array.isArray(state.choiceLog) ? state.choiceLog : null;
    if (globalThis.__log) globalThis.__log.push(`ask@idx${index} ${request.type} cursor=${replayCursor} n=${log ? log.length : '-'} next=${log && log[replayCursor] ? JSON.stringify(log[replayCursor]) : '-'}`);
    if (log && replayCursor < log.length) {
      const entry = log[replayCursor];
      replayCursor++;
      if (entry && entry.hang) {
        if (Array.isArray(state.qTrace)) state.qTrace.push(`h@${state.stats ? state.stats.cardsPlayed : '?'}:${request.type}${request.noAuto ? '!' : ''}`);
        if (globalThis.__log) globalThis.__log.push(`ask@idx${index} ${request.type} → 流水[${replayCursor - 1}] 记的是「挂起等人」→ 原样挂起`);
        return G.PENDING;
      }
      if (Array.isArray(state.qTrace)) state.qTrace.push(`a@${state.stats ? state.stats.cardsPlayed : '?'}:${request.type}${request.noAuto ? '!' : ''}`);
      if (globalThis.__log) globalThis.__log.push(`ask@idx${index} ${request.type} → 流水[${replayCursor - 1}] ${JSON.stringify(entry && entry.v)}`);
      return entry ? entry.v : {};
    }
    /**
     * 流水用尽 —— 正常一局不该发生（盘上那份流水就是**完整的裁定流**：
     * 引擎答的记答案、挂起等人的记 `hang`，一问不落）。
     *
     * 真走到这里说明流水比你手上这份录制短（例如旧版本录的、或中途换过录制），
     * 那就退回引擎自己的策略：宁可让画面继续走下去，也不要停在某一帧不动
     *（用户只看到「播不动了」，比画面走歪更难查）。
     */
    if (Array.isArray(state.qTrace)) state.qTrace.push(`f@${state.stats ? state.stats.cardsPlayed : '?'}:${request.type}${request.noAuto ? '!' : ''}`);
    if (globalThis.__log) globalThis.__log.push(`ask@idx${index} ${request.type}（流水用尽）→ 引擎策略`);
    /**
     * ⚠`noAuto` 的请求**不许**在这里代答 —— 引擎的规矩是「它必须由真人回答，
     * 自动代答一律不碰」（见 engine/src/choices.js）。流水里没有它，只能原样挂起，
     * 交给录制流里紧随其后的 `{k:'c'}`；真没有的话，`flushPending` 会按
     * 「流水到头 + 终局已定」收尾、或者明确报错 —— 两种情况都比
     *「悄悄替真人选一个」忠实。
     */
    if (request.noAuto) {
      if (globalThis.__log) globalThis.__log.push(`ask@idx${index} ${request.type}（流水用尽且 noAuto）→原样挂起`);
      return G.PENDING;
    }
    if (typeof request.choose === 'function') {
      const picked = request.choose();
      if (picked) return picked;
    }
    return (request.options || [])[0] ?? {};
  }

  function build() {
    state = G.createGame({
      seed: record.seed,
      firstPlayer: record.firstPlayer,
      deck: (record.deck || []).slice(),
      factions: (record.factions || []).slice(),
      cardLib,
      // 录制里存的就是**洗好的**牌库，不能再洗（见 newRecording 的 `shuffled`）
      shuffleDeck: !record.shuffled,
    });
    /** 自检用：回放这一路「每一问的裁定」流水（与实战那份逐问对照，见 takeChoice 的 hold/holdHang） */
    state.qTrace = [];
    /**
     * 把「开局发牌前的一刻」原样复原 —— 必须**在 `startGame` 之前**。
     *
     * 为什么：`startGame` 会发起手牌（先手 5 张、后手 4 张）并推进 `state.rng`。
     * 实战里那一步是在「洗好的牌库 + 已经消耗过洗牌随机数的 rng」之上做的；
     * 重建方如果照种子自己洗牌，牌库虽然一样，**rng 的位置却不一样**，
     * 后面每一次抽牌 / 随机判定都会错开一位。存下来的 `opening` 就是为了对齐这一刻。
     */
    if (record.opening && record.opening.deck) {
      state.deck = record.opening.deck.slice();
      state.rng.state = record.opening.rngState >>> 0;
    }
    G.startGame(state);
    // 难度给 AI 的额外优势要**原样加回去** —— 否则那局里靠多出来的费用
    // 才打出去的那一步，重放时会报「费用不足」。
    for (const b of record.bonuses || []) applyBonusObject(state, b.side, b);
    /**
     * 提问由 `replayChooser` 统一裁定（**录制答案优先**），所以这里保持
     * 「引擎自己没法做的选择交给驱动器」的开关为 true —— 与实战一致。
     *
     * ⚠ 不能只靠 `autoResolveChoices = true` 本身：它会在 `takeChoice` 里
     * 「取第一个选项」把「抉择」和 `noAuto` 请求静默答掉，真人选的第 2 项
     * 就此丢失，而录下来的 `{k:'c'}` 还在流里 —— 它成了孤儿，重放到它报
     * `当前没有待处理的交互请求`。这正是「出牌带选择的卡牌回放会错」。
     * 所以必须在它**之前**插一个认录制的裁定者（`takeChoice` 里的 `state.chooser`，
     * 顺序见 engine/src/choices.js 的 takeChoice）。
     */
    /**
     * ⚠ `autoResolveChoices` 必须是 **false**，让 `state.chooser`（下面那行）
     * 成为**唯一的裁定者**。
     *
     * 为什么：实战里「同一问挂不挂起」取决于调用方当时把
     * `state.autoResolveChoices` 开成了什么（真人出牌前会关掉，见
     * `app/js/play-input.js` 的 `commitPlay`），回放播放器**无从知道**当时的状态。
     * 一旦这里开着 true，就出现「实战挂起、回放静默代答」（或反过来）——
     * 两边从那里开始整体错开，最后报「有挂起的交互请求，但没法回答」，
     * 或者只是悄悄少抽一张牌。这正是「出牌带选择的卡牌回放会错」的机制。
     *
     * 关掉它之后，每一问都由 `replayChooser` 按盘上那份**完整裁定流**
     *（`record.choiceLog`：引擎答的记答案、挂起等人的记 `hang`）装回，
     * 与那一局的时序逐问对齐。引擎自己那条代答路径不再参与。
     */
    state.autoResolveChoices = false;
    state.chooser = replayChooser;
    /**
     * 把录那一局时**引擎自己答掉的每一问**装回来（见 `choices.js` 的 `takeChoice`）。
     *
     * 这是「出牌带选择」回放错的第二个成因：`{k:'c'}` 只记真人点的那一下，
     * 引擎代答的（AI 侧 `chooseEnemyTarget`、被自动代答的 `chooseOption` 等）
     * 都不在流里 → 回放里同一问只能自己乱选 → 目标打错、`nextIid` 与抽牌全线错开。
     */
    replayCursor = 0;
    /**
     * ⚠ **不能**把它压成 `e.v`！`type` 是「这一问是真人答的还是引擎代答的」的
     * 唯一凭据，丢了两条路就分不开家：`replayChooser` 会把真人条目也当成
     * 引擎代答**就地吃掉**，于是紧随其后的 `{k:'c'}` 变成孤儿，
     * 报 `当前没有待处理的交互请求`；也可能只是悄悄少抽/多抽一张牌
     *（`nextIid` 差 1，症状更难查）。
     *
     * 兼容旧形状：`{v:…}` 对象或裸答案都归一成 `{type,v}`。
     */
    /**
     * ⚠ 归一化要认 `hang`，**不能只看有没有 `v`** —— 这个条件写错会让整条修法失效。
     *
     * 盘上那份流水（`choiceLog`）是一份**完整的裁定流**，两种条目：
     *   · 引擎自己答的 → `{ type:'chooseHandCard', v:{iid:…} }`（有 `v`）
     *   · 挂起等真人的 → `{ type:'chooseEnemyTarget', hang:true }`（**没有 `v`**）
     *
     * 早先这里写的是 `'v' in e && typeof e.type === 'string'`，于是 `hang` 条目
     * 被判成「旧形状的裸答案」，又被包一层变成 `{type:'engine', v:{…,hang:true}}` ——
     * `hang` 从此藏在 `v` 里面，`replayChooser` 再也看不见它，于是把本该挂起等人的
     * 那一问**就地代答**掉，紧接着的 `{k:'c'}` 变成孤儿。症状就是
     * `当前没有待处理的交互请求`，和没修之前一模一样（只是换了地方报）。
     *
     * 兼容旧形状：没有 `hang`、也没有 `type` 的裸答案包成 `{type:'engine', v: e}`。
     */
    state.choiceLog = Array.isArray(record.choiceLog)
      ? record.choiceLog.map((e) => {
        if (!e || typeof e !== 'object') return { type: 'engine', v: e };
        if (e.hang) return e;
        if ('v' in e && typeof e.type === 'string') return e;
        return { type: 'engine', v: e };
      })
      : null;
    globalThis.__log = [];
    if (typeof window !== 'undefined') window.__missLog = [];
    /**
     * **哪一方是真人，必须和录那一局时一致**：引擎靠它决定哪些提问会挂起等人
     * （`noAuto` 与「抉择」）。以前这里写死成 -1（两侧都不是真人），于是真人那一侧
     * 录下来的 `{k:'c'}` 在重放时**根本找不到挂起的请求**，直接报
     * `当前没有待处理的交互请求` —— 这就是「出牌带选择的卡牌回放会错」的根。
     *
     * 为什么不能靠「把外部的 humanSide 排除掉」来绕：它是**引擎读的状态**，
     * 回放里读到的值必须与那一局一致，否则挂起与代答的分支就分了家。
     * 旧记录（v2 及以前）没有这个字段，回落到 0 —— 那些记录本来就会被
     * 版本号判为不兼容，走不到这里。
     */
    state.humanSide = record.humanSide === undefined ? 0 : record.humanSide;
    index = 0;
    error = '';
  }

  /**
   * 录制里**紧接着**的那一条，是不是「这一问的答案」。
   *
   * 是的话就**不能**在 `flushPending` 里顺手把它吃掉 —— 它是一条独立的记录，
   * 必须留给下一次 `next()` 去应用（理由见 `flushPending`）。
   */
  function nextIsRecordedAnswer() {
    const a = record.actions[index];
    return !!(a && a.k === 'c');
  }

  /**
   * 录制里没有对应答案时，用**引擎自己的策略**把当前挂起的请求答掉。
   *
   * 为什么会有这种情况：引擎里有些提问是「必须由真人回答」的（请求带 `noAuto`），
   * 它挂不挂起取决于**当时那一方是不是真人**；而回放播放器是在「内存里那一局」的
   * 上下文里跑的（`humanSide` 可能已经被别的用例改过），于是同一份回放在不同时机播
   * 会走到不同的分支。用引擎策略兜底之后，重放就与外部状态无关了。
   *
   * 返回是否成功答掉了一个请求。
   */
  function answerPendingWithStrategy() {
    const req = state.pending.request;
    if (typeof req.choose === 'function') {
      const picked = req.choose() || (req.options || [])[0];
      if (picked) {
        G.resolveChoice(state, picked);
        return true;
      }
    }
    return false;
  }

  /**
   * 把「这一步留下来的挂起请求」清干净 —— **但紧随其后有答案的那些不算**。
   *
   * 一次出牌 / 一次推进都可能**连续留下多个**挂起请求（一局里有多只强化士兵，
   * 一只问完还有下一只），所以这里要循环。
   *
   * ⚠循环里必须先看「下一条记录是不是答案」：
   *   真人答的那一问，在实战里被记成**紧随其后**的一条 `{k:'c'}`，
   *   而 `__replayVerifyLive` 的对拍口径是「**一条记录 = 一步**」——
   *   它拿「实战走完第 N 条记录之后的指纹」比「回放走完第 N 步之后的指纹」。
   *   所以这一问必须**原样挂着**走完这一步，由下一次 `next()` 应用那条 `{k:'c'}`；
   *   在这里顺手答掉，这一步就会多吃一条记录，指纹当场对不上。
   *
   * 踩过的坑（这就是「出牌带选择的卡牌回放会错」的最后一层）：
   *   早先这里是**先**调 `answerPendingFromRecord()`、**后**推 `index`，
   *   于是它拿 `record.actions[index]` 找答案时，读到的还是**刚应用的那条出牌本身**
   *   （`{k:'p'}` / `{k:'a'}`），而不是紧随其后的 `{k:'c'}`：
   *     · 请求带 `choose`（`combatTarget` 那种）→ 被引擎**按自己的策略**答掉，
   *       真人点的那个目标就此丢失，紧接着的 `{k:'c'}` 变成孤儿；
   *     · 请求不带 `choose`（`chooseUnit` / `chooseEnemyTarget` 这类）→ 直接报
   *       「有挂起的交互请求，但没法回答」。
   *   两种症状同源：**游标没先推过当前这条记录**。
   *   （另外，当前这条本身就是 `{k:'c'}` 时，旧写法会把它**再吃一遍** ——
   *    同一答案喂给两个提问。）
   */
  function flushPending(before) {
    while (state.pending) {
      // 下一条就是这一问的答案 → 原样挂着，交给下一次 next()
      if (nextIsRecordedAnswer()) return true;
      /**
       * 录制流已经到头，而这一局**终局已定** —— 那就原样收尾，不算错。
       *
       * 实战里真的会这样结束（约两成对局）：一张牌打到一半还剩一个提问，
       * 而这一半已经把对手的国王打到 0 了（`winner` 由**下一次出牌开头**的
       * `checkGameOver` 补上，不是这一问之前就有的）。玩家看到的是结算画面，
       * 那一问**再也没人答**，于是录制里「出牌」就是最后一条。
       * 这份录制是**忠实**的，回放就该停在同一个位置，不该报「推不动」。
       *
       * 判据必须同时满足两条：流水到头（`index` 用尽）+ 终局已定。
       * 终局未定却没人答，那是真的缺记录（录制被截断 / 操作流分叉），照旧报错。
       */
      if (index >= record.actions.length && state.winner !== null) {
        if (globalThis.__log) globalThis.__log.push(`flushPending：录制到头且终局已定（winner=${state.winner}），这一问实战里也没答 → 原样收尾`);
        return true;
      }
      if (!answerPendingWithStrategy()) {
        /**
         * 推不动了。必须**明确失败**，不能返回「成功」——`next()` 的返回值是
         * 「有没有前进」的信号，假装前进会让播放器的 while 循环空转到死
         * （真的发生过：整个集成测试卡住不返回）。
         */
        error = `第 ${before + 1} 步重放失败：有挂起的交互请求，但没法回答（回放里没有答案，引擎也没给策略）`;
        if (globalThis.__log) globalThis.__log.push(`flushPending 推不动：pending=${state.pending.request.type} 下一条动作=${JSON.stringify(record.actions[index] || null)}`);
        return false;
      }
    }
    return true;
  }

  function applyOne() {
    const a = record.actions[index];
    if (!a) return false;
    const before = index;
    if (globalThis.__log) globalThis.__log.push(`apply at=${index} before=${before} k=${record.actions[index].k} pend=${!!state.pending} phase=${state.phase}`);
    try {
      if (a.k === 'a') {
        G.advance(state);
      } else if (a.k === 'p') {
        G.playCard(state, a.s, a.i, a.o || {});
      } else if (a.k === 'c') {
        G.resolveChoice(state, a.v);
      } else if (a.k === 'x') {
        G.sacrificeUnit(state, a.s, a.u);
      } else {
        error = `第 ${before + 1} 步重放失败：未知操作 ${a.k}`;
        return false;
      }
      /**
       * ⚠游标必须**先推过这一条**，再去处理它引出的挂起请求（见 `flushPending`）。
       * 顺序反了就会读错答案 —— 这是「出牌带选择的卡牌回放会错」的根因。
       */
      index++;
      // 出牌 / 推进中途的「反问」照原样挂起，这里把录制里的答案逐条喂回去
      if (!flushPending(before)) return false;
      return true;
    } catch (err) {
      error = `第 ${before + 1} 步重放失败：${err.message}`;
      return false;
    }
  }

  build();

  return {
    get state() { return state; },
    get index() { return index; },
    get total() { return record.actions.length; },
    get error() { return error; },
    atEnd() { return index >= record.actions.length; },

    /**
     * 当前局面的指纹（见 `replayDigest`）。
     * 校验回放是否忠实，靠的就是「同一位置 → 同一指纹」。
     */
    digest() { return replayDigest(state); },

    /** 前进一步；返回是否真的动了 */
    next() {
      if (error || this.atEnd()) return false;
      const r = applyOne();
      if (globalThis.__log) globalThis.__log.push(`next -> ${r} idx=${index} phase=${state.phase} err=${error}`);
      return r;
    },

    /** 跳转到第 n 步（0 = 开局），从零重建 */
    seekTo(n) {
      const target = Math.max(0, Math.min(record.actions.length, n | 0));
      build();
      while (index < target) if (!applyOne()) break;
      return index;
    },

    /** 重放到结束 */
    toEnd() {
      return this.seekTo(record.actions.length);
    },

    reset() { build(); },
  };
}

/** 估算一条回放占多少字节（存进档案前提示用） */
export function estimateBytes(record) {
  try {
    return JSON.stringify(record).length * 2;
  } catch {
    return 0;
  }
}

/**
 * 局面指纹（自检/回归测试用）：**只由「这一局本身」决定**的那个字符串。
 *
 * 与 `multiplayer.js` 的 `stateSignature` 的区别（两者用途不同，别混用）：
 *   · `stateSignature` 是**联机校验**用的，比对局双方手头各自的局面，
 *     故意做得粗（只看回合、阶段、线路上的单位数值），且它读的是**正在玩的那一局**。
 *   · 这里给**回放对拍**用，要求「同一串操作 → 同一个指纹」，所以：
 *     - 必须把**全部**会分叉的东西都算进去（手牌顺序与 iid、牌库、费用、双方血量、
 *       场上单位的位置与数值、还有 `rng` 的内部状态 —— 引擎靠它做随机决策，
 *       它一分叉，后面的随机结果就全歪了）；
 *     - 反过来必须**排除掉「跟这一局无关的应用层开关」**：`humanSide`、
 *       `autoResolveChoices`、`chooser`。它们是「谁来答这一问」的开关，
 *       实战与回放**本来就该不同**（实战等真人点，回放照录制喂），
 *       把它们算进来会让校验器每一次都误报分叉。
 *     - 也不含 `pending`：它只是「有请求等着答」的瞬时状态，不是局面。
 *
 * 踩过的坑：早先用 `stateSignature` 对拍，`humanSide` 一实战 0 / 回放 -1
 * 就被判成分叉，白白追了一轮。
 */
export function replayDigest(s) {
  if (!s) return '';
  const card = (c) => (c ? `${c.cardId}:${c.atk}:${c.hp}:${c.maxHp}` : '-');
  const arr = (v) => (Array.isArray(v) ? v : []);
  const side = (sd) => (sd === null || sd === undefined ? '' : [
    arr(sd.front).map(card).join(','),
    arr(sd.back).map(card).join(','),
  ].join('/'));
  const board = LANE_ORDER.map((l) => `${l}{${side(s.board[l].units[0])}|${side(s.board[l].units[1])}}`).join('');
  const player = (p) => (p ? [
    p.kingHp,
    p.mana,
    (p.deck || []).length,
    (p.hand || []).map((c) => `${c.iid}=${c.cardId}`).join(','),
    (p.discard || []).length,
  ].join('~') : '-');
  const rng = s.rng && s.rng.state !== undefined ? s.rng.state : (s.rngState !== undefined ? s.rngState : '');
  return [
    `t${s.turn}`, `ph${s.phase}`, `w${s.winner}`, `fp${s.firstPlayer}`,
    `n${s.nextIid}`, `st${s.stats ? (s.stats.cardsPlayed || 0) : ''}`,
    `rng${rng}`, `p0[${player(s.players[0])}]`, `p1[${player(s.players[1])}]`, `b${board}`,
  ].join('|');
}
