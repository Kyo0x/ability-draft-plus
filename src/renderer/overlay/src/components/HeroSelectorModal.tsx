import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useMousePassthrough } from '../hooks/use-mouse-passthrough'
import type { Hero } from '@shared/types'

interface HeroSelectorModalProps {
  heroOrder: number
  open: boolean
  onClose: () => void
}

export function HeroSelectorModal({
  heroOrder,
  open,
  onClose,
}: HeroSelectorModalProps): React.ReactElement | null {
  const { t } = useTranslation()
  const { onMouseEnter, onMouseLeave } = useMousePassthrough()
  const [query, setQuery] = useState('')
  const [heroes, setHeroes] = useState<Hero[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  // Fetch hero list once when modal opens
  useEffect(() => {
    if (!open) return
    setQuery('')
    window.electronApi.invoke('hero:getAll').then((list) => {
      setHeroes(list.sort((a, b) => a.displayName.localeCompare(b.displayName)))
    })
  }, [open])

  // Auto-focus input when modal opens
  useEffect(() => {
    if (open) {
      // Small delay to ensure DOM is painted
      const id = setTimeout(() => inputRef.current?.focus(), 50)
      return () => clearTimeout(id)
    }
  }, [open])

  const filtered = query.trim().length > 0
    ? heroes.filter((h) =>
        h.displayName.toLowerCase().includes(query.toLowerCase()),
      )
    : heroes

  const handleSelect = useCallback(
    (hero: Hero) => {
      window.electronApi.send('draft:identifyHero', {
        heroOrder,
        heroId: hero.heroId,
      })
      onClose()
    },
    [heroOrder, onClose],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        // Stop the native event so the window-level Escape handler
        // does not also fire overlay:close while the modal is open.
        e.nativeEvent.stopImmediatePropagation()
        onClose()
      }
    },
    [onClose],
  )

  if (!open) return null

  return (
    <div
      className="hero-selector-scrim overlay-interactive"
      onClick={onClose}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onKeyDown={handleKeyDown}
    >
      <div
        className="hero-selector-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="hero-selector-header">
          <span className="hero-selector-title">
            {t('heroSelector.title')}
          </span>
          <button
            className="overlay-btn overlay-btn-gray"
            onClick={onClose}
            style={{ minHeight: 28, padding: '4px 10px', fontSize: 12 }}
          >
            {t('heroSelector.cancel')}
          </button>
        </div>

        <input
          ref={inputRef}
          className="hero-selector-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('heroSelector.placeholder')}
          autoComplete="off"
          spellCheck={false}
        />

        <div className="hero-selector-list">
          {filtered.length === 0 && (
            <div className="hero-selector-empty">
              {t('heroSelector.noResults')}
            </div>
          )}
          {filtered.map((hero) => (
            <button
              key={hero.heroId}
              className="hero-selector-item"
              onClick={() => handleSelect(hero)}
            >
              <span className="hero-selector-item-name">
                {hero.displayName}
              </span>
              {hero.winrate !== null && (
                <span className="hero-selector-item-wr">
                  {(hero.winrate * 100).toFixed(1)}%
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
