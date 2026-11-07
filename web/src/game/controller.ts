/**
 * 对局控制器：包住旧引擎，给 React 提供「订阅 + 动作」的接口。
 *
 * 分工：
 *   · 规则、合法性、AI 决策全部由 `engine/` 与 `app/js/ai.js` 负责（原样复用）
 *   · 这里只管「什么时候轮到谁」「挂起的提问怎么喂回去」「什么时候通知界面重绘」
 *   · 顺手把每次动作新增的引擎日志翻成演出事件（见 game/fx.ts），界面拿去播动画
 */

import {
  G,
  buildTestDeck,
  TEST_CARD_LIB,
  aiTakeTurn,
  applyDifficultyBonus,
  installAiTargetPicker,
} from '../engine/bridge'
import { fxFromLog, snapshotUnits } from './fx'
import type { FxEvent, UnitPos } from './fx'

export interface GameOptions {
  seed?: number
  difficulty?: string
  /** 人类玩家的阵营 key（null = 中立） */
  humanFaction?: string | null
  /** AI 阵营 key */
  aiFaction?: string | null
  deckSize?: number
  humanSide?: number
  /** 双方强化增量（[side0, side1]，由 enhance.js 的 buildSideEnhance 生成） */
  enhance?: any
}

export interface PendingRequest {
  type: string
  prompt?: string
  options?: Array<Record<string, any>>
  side?: number
  [k: string]: any
}

export class GameController {
  state: any
  readonly humanSide: number
  readonly aiSide: number
  readonly difficulty: string
  readonly seed: number

  private listeners = new Set<() => void>()
  private version = 0

  // ── 演出事件队列 ────────────────────────────────────────
  private fxQueue: FxEvent[] = []
  private fxSeq = 1
  private mark: { logLen: number; positions: Map<number, UnitPos> }

  constructor(opts: GameOptions = {}) {
    const seed = opts.seed ?? Math.floor(Math.random() * 1e9)
    const difficulty = opts.difficulty ?? 'normal'
    const humanSide = opts.humanSide ?? 0
    const deckSize = opts.deckSize ?? 80

    const factions: any[] = humanSide === 0
      ? [opts.humanFaction ?? null, opts.aiFaction ?? null]
      : [opts.aiFaction ?? null, opts.humanFaction ?? null]

    // enhance 是引擎 setup.js 支持的入参，但 TS 侧的类型声明没跟上，这里放宽
    const state: any = (G.createGame as any)({
      seed,
      firstPlayer: seed % 2,
      deck: buildTestDeck(deckSize, seed),
      cardLib: TEST_CARD_LIB,
      shuffleDeck: true,
      factions: factions as string[],
      enhance: opts.enhance ?? null,
    })

    // 人类那一侧的问题是「挂起等人点」，AI 那一侧的问题由引擎自己算
    state.autoResolveChoices = false
    state.humanSide = humanSide
    state.aiSides = [1 - humanSide]

    this.state = state
    this.humanSide = humanSide
    this.aiSide = 1 - humanSide
    this.difficulty = difficulty
    this.seed = seed

    installAiTargetPicker(state)
    applyDifficultyBonus(state, this.aiSide, difficulty)
    G.startGame(state)

    // 开局产生的日志（发牌、回合开始）不当演出播
    this.mark = { logLen: state.log.length, positions: snapshotUnits(state) }

    this.afterStateChange()
  }

  // ── 订阅 ────────────────────────────────────────────────

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getSnapshot = (): number => this.version

  private emit(): void {
    this.version += 1
    for (const fn of this.listeners) fn()
  }

  // ── 查询 ────────────────────────────────────────────────

  get over(): boolean {
    return G.isOver(this.state) as boolean
  }

  get pending(): PendingRequest | null {
    const p = this.state.pending
    return p ? (p.request as PendingRequest) : null
  }

  /** 现在轮到人类行动（且没有挂起） */
  get isMyTurn(): boolean {
    return !this.over && !this.pending && G.getActor(this.state) === this.humanSide
  }

  /** 取走攒下的演出事件（界面每次重绘后调一次） */
  drainFx(): FxEvent[] {
    const out = this.fxQueue
    this.fxQueue = []
    return out
  }

  // ── 动作 ────────────────────────────────────────────────

  playCard(iid: number, opts: Record<string, any> = {}): { ok: boolean; error?: string } {
    if (!this.isMyTurn) return { ok: false, error: '现在不是你的行动阶段' }
    try {
      this.state.autoResolveChoices = false
      this.capture()
      G.playCard(this.state, this.humanSide, iid, opts)
      this.harvest()
    } catch (e: any) {
      this.harvest()
      this.emit()
      return { ok: false, error: String(e?.message ?? e) }
    }
    this.afterStateChange()
    return { ok: true }
  }

  brew(iids: number[]): { ok: boolean; error?: string } {
    try {
      this.capture()
      const r = G.brew(this.state, this.humanSide, iids) as any
      this.harvest()
      this.afterStateChange()
      if (r && r.error) return { ok: false, error: r.error }
      return { ok: true }
    } catch (e: any) {
      this.harvest()
      this.emit()
      return { ok: false, error: String(e?.message ?? e) }
    }
  }

  /** 回答引擎的提问（点选项面板） */
  answerChoice(answer: Record<string, any>): void {
    if (!this.pending) return
    try {
      this.capture()
      G.resolveChoice(this.state, answer)
      this.harvest()
    } catch (e) {
      console.error('[controller] resolveChoice 失败', e)
    }
    this.afterStateChange()
  }

  /** 结束当前阶段：推进阶段，AI 接管直到轮到我 */
  endPhase(): void {
    if (this.over) return
    if (this.pending) return
    try {
      this.capture()
      G.advance(this.state)
      this.harvest()
    } catch (e) {
      console.error('[controller] advance 失败', e)
    }
    this.afterStateChange()
  }

  surrender(): void {
    try {
      G.surrender(this.state, this.humanSide)
    } catch (e) {
      console.error('[controller] surrender 失败', e)
    }
    this.emit()
  }

  // ── 内部：演出事件的采集 ─────────────────────────────────

  private capture(): void {
    this.mark = { logLen: this.state.log.length, positions: snapshotUnits(this.state) }
  }

  private harvest(): void {
    const entries = this.state.log.slice(this.mark.logLen)
    if (entries.length > 0) {
      const events = fxFromLog(entries, this.mark.positions, () => this.fxSeq++)
      if (events.length > 0) {
        for (const ev of events) this.fxQueue.push(ev)
        // 防止长时间自动对局把队列撑爆
        if (this.fxQueue.length > 240) this.fxQueue.splice(0, this.fxQueue.length - 240)
      }
    }
    this.mark = { logLen: this.state.log.length, positions: snapshotUnits(this.state) }
  }

  // ── 内部：推进到人类可行动为止 ───────────────────────────

  private afterStateChange(): void {
    this.driveAi()
    this.emit()
  }

  private driveAi(): void {
    let guard = 0
    while (!this.over && guard++ < 200) {
      // 有挂起就先答掉（AI 回合里人类侧的提问按第一个选项代答）
      if (this.pending) {
        if (this.pending.side === this.humanSide && G.getActor(this.state) === this.humanSide) {
          return // 留给玩家点
        }
        this.autoAnswer()
        continue
      }
      const actor = G.getActor(this.state)
      if (actor === null) {
        try {
          this.capture()
          G.advance(this.state)
          this.harvest()
        } catch (e) {
          console.error('[controller] advance 失败', e)
          break
        }
        continue
      }
      if (actor !== this.aiSide) return

      try {
        this.state.autoResolveChoices = true
        this.capture()
        aiTakeTurn(this.state, this.aiSide, { difficulty: this.difficulty, maxPlays: 8 })
        this.harvest()
      } catch (e) {
        console.error('[controller] AI 出错', e)
        break
      }
      if (this.pending) {
        this.autoAnswer()
        continue
      }
      if (this.over) return
      try {
        this.capture()
        G.advance(this.state)
        this.harvest()
      } catch (e) {
        console.error('[controller] advance 失败', e)
        break
      }
    }
    this.state.autoResolveChoices = false
  }

  private autoAnswer(): void {
    const req = this.pending
    if (!req) return
    const options = req.options ?? []
    let answer: Record<string, any> = options[0] ?? {}
    if (typeof req.choose === 'function') {
      try {
        const picked = req.choose()
        if (picked) answer = picked
      } catch {
        /* 用第一个选项兜底 */
      }
    }
    try {
      this.capture()
      G.resolveChoice(this.state, answer)
      this.harvest()
    } catch (e) {
      console.error('[controller] 自动回答失败', e)
      // 防止死循环：直接把 pending 清掉
      this.state.pending = null
    }
  }
}
