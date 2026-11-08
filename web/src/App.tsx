/**
 * 应用外壳：主菜单 ↔ 对局 ↔ 强化工坊。
 *
 * 开局时把两边档案里的强化量翻成引擎要的 enhance（[side0, side1]）：
 * 人类用本地存档，AI 用 aiForge 按难度随机生成一份。
 */

import { useMemo, useState } from 'react'
import { DIFFICULTIES, Enhance, FACTIONS, TEST_CARD_LIB } from './engine/bridge'
import { GameController } from './game/controller'
import { GameScreen } from './game/GameScreen'
import { loadProfile } from './game/profile'
import { Workshop } from './ui/Workshop'

const FACTION_LIST = Object.values(FACTIONS) as Array<{ key: string; name: string }>

type Screen = 'home' | 'game' | 'workshop'

export default function App() {
  const [controller, setController] = useState<GameController | null>(null)
  const [screen, setScreen] = useState<Screen>('home')
  const [faction, setFaction] = useState<string>('')
  const [aiFaction, setAiFaction] = useState<string>('')
  const [difficulty, setDifficulty] = useState<string>('normal')
  const [lastReward, setLastReward] = useState<string | null>(null)

  const profile = useMemo(() => loadProfile(), [screen])

  const start = () => {
    const seed = Math.floor(Math.random() * 1e9)
    const humanSide = 0
    let enhance: any = null
    try {
      const mine = (Enhance as any).buildSideEnhance(TEST_CARD_LIB, loadProfile())
      const aiProfile = (Enhance as any).aiForge(TEST_CARD_LIB, { seed, difficulty })
      const theirs = (Enhance as any).buildSideEnhance(TEST_CARD_LIB, aiProfile)
      enhance = humanSide === 0 ? [mine, theirs] : [theirs, mine]
    } catch (err) {
      console.warn('[强化数据生成失败，按无强化开局]', err)
      enhance = null
    }

    const c = new GameController({
      seed,
      difficulty,
      humanSide,
      humanFaction: faction || null,
      aiFaction: aiFaction || null,
      deckSize: 80,
      enhance,
    })
    setLastReward(null)
    setController(c)
    setScreen('game')
  }

  const exitGame = () => {
    setController(null)
    setScreen('home')
  }

  const difficultyInfo = useMemo(
    () => DIFFICULTIES.find((d: any) => d.key === difficulty) ?? DIFFICULTIES[1],
    [difficulty],
  )

  if (screen === 'workshop') {
    return <Workshop onBack={() => setScreen('home')} />
  }

  if (controller && screen === 'game') {
    return <GameScreen controller={controller} onExit={exitGame} />
  }

  return (
    <div className="home">
      <header className="home-head">
        <h1>王座交锋</h1>
        <p>四线路制卡牌对战 · React + PixiJS 网页端</p>
        <p className="wallet">
          金币 <b className="gold">{profile.gold}</b> · 星尘 <b className="dust">{profile.dust}</b>
          {' '}· 表现分 {profile.perf ?? 0}
        </p>
      </header>

      <section className="panel">
        <h2>你的阵营</h2>
        <div className="chips">
          <button className={'chip ' + (faction === '' ? 'on' : '')} onClick={() => setFaction('')}>
            中立（无超能力）
          </button>
          {FACTION_LIST.map((f) => (
            <button
              key={f.key}
              className={'chip ' + (faction === f.key ? 'on' : '')}
              onClick={() => setFaction(f.key)}
            >
              {f.name}
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>对手阵营</h2>
        <div className="chips">
          <button className={'chip ' + (aiFaction === '' ? 'on' : '')} onClick={() => setAiFaction('')}>
            中立
          </button>
          {FACTION_LIST.map((f) => (
            <button
              key={f.key}
              className={'chip ' + (aiFaction === f.key ? 'on' : '')}
              onClick={() => setAiFaction(f.key)}
            >
              {f.name}
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>难度</h2>
        <div className="chips">
          {DIFFICULTIES.map((d: any) => (
            <button
              key={d.key}
              className={'chip ' + (difficulty === d.key ? 'on' : '')}
              onClick={() => setDifficulty(d.key)}
              title={d.tagline}
            >
              {d.name}
            </button>
          ))}
        </div>
        <p className="tagline">{difficultyInfo?.tagline}</p>
      </section>

      <button className="primary-btn big" onClick={start}>
        开始对局
      </button>
      <button className="ghost-btn big" onClick={() => setScreen('workshop')}>
        强化工坊（金币 {profile.gold}）
      </button>

      {lastReward && <div className="home-reward">{lastReward}</div>}

      <footer className="home-foot">
        规则引擎：engine/（原样复用） · 表现层：React 19 + PixiJS 8 · 战斗由本仓库引擎结算，不依赖外部战斗框架
        <br />
        许可：<a href="https://github.com/0Estee/ka_pai/blob/main/LICENSE" target="_blank" rel="noreferrer">AGPL-3.0</a>
        {" · "}
        <a href="https://github.com/0Estee/ka_pai" target="_blank" rel="noreferrer">源码</a>
      </footer>
    </div>
  )
}
