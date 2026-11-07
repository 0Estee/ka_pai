/**
 * 强化工坊：花金币强化、花星尘精通。
 *
 * 价格、上限、能不能练全部问 `app/js/enhance.js`（纯函数，旧版界面用的是同一套），
 * 这里只负责把档案存回 localStorage、把结果画出来。
 */

import { useMemo, useState } from 'react'
import { Enhance, Economy, TEST_CARD_LIB, factionName, rawKeywords, keywordNote } from '../engine/bridge'
import type { CardDef } from '../engine/bridge'
import { CardDetail } from './CardDetail'
import { loadProfile, saveProfile } from '../game/profile'
import type { Profile } from '../game/profile'

interface Props {
  onBack: () => void
}

const RARITY_COLOR: Record<string, string> = {
  white: '#c9d1dc',
  green: '#5fd39a',
  orange: '#e8a34a',
  purple: '#b082ff',
  rainbow: '#ff6fb5',
}

export function Workshop({ onBack }: Props) {
  const [profile, setProfile] = useState<Profile>(() => loadProfile())
  const [groupBy, setGroupBy] = useState<'type' | 'initial'>('type')
  const [query, setQuery] = useState('')
  const [picking, setPicking] = useState<CardDef | null>(null)
  const [detail, setDetail] = useState<CardDef | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const say = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 1600)
  }

  const commit = (res: any): void => {
    if (!res || !res.ok) {
      say((res && res.reason) || '不能这么做')
      return
    }
    if (res.profile) {
      const next = res.profile as Profile
      setProfile(next)
      saveProfile(next)
      say('好了')
    }
  }

  const list = useMemo(
    () => (Enhance as any).workshopCards(TEST_CARD_LIB, profile, groupBy) as {
      groups: Array<{ key: string; label: string; cards: WorkshopCard[] }>
      cards: WorkshopCard[]
    },
    [profile, groupBy],
  )

  const groups = useMemo(() => {
    const q = query.trim()
    if (!q) return list.groups
    const hit = list.cards.filter(
      (c) => c.def.name.includes(q) || c.def.id.toLowerCase().includes(q.toLowerCase()),
    )
    return [{ key: 'hit', label: '搜索结果（' + hit.length + '）', cards: hit }]
  }, [list, query])

  const dustCost = (Economy as any).DUST_PER_GOLD ?? 10

  return (
    <div className="home workshop">
      <header className="home-head">
        <h1>强化工坊</h1>
        <p>
          金币 <b className="gold">{profile.gold}</b> · 星尘 <b className="dust">{profile.dust}</b>
          {' '}· 表现分 {profile.perf ?? 0}
        </p>
      </header>

      <div className="ws-bar">
        <button className="ghost-btn" onClick={onBack}>
          返回大厅
        </button>
        <button
          className="ghost-btn"
          onClick={() => commit((Economy as any).buyDust(profile, 1))}
          title={'花 ' + dustCost + ' 金币换 1 星尘'}
        >
          买星尘（{dustCost} 金币）
        </button>
        <div className="ws-tabs">
          <button className={'chip ' + (groupBy === 'type' ? 'on' : '')} onClick={() => setGroupBy('type')}>
            按类型
          </button>
          <button className={'chip ' + (groupBy === 'initial' ? 'on' : '')} onClick={() => setGroupBy('initial')}>
            按名称
          </button>
        </div>
        <input
          className="ws-search"
          value={query}
          placeholder="搜卡名或 id"
          onChange={(ev) => setQuery(ev.target.value)}
        />
      </div>

      {groups.map((g) => (
        <section className="panel" key={g.key}>
          <h2>{g.label}</h2>
          <div className="ws-grid">
            {g.cards.map((c) => (
              <WorkshopCardRow
                key={c.id}
                card={c}
                profile={profile}
                onEnhance={() => commit((Enhance as any).applyEnhance(profile, c.def, c.id))}
                onMaster={() => {
                  const gate = (Enhance as any).canMaster(profile, c.def, c.id)
                  if (!gate.ok) {
                    say(gate.reason ?? '还不能精通')
                    return
                  }
                  if (c.def.type === 'unit') setPicking(c.def)
                  else commit((Enhance as any).applyMastery(profile, c.def, c.id, null))
                }}
                onWash={() => commit((Enhance as any).applyWash(profile, c.def, c.id))}
                onDetail={() => setDetail(c.def)}
              />
            ))}
          </div>
        </section>
      ))}

      {picking && (
        <SkillPicker
          def={picking}
          profile={profile}
          onPick={(skillId) => {
            commit((Enhance as any).applyMastery(profile, picking, picking.id, skillId))
            setPicking(null)
          }}
          onClose={() => setPicking(null)}
        />
      )}

      {detail && (
        <CardDetail def={detail} profile={profile} onClose={() => setDetail(null)} />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

interface WorkshopCard {
  id: string
  def: CardDef
  rec: { lvl: number; masteries: string[] }
  stats: { atk: number | null; hp: number | null; cost: number; keywords: Array<{ id: string; x?: number }> }
  initial: string
  type: string
}

function WorkshopCardRow({
  card,
  profile,
  onEnhance,
  onMaster,
  onWash,
  onDetail,
}: {
  card: WorkshopCard
  profile: Profile
  onEnhance: () => void
  onMaster: () => void
  onWash: () => void
  onDetail: () => void
}) {
  const def = card.def
  const rec = card.rec
  const stats = card.stats
  const gate = (Enhance as any).canEnhance(profile, def, card.id)
  const masterGate = (Enhance as any).canMaster(profile, def, card.id)
  const washGate = (Enhance as any).canWash(profile, def, card.id)
  const isSpell = def.type !== 'unit'
  const maxLvl = (Enhance as any).ENHANCE_MAX ?? 9

  const kwText = (stats.keywords ?? [])
    .map((k) => {
      const name = ((Enhance as any).SKILL_BY_ID?.[k.id] as any)?.name
      return name ? name : keywordNote(k.id) ? k.id : k.id
    })
    .join(' ')

  return (
    <div className={'ws-card ' + (rec.lvl > 0 || (rec.masteries ?? []).length ? 'up' : '')}>
      <button className="ws-card-name" onClick={onDetail} title="看详情">
        {def.name}
      </button>
      <div className="ws-card-sub">
        {isSpell ? '锦囊' : '单位'}
        {def.faction ? ' · ' + factionName(def.faction) : ''}
      </div>

      <div className="ws-card-stats">
        {isSpell ? (
          <span>
            费用 <b>{fmt(stats.cost)}</b>
            {stats.cost !== def.cost && <i>（卡面 {fmt(def.cost)}）</i>}
          </span>
        ) : (
          <span>
            <b className="atk">{fmt(stats.atk ?? 0)}</b>
            {' / '}
            <b className="hp">{fmt(stats.hp ?? 0)}</b>
            {(stats.atk ?? 0) !== (def.atk ?? 0) && <i>（卡面 {fmt(def.atk ?? 0)}/{fmt(def.hp ?? 0)}）</i>}
          </span>
        )}
      </div>

      <div className="ws-lvl">
        <div className="ws-lvl-bar">
          <div className="ws-lvl-fill" style={{ width: (Math.min(rec.lvl, maxLvl) / maxLvl) * 100 + '%' }} />
        </div>
        <span>
          强化 {rec.lvl}/{maxLvl}
        </span>
      </div>

      {(rec.masteries ?? []).length > 0 && (
        <div className="ws-masteries">
          {(rec.masteries ?? []).map((id, i) => (
            <span key={id + i} className="kw-chip mastery">
              {masteryName(id)}
            </span>
          ))}
        </div>
      )}

      <div className="ws-actions">
        <button
          className="ws-btn"
          onClick={onEnhance}
          disabled={!gate.ok}
          title={gate.ok ? '花 ' + gate.cost + ' 金币' : gate.reason}
        >
          强化{gate.ok ? '（' + gate.cost + '）' : ''}
        </button>
        <button
          className="ws-btn"
          onClick={onMaster}
          disabled={!masterGate.ok}
          title={masterGate.ok ? '花 ' + masterGate.cost + ' 星尘' : masterGate.reason}
        >
          精通{masterGate.ok ? '（' + masterGate.cost + '）' : ''}
        </button>
        <button className="ws-btn ghost" onClick={onWash} disabled={!washGate.ok} title={washGate.ok ? '洗掉最近一次精通' : washGate.reason}>
          洗掉
        </button>
      </div>
    </div>
  )
}

function SkillPicker({
  def,
  profile,
  onPick,
  onClose,
}: {
  def: CardDef
  profile: Profile
  onPick: (skillId: string) => void
  onClose: () => void
}) {
  const rec = (Enhance as any).recordFor(profile, def.id) as { masteries: string[] }
  const skills = ((Enhance as any).SKILLS ?? []) as Array<{
    id: string
    name: string
    text: string
    rarity: string
  }>
  const rarity = ((Enhance as any).RARITY ?? {}) as Record<string, { label: string }>

  return (
    <div className="overlay" onClick={onClose}>
      <div className="detail-panel" onClick={(ev) => ev.stopPropagation()}>
        <div className="detail-head">
          <div>
            <div className="detail-name">{def.name} · 精通</div>
            <div className="detail-sub">{(Enhance as any).masteryHint(def)}</div>
          </div>
        </div>
        <div className="skill-list">
          {skills.map((s) => {
            const used = (rec.masteries ?? []).includes(s.id)
            return (
              <button
                key={s.id}
                className="skill-row"
                disabled={used}
                onClick={() => onPick(s.id)}
                style={{ borderLeftColor: RARITY_COLOR[s.rarity] ?? '#c9d1dc' }}
              >
                <span className="skill-name" style={{ color: RARITY_COLOR[s.rarity] ?? '#c9d1dc' }}>
                  {s.name}
                </span>
                <span className="skill-rarity">{rarity[s.rarity]?.label ?? s.rarity}</span>
                <span className="skill-text">{s.text}</span>
                {used && <span className="skill-used">已挂</span>}
              </button>
            )
          })}
        </div>
        <button className="ghost-btn" onClick={onClose}>
          取消
        </button>
      </div>
    </div>
  )
}

function masteryName(id: string): string {
  if (id === 'spell_cost') return '精通：锦囊减费'
  const table = ((Enhance as any).SKILL_BY_ID ?? {}) as Record<string, { name: string }>
  return table[id]?.name ?? id
}

function fmt(n: number): string {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}
