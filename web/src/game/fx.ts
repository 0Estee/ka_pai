/**
 * 战斗演出：把引擎写到 `state.log` 里的结构化日志翻成界面能画的「演出事件」。
 *
 * 为什么走日志而不是 diff 局面：
 *   · 日志里有关键的因果信息（谁打了谁多少、因为什么被消灭），diff 只能看到结果；
 *   · 日志带 turn/phase，天然按顺序播放。
 *
 * 引擎的 damage 只带 uid 不带坐标，所以控制器要在**动作之前**存一份
 * uid → (lane,row,side) 的快照，飘伤害数字时用它定位。
 */

import { LANES, ROWS } from '../engine/bridge'

export interface UnitPos {
  lane: string
  row: string
  side: number
}

export type FxKind =
  | 'deploy'
  | 'cast'
  | 'damage'
  | 'heal'
  | 'destroy'
  | 'king-damage'
  | 'king-heal'
  | 'banner'

export interface FxEvent {
  id: number
  kind: FxKind
  lane?: string
  row?: string
  /** 单位归属方（0/1），用来区分我方/敌方半场 */
  side?: number
  amount?: number
  text?: string
  tone?: 'good' | 'bad' | 'neutral'
}

/** 记下场上每个单位的坐标（动作前拍一张，动作后对照） */
export function snapshotUnits(state: any): Map<number, UnitPos> {
  const out = new Map<number, UnitPos>()
  for (const lane of LANES) {
    const board = state.board?.[lane]
    if (!board) continue
    for (const side of [0, 1]) {
      for (const row of ROWS) {
        const u = board.units?.[side]?.[row]
        if (u) out.set(u.uid, { lane, row, side })
      }
    }
  }
  return out
}

export function fmtShort(v: number): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return '0'
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

/**
 * 日志 → 演出事件。只挑玩家看得懂的部分，其余（mana-tax / lane-lock 之类）略过。
 */
export function fxFromLog(
  entries: any[],
  before: Map<number, UnitPos>,
  nextId: () => number,
): FxEvent[] {
  const out: FxEvent[] = []
  const posOf = (uid: any): UnitPos | null => {
    if (uid == null) return null
    return before.get(Number(uid)) ?? null
  }

  for (const e of entries) {
    if (!e || !e.type) continue
    switch (e.type) {
      case 'deploy': {
        out.push({
          id: nextId(),
          kind: 'deploy',
          lane: e.lane,
          row: e.row,
          side: e.side,
          text: e.name,
          tone: 'good',
        })
        break
      }
      case 'cast': {
        out.push({
          id: nextId(),
          kind: 'cast',
          lane: e.lane ?? undefined,
          side: e.side,
          text: e.name,
          tone: 'neutral',
        })
        break
      }
      case 'damage': {
        const p = posOf(e.uid)
        if (!p) break
        const amt = Number(e.amount) || 0
        out.push({
          id: nextId(),
          kind: 'damage',
          lane: p.lane,
          row: p.row,
          side: p.side,
          amount: amt,
          text: '-' + fmtShort(amt),
          tone: 'bad',
        })
        break
      }
      case 'poison-tick':
      case 'burn-tick':
      case 'disease-tick': {
        const p = posOf(e.uid)
        if (!p) break
        const amt = e.type === 'disease-tick' ? 999 : Number(e.x) || 0
        out.push({
          id: nextId(),
          kind: 'damage',
          lane: p.lane,
          row: p.row,
          side: p.side,
          amount: amt,
          text: e.type === 'poison-tick' ? '毒' : e.type === 'burn-tick' ? '灼' : '病',
          tone: 'bad',
        })
        break
      }
      case 'heal': {
        const p = posOf(e.uid)
        if (!p) break
        const amt = (Number(e.to) || 0) - (Number(e.from) || 0)
        if (amt <= 0) break
        out.push({
          id: nextId(),
          kind: 'heal',
          lane: p.lane,
          row: p.row,
          side: p.side,
          amount: amt,
          text: '+' + fmtShort(amt),
          tone: 'good',
        })
        break
      }
      case 'king-damage': {
        const amt = Number(e.amount) || 0
        out.push({
          id: nextId(),
          kind: 'king-damage',
          side: e.side,
          amount: amt,
          text: '-' + fmtShort(amt),
          tone: 'bad',
        })
        break
      }
      case 'king-heal': {
        const amt = Number(e.amount) || 0
        if (amt <= 0) break
        out.push({
          id: nextId(),
          kind: 'king-heal',
          side: e.side,
          amount: amt,
          text: '+' + fmtShort(amt),
          tone: 'good',
        })
        break
      }
      case 'destroy': {
        out.push({
          id: nextId(),
          kind: 'destroy',
          lane: e.lane,
          row: e.row,
          side: e.side,
          text: e.name,
          tone: 'bad',
        })
        break
      }
      case 'turn-start': {
        out.push({
          id: nextId(),
          kind: 'banner',
          text: '第 ' + String(e.turn ?? '') + ' 回合',
          tone: 'neutral',
        })
        break
      }
      case 'combat-start': {
        out.push({ id: nextId(), kind: 'banner', text: '开战', tone: 'neutral' })
        break
      }
      default:
        break
    }
  }
  return out
}
