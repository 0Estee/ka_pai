/**
 * 引擎桥接层：把旧的纯 JS 规则引擎与卡牌库接进 React 应用。
 *
 * 规则引擎、卡牌数据、AI、强化、经济都是 `E:/ka_pai/engine` 与 `E:/ka_pai/app/js` 里
 * 现成的 ES Module —— **原样复用，不复制、不改写**。
 * 这一层只做「类型标注 + 常用查询封装」，不含任何规则逻辑。
 */

import * as G from '@engine/engine.js'
import { LANES, ROWS, LANE_NAME, PHASES, SIDE_NAME } from '@engine/constants.js'
import { TEST_CARD_LIB, buildTestDeck, AUTHOR_CARDS, DECKABLE_CARDS } from '@cards/test-cards.js'
import { FACTIONS } from '@engine/factions.js'
import { KEYWORD_DEFS } from '@engine/keywords.js'
import {
  aiTakeTurn,
  DIFFICULTIES,
  difficultyByKey,
  applyDifficultyBonus,
  installAiTargetPicker,
} from '@app/ai.js'

export { G, LANES, ROWS, LANE_NAME, PHASES, SIDE_NAME, FACTIONS, KEYWORD_DEFS }
export { TEST_CARD_LIB, buildTestDeck, AUTHOR_CARDS, DECKABLE_CARDS }
export { aiTakeTurn, DIFFICULTIES, difficultyByKey, applyDifficultyBonus, installAiTargetPicker }

/** 强化工坊（纯函数，不碰 DOM、不碰存档格式） */
export * as Enhance from '@app/enhance.js'
/** 金币 / 星尘 / 表现分结算 */
export * as Economy from '@app/economy.js'

export interface CardDef {
  id: string
  name: string
  type: 'unit' | 'spell' | 'trap'
  cost: number
  atk?: number
  hp?: number
  keywords?: Array<string | { id: string; x?: number }>
  text?: string
  faction?: string | null
  token?: boolean
  legacy?: boolean
  spellKind?: string
  effects?: Array<Record<string, any>>
  actions?: Array<Record<string, any>>
}

export interface HandCard {
  iid: number
  cardId: string
  costDelta?: number
  statDelta?: { atk?: number; maxHp?: number }
}

export interface UnitView {
  uid: number
  name: string
  atk: number
  baseAtk: number
  hp: number
  maxHp: number
  keywords: string[]
  marks: string[]
  /** 引擎的 describeUnit 不带它，由 viewOf 补上（卡牌详情要用） */
  cardId?: string
}

export interface LaneView {
  mine: Array<UnitView | null>
  foe: Array<UnitView | null>
}

export interface View {
  turn: number
  phase: string
  actor: number | null
  deckLeft: number
  me: { kingHp: number; kingMaxHp: number; mana: number; manaCap: number; hand: string[] }
  foe: { kingHp: number; kingMaxHp: number; mana: number; manaCap: number; handCount: number }
  board: Record<string, LaneView>
  pending: { type: string; prompt?: string } | null
  winner: number | 'draw' | null
}

export interface LegalPlace {
  lane: string
  row: string
}

export interface LegalPlay {
  iid: number
  cardId: string
  cost: number
  places: Array<LegalPlace | null>
}

/** 取卡牌定义 */
export function cardDef(state: any, cardId: string): CardDef | null {
  return (state?.cardLib?.[cardId] as CardDef) ?? null
}

/**
 * 引擎自带的 `viewFor` 少两样东西：国王生命上限（强化会改它）、单位对应的 cardId。
 * 这里在**不动引擎**的前提下补齐，其余字段原样透传。
 */
export function viewOf(state: any, side: number): View {
  const base = G.viewFor(state, side) as unknown as View
  const me = state.players[side]
  const foe = state.players[1 - side]
  base.me.kingMaxHp = me.kingMaxHp
  base.foe.kingMaxHp = foe.kingMaxHp
  for (const lane of LANES) {
    const laneView = base.board[lane]
    if (!laneView) continue
    for (let i = 0; i < ROWS.length; i++) {
      const row = ROWS[i]
      const mine = state.board[lane].units[side][row]
      const theirs = state.board[lane].units[1 - side][row]
      if (mine && laneView.mine[i]) laneView.mine[i]!.cardId = mine.cardId
      if (theirs && laneView.foe[i]) laneView.foe[i]!.cardId = theirs.cardId
    }
  }
  return base
}

/** 某个玩家手牌的完整信息（含实际费用） */
export function handOf(state: any, side: number): Array<HandCard & { def: CardDef; cost: number }> {
  const p = state.players[side]
  const out: Array<HandCard & { def: CardDef; cost: number }> = []
  for (const hc of p.hand as HandCard[]) {
    const def = cardDef(state, hc.cardId)
    if (!def) continue
    out.push({ ...hc, def, cost: G.costOf(state, hc) as number })
  }
  return out
}

/** 词条 id → 显示文本（带 X 的显示成「装甲1」） */
export function keywordLabel(raw: string): string {
  const [id, x] = raw.split(':')
  const def = (KEYWORD_DEFS as Record<string, { name: string }>)[id]
  const name = def ? def.name : id
  if (x && x !== '0' && x !== 'aura') return name + x
  if (x === 'aura') return name + '(光环)'
  return name
}

/** 词条的规则说明（卡牌详情弹窗用） */
export function keywordNote(raw: string): string {
  const [id] = raw.split(':')
  const def = (KEYWORD_DEFS as Record<string, { note?: string }>)[id]
  return def?.note ?? ''
}

/** 卡面词条 → 字符串数组（卡面里可能是 'splash:1'，也可能是 {id,x}） */
export function rawKeywords(def: CardDef): string[] {
  const out: string[] = []
  for (const k of def.keywords ?? []) {
    if (typeof k === 'string') out.push(k)
    else if (k && k.id) out.push(k.x ? k.id + ':' + k.x : k.id)
  }
  return out
}

/** 阵营 key → 中文名 */
export function factionName(key?: string | null): string {
  if (!key) return ''
  const f = (FACTIONS as Record<string, { name: string }>)[key]
  return f ? f.name : key
}

/** 局面是否轮到人类行动 */
export function isHumanTurn(state: any, humanSide: number): boolean {
  return G.getActor(state) === humanSide
}

/** 本回合某一方可以打出的牌（iid → 合法落点） */
export function legalPlays(state: any, side: number): LegalPlay[] {
  return G.getLegalPlays(state, side) as LegalPlay[]
}
