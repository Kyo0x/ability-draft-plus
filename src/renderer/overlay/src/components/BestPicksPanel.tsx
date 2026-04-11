import { useTranslation } from 'react-i18next'
import { useMousePassthrough } from '../hooks/use-mouse-passthrough'
import type { BestPickSuggestion } from '@shared/types'

interface BestPicksPanelProps {
  suggestions: BestPickSuggestion[]
  visible: boolean
  onToggle: () => void
}

function formatWr(wr: number): string {
  return `${(wr * 100).toFixed(1)}%`
}

export function BestPicksPanel({
  suggestions,
  visible,
  onToggle,
}: BestPicksPanelProps): React.ReactElement | null {
  const { t } = useTranslation()
  const { onMouseEnter, onMouseLeave } = useMousePassthrough()

  if (suggestions.length === 0) return null

  if (!visible) {
    return (
      <button
        className="overlay-btn overlay-interactive overlay-btn-teal"
        onClick={onToggle}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {t('bestPicks.show', { count: suggestions.length })}
      </button>
    )
  }

  return (
    <div
      className="combination-panel overlay-interactive combination-panel-best-picks"
      role="region"
      aria-label="Best Picks"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="combination-panel-header">
        <span className="combination-panel-title">
          {t('bestPicks.title')}
        </span>
        <button
          className="overlay-btn overlay-btn-teal"
          onClick={onToggle}
          style={{ minHeight: 28, padding: '4px 10px', fontSize: 12 }}
        >
          {t('bestPicks.hide')}
        </button>
      </div>

      {suggestions.map((s, i) => (
        <div key={s.abilityName} className="combination-panel-item best-picks-item">
          <span className="best-picks-rank">{i + 1}.</span>{' '}
          <span className="best-picks-ability">{s.abilityDisplayName}</span>{' '}
          <span className="best-picks-winrate">({formatWr(s.synergyWinrate)})</span>
          <span className="best-picks-pairs-with">
            {' '}{t('bestPicks.pairsWith', { ability: s.synergizesWithDisplayName })}
          </span>
        </div>
      ))}
    </div>
  )
}
