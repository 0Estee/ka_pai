/**
 * 交互提问面板：引擎挂起时把 `state.pending.request` 渲染成按钮。
 *
 * 各类请求的选项形状不同，但都有一个 `label`，
 * 其余字段就是喂回引擎的答案（uid / lane / iid / index / id / cardId / king …）。
 */

import type { GameController, PendingRequest } from '../game/controller'

interface Props {
  controller: GameController
}

export function ChoicePanel({ controller }: Props) {
  const req: PendingRequest | null = controller.pending
  if (!req) return null

  const options: Array<Record<string, any>> = req.options ?? []

  const pick = (opt: Record<string, any>) => {
    const answer: Record<string, any> = {}
    for (const k of Object.keys(opt)) {
      if (k !== 'label') answer[k] = opt[k]
    }
    controller.answerChoice(answer)
  }

  /** 有的请求不给选项，而是给一个 choose 函数（引擎自带的兜底口径） */
  const fallback = () => {
    const c = (req as any).choose
    if (typeof c === 'function') {
      const picked = c()
      if (picked) {
        const answer: Record<string, any> = {}
        for (const k of Object.keys(picked)) if (k !== 'label') answer[k] = picked[k]
        controller.answerChoice(answer)
        return
      }
    }
    if (options.length > 0) pick(options[0])
  }

  return (
    <div className="overlay">
      <div className="choice-panel">
        <div className="choice-title">{req.prompt || promptFor(req.type)}</div>
        <div className="choice-options">
          {options.map((opt, i) => (
            <button key={i} className="choice-btn" onClick={() => pick(opt)}>
              {String(opt.label ?? `选项${i + 1}`)}
            </button>
          ))}
          {options.length === 0 && (
            <button className="choice-btn" onClick={fallback}>
              确定
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function promptFor(type: string): string {
  switch (type) {
    case 'chooseUnit':
      return '选择一个单位'
    case 'chooseEnemyTarget':
      return '选择目标'
    case 'chooseLane':
      return '选择一条线路'
    case 'chooseHandCard':
      return '选择一张手牌'
    case 'chooseOption':
      return '选择一项'
    case 'chooseKeyword':
      return '选择一个词条'
    case 'chooseRawMaterial':
      return '选择一张原料'
    case 'summonCell':
      return '选择召唤位置'
    case 'combatTarget':
      return '选择攻击目标'
    default:
      return '请选择'
  }
}
