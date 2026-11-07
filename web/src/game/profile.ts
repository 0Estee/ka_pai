/**
 * 网页端存档：金币、星尘、强化与精通记录。
 *
 * 只放**档案**（数字与记录），规则与价格全在 `app/js/enhance.js`、`app/js/economy.js`。
 * 存档落在 localStorage，形状与旧版 profile 兼容（forge.cards 是同一套 {lvl,masteries}）。
 */

import { Enhance, Economy } from '../engine/bridge'

export interface CardRec {
  lvl: number
  masteries: string[]
}

export interface Forge {
  v: number
  cards: Record<string, CardRec>
}

export interface Profile {
  gold: number
  dust: number
  perf: number
  games: number
  wins: number
  losses: number
  draws: number
  forge: Forge
  [k: string]: any
}

const KEY = 'kp.web.profile.v1'

export function defaultProfile(): Profile {
  return {
    gold: (Economy as any).INITIAL_GOLD ?? 100,
    dust: (Economy as any).INITIAL_DUST ?? 60,
    perf: 0,
    games: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    forge: { v: 1, cards: {} },
  }
}

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<Profile> | null
      if (p && typeof p === 'object') {
        const base = defaultProfile()
        const forge = p.forge && p.forge.cards ? p.forge : base.forge
        return { ...base, ...p, forge: { v: forge.v ?? 1, cards: forge.cards ?? {} } }
      }
    }
  } catch {
    /* 存档损坏就当新玩家，不阻塞对局 */
  }
  return defaultProfile()
}

export function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* 隐私模式下写不进去，忽略 */
  }
}

export function resetProfile(): Profile {
  const p = defaultProfile()
  saveProfile(p)
  return p
}

/** 卡牌当前强化等级 / 精通次数（没有记录就返回 0 / 空） */
export function recordOf(profile: Profile, cardId: string): CardRec {
  return ((Enhance as any).recordFor(profile, cardId) as CardRec) ?? { lvl: 0, masteries: [] }
}

/** 手牌/详情里要显示的实际数值（含强化与技能加成） */
export function faceOf(profile: Profile, def: any): {
  atk: number
  hp: number
  cost: number
  lvl: number
  masteries: string[]
  upgraded: boolean
} {
  const rec = recordOf(profile, def?.id ?? '')
  const st = (Enhance as any).statsFor(def, rec)
  return {
    atk: st.atk ?? 0,
    hp: st.hp ?? 0,
    cost: st.cost ?? 0,
    lvl: rec.lvl || 0,
    masteries: rec.masteries ?? [],
    upgraded: (rec.lvl || 0) > 0 || (rec.masteries ?? []).length > 0,
  }
}
