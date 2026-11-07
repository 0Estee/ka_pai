/**
 * 对局界面：HUD + 棋盘（PixiJS）+ 手牌 + 交互面板 + 卡牌详情 + 伤害演出。
 *
 * 三处易错点，改动时留意：
 * - 国王血条上限读 kingMaxHp（强化会提高上限，硬编码 20 会画错）。
 * - 手牌的攻血走 faceOf（强化后的数值），费用直接用引擎给的 h.cost。
 * - 演出事件由 controller.drainFx() 采走，必须放进 state 累积，不能每帧重取。
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  Economy,
  LANE_NAME,
  handOf,
  legalPlays,
  viewOf,
} from '../engine/bridge'
import type { CardDef, UnitView, View } from '../engine/bridge'
import type { GameController } from './controller'
import type { FxEvent } from './fx'
import { faceOf, loadProfile, saveProfile } from './profile'
import type { Profile } from './profile'
import { BoardCanvas } from '../pixi/BoardCanvas'
import type { CellTarget } from '../pixi/BoardCanvas'
import { ChoicePanel } from '../ui/ChoicePanel'
import { CardDetail } from '../ui/CardDetail'

interface Props {
  controller: GameController
  onExit: () => void
}

interface DetailTarget {
  def: CardDef
  unit?: UnitView | null
  note?: string | null
}

const LONG_PRESS_MS = 420

export function GameScreen({ controller, onExit }: Props) {
  const version = useSyncExternalStore(controller.subscribe, controller.getSnapshot)

  const state = controller.state
  const human = controller.humanSide
  const view = viewOf(state, human) as View
  const hand = handOf(state, human)
  const myTurn = controller.isMyTurn
  const plays = useMemo(() => (myTurn ? legalPlays(state, human) : []), [state, human, myTurn, version])
  const playable = useMemo(() => new Set(plays.map((p) => p.iid)), [plays])

  const profile = useMemo<Profile>(() => loadProfile(), [])
  const [selectedIid, setSelectedIid] = useState<number | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [detail, setDetail] = useState<DetailTarget | null>(null)

  // 自动化验证用的观察窗（只有页面里预置 window.__KP_EXPOSE 时才生效）
  useEffect(() => {
    if ((window as any).__KP_EXPOSE) (window as any).__kp = controller
  }, [controller])
  const [fx, setFx] = useState<FxEvent[]>([])
  const [reward, setReward] = useState<any>(null)
  const settled = useRef(false)
  const longPress = useRef<{ timer: number; fired: boolean }>({ timer: 0, fired: false })

  // 演出事件：每次状态变化取走队列里新增的事件
  useEffect(() => {
    const batch = controller.drainFx()
    if (batch.length) setFx((prev) => prev.concat(batch).slice(-30))
  }, [controller, version])

  // 终局结算：只结算一次，结果留在面板上
  useEffect(() => {
    if (!controller.over || settled.current) return
    settled.current = true
    try {
      const kills = (state.stats && state.stats.killsBySide && state.stats.killsBySide[human]) || 0
      const res = Economy.applyResult(profile, {
        winner: state.winner,
        humanSide: human,
        turn: state.turn,
        humanKingHp: state.players[human].kingHp,
        kills,
        mode: 'ai',
      })
      if (res && res.profile) {
        saveProfile(res.profile)
        profile.gold = res.profile.gold
        profile.dust = res.profile.dust
        profile.perf = res.profile.perf
      }
      setReward(res ? { reward: res.reward, leveledUp: res.leveledUp } : null)
    } catch (err) {
      console.warn('[结算失败]', err)
    }
  }, [controller.over, profile, state, human])

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 1800)
  }, [])

  const selectedPlay = plays.find((p) => p.iid === selectedIid) ?? null
  const legalCells: CellTarget[] = selectedPlay
    ? (selectedPlay.places.filter(Boolean) as CellTarget[])
    : []
  const selectedCard: CardDef | null = hand.find((h) => h.iid === selectedIid)?.def ?? null

  const openHandDetail = (iid: number) => {
    const h = hand.find((x) => x.iid === iid)
    if (!h) return
    setDetail({
      def: h.def,
      note: playable.has(iid)
        ? null
        : myTurn
          ? '现在打不出：费用不足或该阶段不允许这类牌'
          : '现在不是你的阶段（对手正在行动）',
    })
  }

  const openUnitDetail = (uid: number) => {
    for (const lane of Object.keys(view.board)) {
      const l = view.board[lane]
      const all = [...(l.mine ?? []), ...(l.foe ?? [])]
      const u = all.find((x) => x && (x as UnitView).uid === uid) as UnitView | undefined
      if (u) {
        const def = u.cardId ? cardDefOfState(state, u.cardId) : null
        if (def) {
          setDetail({ def, unit: u })
          return
        }
      }
    }
  }

  const onCardClick = (iid: number, def: CardDef) => {
    if (longPress.current.fired) {
      longPress.current.fired = false
      return
    }
    if (!myTurn) {
      openHandDetail(iid)
      return
    }
    if (!playable.has(iid)) {
      openHandDetail(iid)
      showToast('这张牌现在打不出（费用不足或阶段不符）')
      return
    }
    if (def.type === 'unit') {
      setSelectedIid((cur) => (cur === iid ? null : iid))
      return
    }
    const r = controller.playCard(iid, {})
    if (!r.ok) showToast(r.error ?? '打出失败')
    setSelectedIid(null)
  }

  const onCardPointerDown = (iid: number) => {
    longPress.current.fired = false
    window.clearTimeout(longPress.current.timer)
    longPress.current.timer = window.setTimeout(() => {
      longPress.current.fired = true
      openHandDetail(iid)
    }, LONG_PRESS_MS)
  }

  const onCardPointerUp = () => {
    window.clearTimeout(longPress.current.timer)
  }

  const onCellClick = (cell: CellTarget) => {
    if (selectedIid == null) return
    const r = controller.playCard(selectedIid, { lane: cell.lane, row: cell.row })
    if (!r.ok) showToast(r.error ?? '放置失败')
    setSelectedIid(null)
  }

  const me = view.me
  const foe = view.foe
  const handFx = fx.slice(-14)

  return (
    <div className="game">
      <div className="hud">
        <div className="hud-row">
          <KingBar label="敌方国王" hp={foe.kingHp} max={foe.kingMaxHp || 20} tone="foe" />
          <div className="hud-mid">
            <div className="turn-chip">第 {view.turn} 回合</div>
            <div className="phase-chip">{phaseLabel(view.phase)}</div>
          </div>
          <KingBar label="我方国王" hp={me.kingHp} max={me.kingMaxHp || 20} tone="me" />
        </div>
        <div className="hud-row hud-sub">
          <span>牌库 {view.deckLeft}</span>
          <span>
            费用 <b>{fmt(me.mana)}</b> / {fmt(me.manaCap)}
          </span>
          <span>手牌 {me.hand.length}</span>
          <span className="hud-coins" title="金币 / 星尘（对局结束后结算）">
            {profile.gold} / {profile.dust}
          </span>
          <button className="ghost-btn" onClick={onExit}>
            退出
          </button>
        </div>
      </div>

      <div className="board-wrap">
        <BoardCanvas
          view={view}
          humanSide={human}
          legalCells={legalCells}
          selectedCardId={selectedCard?.id ?? null}
          fx={handFx}
          onCellClick={onCellClick}
          onUnitClick={openUnitDetail}
        />
      </div>

      <div className="hand-area">
        <div className="hand-scroll">
          {hand.map((h) => {
            const ok = playable.has(h.iid)
            const face = faceOf(profile, h.def)
            const isUnit = h.def.type === 'unit'
            return (
              <button
                key={h.iid}
                className={'card ' + (ok ? 'playable' : 'dim') + ' ' + (selectedIid === h.iid ? 'selected' : '')}
                onClick={() => onCardClick(h.iid, h.def)}
                onPointerDown={() => onCardPointerDown(h.iid)}
                onPointerUp={onCardPointerUp}
                onPointerLeave={onCardPointerUp}
                onContextMenu={(ev) => {
                  ev.preventDefault()
                  openHandDetail(h.iid)
                }}
                title={h.def.text ?? ''}
              >
                <div className="card-cost">{fmt(h.cost)}</div>
                <div className="card-name">{h.def.name}</div>
                <div className="card-stats">
                  {isUnit ? (
                    <>
                      <span className={'atk' + (face.upgraded ? ' up' : '')}>{fmt(face.atk)}</span>
                      <span className={'hp' + (face.upgraded ? ' up' : '')}>{fmt(face.hp)}</span>
                      {face.masteries.length > 0 && <span className="card-mastery">精通{face.masteries.length}</span>}
                    </>
                  ) : (
                    <span className="spell">
                      {h.def.type === 'trap' ? '陷阱' : '锦囊'}
                      {face.masteries.length > 0 ? ' · 精通' : ''}
                    </span>
                  )}
                </div>
                {h.def.text && <div className="card-text">{h.def.text}</div>}
              </button>
            )
          })}
        </div>
        <div className="actions">
          <button className="primary-btn" onClick={() => controller.endPhase()} disabled={!myTurn}>
            结束阶段
          </button>
        </div>
      </div>

      {selectedCard && selectedCard.type === 'unit' && (
        <div className="hint-bar">
          选一个高亮格子放下「{selectedCard.name}」
          {legalCells.length > 0 &&
            '（' +
              legalCells
                .map(
                  (c) =>
                    (LANE_NAME as Record<string, string>)[c.lane] + '-' + (c.row === 'front' ? '前排' : '后排'),
                )
                .join('、') +
              '）'}
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}

      <ChoicePanel controller={controller} />

      {detail && (
        <CardDetail
          def={detail.def}
          unit={detail.unit ?? null}
          profile={profile}
          note={detail.note ?? null}
          onClose={() => setDetail(null)}
        />
      )}

      {controller.over && (
        <div className="overlay">
          <div className="result-panel">
            <div className="result-title">{resultText(state.winner, human)}</div>
            <div className="result-reason">{String(state.winReason ?? '')}</div>
            {reward && reward.reward && (
              <div className="result-reward">
                <div>
                  金币 +{reward.reward.total ?? 0} · 星尘 +{reward.reward.dust ?? 0}
                </div>
                {Array.isArray(reward.reward.lines) && reward.reward.lines.length > 0 && (
                  <ul>
                    {reward.reward.lines.map((line: string, i: number) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                )}
                {reward.leveledUp && <div className="result-levelup">等级提升！</div>}
              </div>
            )}
            <button className="primary-btn" onClick={onExit}>
              返回主菜单
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** 场上单位要回查 cardId 的卡定义（详情弹窗用） */
function cardDefOfState(state: any, cardId: string): CardDef | null {
  const lib = state.cardLib as Record<string, CardDef>
  return (lib && lib[cardId]) || null
}

function KingBar({ label, hp, max, tone }: { label: string; hp: number; max: number; tone: 'me' | 'foe' }) {
  const pct = Math.max(0, Math.min(1, hp / max))
  return (
    <div className={'king king-' + tone}>
      <div className="king-label">{label}</div>
      <div className="king-bar">
        <div className="king-fill" style={{ width: pct * 100 + '%' }} />
      </div>
      <div className="king-hp">
        {fmt(hp)}/{fmt(max)}
      </div>
    </div>
  )
}

function resultText(winner: number | 'draw' | null, humanSide: number): string {
  if (winner === 'draw') return '平局'
  if (winner === humanSide) return '胜利'
  return '败北'
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'TURN_START':
      return '回合开始'
    case 'DEPLOY_FIRST':
      return '先手放置'
    case 'DEPLOY_SECOND':
      return '后手放置'
    case 'SPELL_FIRST':
      return '先手锦囊'
    case 'SPELL_SECOND':
      return '后手锦囊'
    case 'COMBAT':
      return '开战'
    case 'TURN_END':
      return '回合结束'
    default:
      return phase
  }
}

function fmt(n: number): string {
  const v = Number(n)
  if (!Number.isFinite(v)) return '0'
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}
