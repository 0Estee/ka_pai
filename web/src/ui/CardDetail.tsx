/**
 * 卡牌详情弹窗：手牌 / 场上单位 / 工坊里的牌都能看。
 *
 * 显示「卡面数值 + 强化后的实际数值 + 词条解释」，这是旧版踩过的坑：
 * 玩家在手上看到 3/4，落到场上变成 4/5，得有地方解释为什么。
 */

import { Enhance, FACTIONS, KEYWORD_DEFS, keywordNote, rawKeywords } from '../engine/bridge'
import type { CardDef, UnitView } from '../engine/bridge'
import { faceOf } from '../game/profile'
import type { Profile } from '../game/profile'

interface Props {
  def: CardDef
  /** 场上单位（含当前有效攻血、标记） */
  unit?: UnitView | null
  /** 人类档案：用来算强化后的数值 */
  profile?: Profile | null
  /** 本次打不出去的原因之类的提示 */
  note?: string | null
  onClose: () => void
}

const TYPE_LABEL: Record<string, string> = {
  unit: '单位',
  spell: '锦囊',
  trap: '陷阱',
}

export function CardDetail({ def, unit, profile, note, onClose }: Props) {
  const face = profile ? faceOf(profile, def) : null
  const kws = rawKeywords(def)
  const faction = def.faction ? (FACTIONS as Record<string, { name: string }>)[def.faction] : null

  const atk = unit ? unit.atk : face ? face.atk : def.atk ?? 0
  const hp = unit ? unit.hp : face ? face.hp : def.hp ?? 0
  const showStats = def.type === 'unit'

  return (
    <div className="overlay" onClick={onClose}>
      <div className="detail-panel" onClick={(ev) => ev.stopPropagation()}>
        <div className="detail-head">
          <div>
            <div className="detail-name">{def.name}</div>
            <div className="detail-sub">
              {TYPE_LABEL[def.type] ?? def.type}
              {faction ? ' · ' + faction.name : ''}
              {def.token ? ' · 令牌' : ''}
            </div>
          </div>
          <div className="detail-cost">{fmt(def.cost)}</div>
        </div>

        {showStats && (
          <div className="detail-stats">
            <span className="detail-stat atk">
              攻击 <b>{fmt(atk)}</b>
              {face && face.upgraded && <i>（卡面 {fmt(def.atk ?? 0)}）</i>}
            </span>
            <span className="detail-stat hp">
              生命 <b>{fmt(hp)}</b>
              {face && face.upgraded && <i>（卡面 {fmt(def.hp ?? 0)}）</i>}
            </span>
            {unit && <span className="detail-stat">上限 {fmt(unit.maxHp)}</span>}
          </div>
        )}

        {unit && unit.keywords.length > 0 && (
          <div className="detail-block">
            <div className="detail-label">当前词条</div>
            <div className="kw-list">
              {unit.keywords.map((k) => (
                <span key={k} className="kw-chip" title={keywordNote(k)}>
                  {labelOf(k)}
                </span>
              ))}
            </div>
          </div>
        )}

        {unit && unit.marks.length > 0 && (
          <div className="detail-block">
            <div className="detail-label">状态</div>
            <div className="kw-list">
              {unit.marks.map((m) => (
                <span key={m} className="kw-chip mark">
                  {MARK_LABEL[m] ?? m}
                </span>
              ))}
            </div>
          </div>
        )}

        {kws.length > 0 && (
          <div className="detail-block">
            <div className="detail-label">卡面词条</div>
            <div className="kw-list">
              {kws.map((k) => (
                <span key={k} className="kw-chip" title={keywordNote(k)}>
                  {labelOf(k)}
                </span>
              ))}
            </div>
            <ul className="kw-notes">
              {kws.map((k) => {
                const note2 = keywordNote(k)
                return note2 ? <li key={k}>{labelOf(k)}：{note2}</li> : null
              })}
            </ul>
          </div>
        )}

        {def.text && (
          <div className="detail-block">
            <div className="detail-label">效果</div>
            <div className="detail-text">{def.text}</div>
          </div>
        )}

        {face && face.masteries.length > 0 && (
          <div className="detail-block">
            <div className="detail-label">精通</div>
            <div className="kw-list">
              {face.masteries.map((id, i) => (
                <span key={id + i} className="kw-chip mastery">
                  {masteryLabel(id)}
                </span>
              ))}
            </div>
          </div>
        )}

        {face && face.lvl > 0 && (
          <div className="detail-block">
            <div className="detail-label">强化</div>
            <div className="detail-text">
              +{face.lvl} 次（每张牌最多 9 次；单位加攻血，锦囊减费）
            </div>
          </div>
        )}

        {note && <div className="detail-note">{note}</div>}

        <button className="primary-btn" onClick={onClose}>
          知道了
        </button>
      </div>
    </div>
  )
}

const MARK_LABEL: Record<string, string> = {
  freeze: '冻结',
  poison: '中毒',
  burn: '灼烧',
  disease: '疾病',
  shield: '护盾',
  rooted: '扎根',
}

function labelOf(raw: string): string {
  const [id, x] = raw.split(':')
  const def = (KEYWORD_DEFS as Record<string, { name: string }>)[id]
  const name = def ? def.name : id
  if (x === 'aura') return name + '(光环)'
  if (x && x !== '0') return name + x
  return name
}

/** 技能 id → 中文（从强化表里反查，查不到就原样显示） */
function masteryLabel(id: string): string {
  if (id === 'spell_cost') return '精通：锦囊减费'
  const table = ((Enhance as any).SKILL_BY_ID ?? {}) as Record<string, { name: string }>
  return table[id]?.name ?? id
}

function fmt(n: number): string {
  const v = Number(n)
  if (!Number.isFinite(v)) return '0'
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}
