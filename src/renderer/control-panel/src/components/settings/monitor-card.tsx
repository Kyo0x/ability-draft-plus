import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Monitor } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/hooks/use-app-store'
import { useAppDispatch } from '@/hooks/use-dispatch'
import { APP_ACTIONS } from '@shared/types/app-store'

export function MonitorCard() {
  const { t } = useTranslation('settings')
  const overlayMonitor = useAppStore((s) => s.overlayMonitor)
  const dispatch = useAppDispatch()
  const [displayCount, setDisplayCount] = useState<number>(1)

  useEffect(() => {
    window.electronApi
      .invoke('app:getDisplays')
      .then((displays) => setDisplayCount(displays.length))
      .catch(() => setDisplayCount(1))
  }, [])

  const handleSelect = (value: 'primary' | 'secondary') => {
    dispatch(APP_ACTIONS.OVERLAY_SET_MONITOR, value)
    window.electronApi.invoke('settings:set', { overlayMonitor: value }).catch(() => undefined)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Monitor className="h-4 w-4" />
          {t('monitor.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('monitor.description')}</p>
        <div className="flex gap-2">
          <Button
            variant={overlayMonitor === 'primary' ? 'default' : 'outline'}
            size="sm"
            className="flex-1"
            onClick={() => handleSelect('primary')}
          >
            {t('monitor.primary')}
          </Button>
          <Button
            variant={overlayMonitor === 'secondary' ? 'default' : 'outline'}
            size="sm"
            className="flex-1"
            disabled={displayCount < 2}
            onClick={() => handleSelect('secondary')}
            title={displayCount < 2 ? t('monitor.secondaryDisabledHint') : undefined}
          >
            {t('monitor.secondary')}
          </Button>
        </div>
        {displayCount < 2 && (
          <p className="text-xs text-muted-foreground">{t('monitor.secondaryDisabledHint')}</p>
        )}
      </CardContent>
    </Card>
  )
}
