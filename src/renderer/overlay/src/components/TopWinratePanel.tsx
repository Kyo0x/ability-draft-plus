import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useMousePassthrough } from '../hooks/use-mouse-passthrough'
import type { EnrichedScanSlot, HeroModelDisplay } from '@shared/types'

const MAX_ITEMS = 10

type Tab = 'abilities' | 'heroes'

interface TopWinratePanelProps {
  abilities: EnrichedScanSlot[]
  heroModels: HeroModelDisplay[]
  visible: boolean
  onToggle: () => void
}

function formatWr(wr: number): string {
  return `${(wr * 100).toFixed(1)}%`
}

export function TopWinratePanel({
  abilities,
  heroModels,
  visible,
  onToggle,
}: TopWinratePanelProps): React.ReactElement | null {
  const { t } = useTranslation()
  const { onMouseEnter, onMouseLeave } = useMousePassthrough()
  const [activeTab, setActiveTab] = useState<Tab>('abilities')

  const topAbilities = useMemo(() => {
    const seen = new Set<string>()
    return abilities
      .filter((a) => {
        if (!a.name || a.winrate === null) return false
        if (seen.has(a.name)) return false
        seen.add(a.name)
        return true
      })
      .sort((a, b) => (b.winrate ?? 0) - (a.winrate ?? 0))
      .slice(0, MAX_ITEMS)
  }, [abilities])

  const topHeroes = useMemo(() => {
    return heroModels
      .filter((h) => h.dbHeroId !== null && h.winrate !== null)
      .sort((a, b) => (b.winrate ?? 0) - (a.winrate ?? 0))
      .slice(0, MAX_ITEMS)
  }, [heroModels])

  const hasContent = topAbilities.length > 0 || topHeroes.length > 0
  if (!hasContent) return null

  if (!visible) {
    return (
      <button
        className="overlay-btn overlay-interactive overlay-btn-amber"
        onClick={onToggle}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {t('topWinrate.show')}
      </button>
    )
  }

  return (
    <div
      className="combination-panel overlay-interactive combination-panel-winrate"
      role="region"
      aria-label="Highest Winrate"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="combination-panel-header">
        <span className="combination-panel-title">{t('topWinrate.title')}</span>
        <button
          className="overlay-btn overlay-btn-amber"
          onClick={onToggle}
          style={{ minHeight: 28, padding: '4px 10px', fontSize: 12 }}
        >
          {t('topWinrate.hide')}
        </button>
      </div>

      <div className="winrate-tabs">
        <button
          className={`winrate-tab ${activeTab === 'abilities' ? 'winrate-tab-active' : ''}`}
          onClick={() => setActiveTab('abilities')}
        >
          {t('topWinrate.tabAbilities')}
        </button>
        <button
          className={`winrate-tab ${activeTab === 'heroes' ? 'winrate-tab-active' : ''}`}
          onClick={() => setActiveTab('heroes')}
        >
          {t('topWinrate.tabHeroes')}
        </button>
      </div>

      {activeTab === 'abilities' &&
        topAbilities.map((ability, i) => (
          <div key={ability.name} className="combination-panel-item">
            <span className="winrate-rank">{i + 1}.</span>{' '}
            <span>{ability.displayName}</span>{' '}
            ({formatWr(ability.winrate!)})
          </div>
        ))}

      {activeTab === 'heroes' &&
        topHeroes.map((hero, i) => (
          <div key={hero.heroName} className="combination-panel-item">
            <span className="winrate-rank">{i + 1}.</span>{' '}
            <span>{hero.heroDisplayName}</span>{' '}
            ({formatWr(hero.winrate!)})
          </div>
        ))}
    </div>
  )
}
