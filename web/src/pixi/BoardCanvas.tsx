/**
 * 棋盘（PixiJS 渲染）。
 *
 * 只负责「把一帧局面画出来」「点哪一格」「播演出动画」——
 * 规则、合法落点全部由引擎算好后通过 props 传进来。
 *
 * 演出层是**独立的 Container**：局面每变一次整场重建，但动画容器只建一次，
 * 重建后把它重新提到最上层，这样飘字不会跟着场景一起被销毁。
 */

import { useEffect, useRef, useState } from 'react'
import { Application, Container, Graphics, Text } from 'pixi.js'
import { LANES, LANE_NAME } from '../engine/bridge'
import type { UnitView, View } from '../engine/bridge'
import { keywordLabel } from '../engine/bridge'
import type { FxEvent } from '../game/fx'

export interface CellTarget {
  lane: string
  row: string
}

interface Props {
  view: View
  /** 人类是 0 还是 1（决定哪半场画在下边） */
  humanSide: number
  /** 当前选中手牌的合法落点（空 = 没有选中单位牌） */
  legalCells: CellTarget[]
  selectedCardId: string | null
  /** 待播放的演出事件（按 id 去重） */
  fx: FxEvent[]
  onCellClick: (cell: CellTarget) => void
  onUnitClick?: (uid: number) => void
}

const C = {
  bg: 0x11141b,
  laneBand: 0x171b24,
  laneBandAlt: 0x1a1f2a,
  cellEmpty: 0x1d2230,
  cellEmptyHover: 0x232a3a,
  cellLegal: 0x2a6b4f,
  cellLegalBorder: 0x4ade80,
  myTint: 0x1b2740,
  foeTint: 0x2a1b28,
  border: 0x2b3347,
  text: 0xe6eaf2,
  textDim: 0x8b96ab,
  atk: 0xffb86b,
  hp: 0xff6b81,
  frozen: 0x7dd3fc,
  good: 0x6ee7a8,
  bad: 0xff8fa3,
  spell: 0xb082ff,
}

const FONT = 'system-ui, "Microsoft YaHei", sans-serif'

const ROW_ORDER: Array<{ side: 'foe' | 'mine'; row: 'back' | 'front' }> = [
  { side: 'foe', row: 'back' },
  { side: 'foe', row: 'front' },
  { side: 'mine', row: 'front' },
  { side: 'mine', row: 'back' },
]

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface Anim {
  node: Container
  t: number
  dur: number
  step: (p: number) => void
}

function unitAt(view: View, side: 'foe' | 'mine', lane: string, row: 'front' | 'back'): UnitView | null {
  const laneView = view.board[lane]
  if (!laneView) return null
  const arr = side === 'mine' ? laneView.mine : laneView.foe
  return row === 'front' ? arr[0] : arr[1]
}

export function BoardCanvas({
  view,
  humanSide,
  legalCells,
  selectedCardId,
  fx,
  onCellClick,
  onUnitClick,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const appRef = useRef<Application | null>(null)
  const sceneRef = useRef<Container | null>(null)
  const fxLayerRef = useRef<Container | null>(null)
  const animsRef = useRef<Anim[]>([])
  const seenFxRef = useRef<Set<number>>(new Set())
  const rectsRef = useRef<Record<string, Rect>>({})
  const [ready, setReady] = useState(false)

  // ── 初始化一次 ──────────────────────────────────────────
  useEffect(() => {
    let disposed = false
    const host = hostRef.current
    if (!host) return

    const app = new Application()
    app
      .init({
        background: C.bg,
        antialias: true,
        resizeTo: host,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        autoDensity: true,
      })
      .then(() => {
        if (disposed) {
          app.destroy(true, { children: true })
          return
        }
        host.appendChild(app.canvas)
        const layer = new Container()
        app.stage.addChild(layer)
        fxLayerRef.current = layer

        // 演出动画的驱动：每个动画自己算进度，播完自我销毁
        app.ticker.add((ticker: any) => {
          const dt = Number(ticker?.deltaTime) || 1
          const list = animsRef.current
          for (let i = list.length - 1; i >= 0; i--) {
            const a = list[i]
            a.t += dt
            const p = Math.min(1, a.t / a.dur)
            a.step(p)
            if (p >= 1) {
              if (a.node.parent) a.node.parent.removeChild(a.node)
              a.node.destroy({ children: true })
              list.splice(i, 1)
            }
          }
        })

        appRef.current = app
        setReady(true)
      })

    return () => {
      disposed = true
      const a = appRef.current
      appRef.current = null
      sceneRef.current = null
      fxLayerRef.current = null
      animsRef.current = []
      if (a) a.destroy(true, { children: true })
    }
  }, [])

  // ── 每次局面变化重绘 ────────────────────────────────────
  useEffect(() => {
    const app = appRef.current
    if (!app || !ready) return

    if (sceneRef.current) {
      app.stage.removeChild(sceneRef.current)
      sceneRef.current.destroy({ children: true })
    }
    const scene = new Container()
    sceneRef.current = scene
    app.stage.addChild(scene)

    // 演出层永远在最上面
    const layer = fxLayerRef.current
    if (layer) {
      app.stage.removeChild(layer)
      app.stage.addChild(layer)
    }

    const W = app.screen.width
    const H = app.screen.height
    const padX = Math.max(10, W * 0.03)
    const padY = Math.max(10, H * 0.03)
    const headerH = 26
    const gridW = W - padX * 2
    const gridH = H - padY * 2 - headerH
    const colW = gridW / LANES.length
    const rowH = gridH / ROW_ORDER.length

    const legalSet = new Set(legalCells.map((c) => c.lane + '|' + c.row))
    const rects: Record<string, Rect> = {}

    // 线路标题
    LANES.forEach((lane, ci) => {
      const label = new Text({
        text: (LANE_NAME as Record<string, string>)[lane] ?? lane,
        style: { fill: C.textDim, fontSize: 13, fontFamily: FONT },
      })
      label.x = padX + ci * colW + 6
      label.y = padY + 4
      scene.addChild(label)
    })

    // 格子
    ROW_ORDER.forEach((rowSpec, ri) => {
      const y = padY + headerH + ri * rowH
      LANES.forEach((lane, ci) => {
        const x = padX + ci * colW
        const isLegal = legalSet.has(lane + '|' + rowSpec.row)
        const selected = selectedCardId !== null
        const unit = unitAt(view, rowSpec.side, lane, rowSpec.row)

        rects[lane + '|' + rowSpec.row + '|' + rowSpec.side] = { x, y, w: colW, h: rowH }

        const g = new Graphics()
        g.roundRect(x + 3, y + 3, colW - 6, rowH - 6, 10)
          .fill(rowSpec.side === 'mine' ? C.myTint : C.foeTint)
        if (isLegal) {
          g.roundRect(x + 3, y + 3, colW - 6, rowH - 6, 10)
            .fill(C.cellLegal)
            .stroke({ width: 2, color: C.cellLegalBorder })
        } else {
          g.roundRect(x + 3, y + 3, colW - 6, rowH - 6, 10)
            .stroke({ width: 1, color: C.border, alpha: selected ? 0.35 : 0.7 })
        }
        g.eventMode = 'static'
        g.cursor = isLegal ? 'pointer' : unit ? 'pointer' : 'default'
        g.on('pointertap', () => {
          if (isLegal) onCellClick({ lane, row: rowSpec.row })
          else if (unit) onUnitClick?.(unit.uid)
        })
        scene.addChild(g)

        if (!unit) {
          if (isLegal) {
            const plus = new Text({
              text: '+',
              style: { fill: 0x9df5c0, fontSize: 22, fontFamily: FONT },
            })
            plus.anchor.set(0.5)
            plus.x = x + colW / 2
            plus.y = y + rowH / 2
            scene.addChild(plus)
          }
          return
        }

        drawUnit(scene, unit, x + 8, y + 8, colW - 16, rowH - 16, rowSpec.side)
      })
    })

    rectsRef.current = rects
  }, [ready, view, legalCells, selectedCardId, onCellClick, onUnitClick])

  // ── 演出：把新事件变成动画 ──────────────────────────────
  useEffect(() => {
    const app = appRef.current
    const layer = fxLayerRef.current
    if (!app || !layer || !ready) return

    for (const e of fx) {
      if (e == null || seenFxRef.current.has(e.id)) continue
      seenFxRef.current.add(e.id)
      if (seenFxRef.current.size > 600) seenFxRef.current = new Set(fx.slice(-60).map((x) => x.id))
      if (animsRef.current.length > 70) continue
      spawnFx(layer, { w: app.screen.width, h: app.screen.height }, e, rectsRef.current, humanSide, animsRef.current)
    }
  }, [ready, fx, humanSide])

  return <div ref={hostRef} className="board-canvas" />
}

// ── 演出工厂 ──────────────────────────────────────────────

function floatText(layer: Container, x: number, y: number, text: string, color: number, size = 22): Text {
  const t = new Text({
    text,
    style: {
      fill: color,
      fontSize: size,
      fontFamily: FONT,
      fontWeight: '700',
      stroke: { color: 0x0b0e14, width: 4 },
    },
  })
  t.anchor.set(0.5)
  t.x = x
  t.y = y
  layer.addChild(t)
  return t
}

function rise(node: Text, x: number, y: number, anims: Anim[], dur = 62): void {
  anims.push({
    node,
    t: 0,
    dur,
    step: (p: number) => {
      node.x = x
      node.y = y - 46 * p
      node.alpha = p < 0.6 ? 1 : Math.max(0, 1 - (p - 0.6) / 0.4)
      node.scale.set(1 + 0.3 * (1 - p))
    },
  })
}

function ring(layer: Container, x: number, y: number, radius: number, color: number, anims: Anim[], dur = 44): void {
  const g = new Graphics()
  g.circle(0, 0, Math.max(6, radius)).stroke({ width: 4, color, alpha: 0.95 })
  g.x = x
  g.y = y
  layer.addChild(g)
  anims.push({
    node: g,
    t: 0,
    dur,
    step: (p: number) => {
      g.scale.set(0.45 + 1.5 * p)
      g.alpha = 1 - p
    },
  })
}

function banner(layer: Container, x: number, y: number, text: string, color: number, anims: Anim[], size = 26): void {
  const t = floatText(layer, x, y, text, color, size)
  anims.push({
    node: t,
    t: 0,
    dur: 80,
    step: (p: number) => {
      t.alpha = p < 0.75 ? 1 : Math.max(0, 1 - (p - 0.75) / 0.25)
      t.scale.set(0.9 + 0.2 * Math.min(1, p * 3))
    },
  })
}

function spawnFx(
  layer: Container,
  area: { w: number; h: number },
  e: FxEvent,
  rects: Record<string, Rect>,
  humanSide: number,
  anims: Anim[],
): void {
  const sideKey = e.side === humanSide ? 'mine' : 'foe'
  const rect = e.lane && e.row ? rects[e.lane + '|' + e.row + '|' + sideKey] : undefined
  const cx = rect ? rect.x + rect.w / 2 : area.w / 2
  const cy = rect ? rect.y + rect.h / 2 : area.h / 2
  const r = rect ? Math.min(rect.w, rect.h) * 0.42 : 24

  switch (e.kind) {
    case 'deploy':
      if (rect) ring(layer, cx, cy, r, C.good, anims)
      break
    case 'cast':
      if (rect) ring(layer, cx, cy, r, C.spell, anims)
      else if (e.text) banner(layer, area.w / 2, area.h * 0.36, e.text, C.spell, anims, 22)
      break
    case 'destroy':
      if (rect) ring(layer, cx, cy, r, C.bad, anims, 52)
      break
    case 'damage': {
      const t = floatText(layer, cx, cy, e.text ?? '-', C.bad, 24)
      rise(t, cx, cy, anims)
      break
    }
    case 'heal': {
      const t = floatText(layer, cx, cy, e.text ?? '+', C.good, 22)
      rise(t, cx, cy, anims)
      break
    }
    case 'king-damage': {
      const y = e.side === humanSide ? area.h - 34 : 34
      const t = floatText(layer, area.w / 2, y, e.text ?? '-', C.hp, 32)
      rise(t, area.w / 2, y, anims, 70)
      break
    }
    case 'king-heal': {
      const y = e.side === humanSide ? area.h - 34 : 34
      const t = floatText(layer, area.w / 2, y, e.text ?? '+', C.good, 28)
      rise(t, area.w / 2, y, anims, 70)
      break
    }
    case 'banner':
      banner(layer, area.w / 2, area.h * 0.44, e.text ?? '', C.text, anims)
      break
    default:
      break
  }
}

// ── 单位卡 ────────────────────────────────────────────────

function drawUnit(
  scene: Container,
  unit: UnitView,
  x: number,
  y: number,
  w: number,
  h: number,
  side: 'foe' | 'mine',
) {
  const frozen = unit.marks?.includes('freeze')

  // 名字
  const name = new Text({
    text: unit.name,
    style: { fill: C.text, fontSize: Math.max(11, Math.min(15, w / 7)), fontFamily: FONT, fontWeight: '600' },
  })
  name.x = x
  name.y = y + 2
  name.style.wordWrap = true
  name.style.wordWrapWidth = w
  scene.addChild(name)

  // 攻/血
  const atk = new Text({ text: fmt(unit.atk), style: { fill: C.atk, fontSize: 14, fontFamily: FONT, fontWeight: '700' } })
  atk.x = x
  atk.y = y + h - 20
  scene.addChild(atk)

  const hpLabel = new Text({ text: '♥' + fmt(unit.hp), style: { fill: C.hp, fontSize: 13, fontFamily: FONT } })
  hpLabel.x = x + 30
  hpLabel.y = y + h - 20
  scene.addChild(hpLabel)

  // 词条（引擎给的是 firstStrike / splash:1 这类 id，这里翻成中文短名）
  if (unit.keywords.length > 0) {
    const kw = new Text({
      text: unit.keywords
        .slice(0, 3)
        .map((k) => keywordLabel(k))
        .join(' '),
      style: { fill: C.textDim, fontSize: 10, fontFamily: FONT, wordWrap: true, wordWrapWidth: w },
    })
    kw.x = x
    kw.y = y + h - 38
    scene.addChild(kw)
  }

  // 状态标记：冻结/中毒/灼烧/疾病/护盾，各一个小圆点
  const markColors: Record<string, number> = {
    freeze: C.frozen,
    poison: 0x7be07b,
    burn: 0xff9d4d,
    disease: 0xb082ff,
    shield: 0x9ec5ff,
  }
  let dotX = x + 4
  for (const m of unit.marks ?? []) {
    const color = markColors[m]
    if (color === undefined) continue
    const dot = new Graphics()
    dot.circle(dotX + 3, y + 12, 3.5).fill(color)
    scene.addChild(dot)
    dotX += 10
  }

  if (frozen) {
    const badge = new Graphics()
    badge.circle(x + w - 8, y + 8, 5).fill(C.frozen)
    scene.addChild(badge)
  }

  if (side === 'foe') {
    const tag = new Text({ text: '敌', style: { fill: 0xff9db4, fontSize: 10, fontFamily: FONT } })
    tag.x = x + w - 12
    tag.y = y + h - 16
    scene.addChild(tag)
  }
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}
