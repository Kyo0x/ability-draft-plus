import { ipcMain, nativeTheme, screen, app, shell, globalShortcut } from 'electron'
import log from 'electron-log/main'
import type { WindowManager } from '../services/window-manager'
import type { DatabaseService } from '../services/database-service'
import type { BackupService } from '../services/backup-service'
import type { MlService } from '../services/ml-service'
import type { LayoutService } from '../services/layout-service'
import type { ScreenshotService } from '../services/screenshot-service'
import type { ScanProcessingService } from '../services/scan-processing-service'
import type { WindowTrackerService } from '../services/window-tracker-service'
import type { StoreApi } from 'zustand/vanilla'
import type { DraftStore } from '../store/draft-store'
import type { AppStore } from '../store/app-store'
import type { ZustandBridge } from '@zubridge/electron/main'
import type { UpdateService } from '../services/update-service'
import type { ScraperService } from '../services/scraper-service'
import type { StreamServerService } from '../services/stream-server-service'
import type { IconCacheService } from '../services/icon-cache-service'
import type { GsiCfgService } from '../services/gsi-cfg-service'
import { registerDatabaseHandlers } from './database-handlers'
import { registerMlHandlers } from './ml-handlers'
import { registerDraftHandlers } from './draft-handlers'
import { registerScraperHandlers } from './scraper-handlers'
import { registerResolutionHandlers } from './resolution-handlers'
import { registerFeedbackHandlers } from './feedback-handlers'
import { registerDevHandlers } from './dev-handlers'
import { registerStreamHandlers } from './stream-handlers'
import { loadApiConfig } from '../services/api-config'
import type { FeedbackService } from '../services/feedback-service'
import type { ScanTriggerService } from '../services/scan-trigger-service'

// @DEV-GUIDE: Central IPC handler registration. All renderer↔main communication goes through
// typed IPC channels following the domain:action naming convention (e.g. 'ml:scan', 'hero:getAll').
//
// Two IPC patterns are used:
// - ipcMain.handle(channel, handler) → renderer invokes with ipcRenderer.invoke() → returns Promise
// - ipcMain.on(channel, handler) → renderer sends with ipcRenderer.send() → fire-and-forget
//
// Handlers are split into domain-grouped files for maintainability:
// - database-handlers: hero, ability, settings, backup CRUD
// - ml-handlers: ML init, scan (screenshot → ML → scan processing → overlay:data)
// - draft-handlers: My Spot / My Model selection (broadcast to both windows)
// - scraper-handlers: Windrun + Liquipedia scrape triggers
// - resolution-handlers: layout CRUD, calibration, screenshot capture/submit
//
// This file handles: app domain (version, system info, theme), overlay domain (activate/close/
// mouse events), and update domain (check/download/install). The overlay:activate handler
// is the most complex -- see its inline comment below.

const logger = log.scope('ipc')
const IS_WINDOWS = process.platform === 'win32'

export function registerIpcHandlers(
  windowManager: WindowManager,
  dbService: DatabaseService,
  backupService: BackupService,
  mlService: MlService,
  layoutService: LayoutService,
  screenshotService: ScreenshotService,
  draftStore: StoreApi<DraftStore>,
  scanProcessingService: ScanProcessingService,
  appStore: AppStore,
  bridge: ZustandBridge,
  updateService: UpdateService,
  windowTracker: WindowTrackerService,
  scraperService: ScraperService,
  streamService: StreamServerService,
  iconCache: IconCacheService,
  gsiCfgService: GsiCfgService,
  feedbackService: FeedbackService,
  scanTrigger: ScanTriggerService,
): void {
  logger.info('Registering IPC handlers...')

  // App domain
  ipcMain.handle('app:getVersion', () => app.getVersion())

  ipcMain.handle('app:isPackaged', () => app.isPackaged)

  ipcMain.handle('app:getSystemInfo', () => {
    const primaryDisplay = screen.getPrimaryDisplay()
    return {
      width: primaryDisplay.size.width,
      height: primaryDisplay.size.height,
      scaleFactor: primaryDisplay.scaleFactor,
      resolutionString: `${primaryDisplay.size.width}x${primaryDisplay.size.height}`,
    }
  })

  ipcMain.handle('app:getDisplays', () => {
    const primaryDisplay = screen.getPrimaryDisplay()
    return screen.getAllDisplays().map((d, index) => ({
      id: d.id,
      label: d.id === primaryDisplay.id ? `Display 1 (Primary)` : `Display ${index + 1}`,
      bounds: d.bounds,
      scaleFactor: d.scaleFactor,
      isPrimary: d.id === primaryDisplay.id,
    }))
  })

  ipcMain.handle('theme:get', () => ({
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
  }))

  ipcMain.on('app:openExternal', (_event, data: { url: string }) => {
    try {
      const url = new URL(data.url)
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        shell.openExternal(data.url)
      } else {
        logger.warn('Blocked opening non-HTTP URL', { url: data.url })
      }
    } catch {
      logger.warn('Invalid URL', { url: data.url })
    }
  })

  // Overlay domain
  let pendingOverlayData: import('@shared/types').OverlayDataPayload | null = null

  // Renderer calls this on mount to get initial data (avoids did-finish-load race)
  ipcMain.handle('overlay:getInitialData', () => pendingOverlayData)

  // @DEV-GUIDE: Overlay activation is the most complex IPC handler. Sequence:
  // 1. Auto-detect resolution from game window (physical bounds) or primary display
  // 2. Look up layout coordinates via layout service cascade (custom → preset → auto-scale)
  // 3. Minimize control panel, create overlay window, subscribe to @zubridge
  // 4. Store initial overlay data (pendingOverlayData) for the renderer to fetch on mount
  // 5. Start window tracking (polls game window every 2s for windowed-mode repositioning)
  // 6. Listen to overlay 'closed' event to clean up state (tracker, appStore, pendingData)
  //
  // Multi-monitor: if overlayMonitor === 'secondary' and a second display exists, the overlay
  // opens on the secondary display. The scaleFactor sent to the renderer becomes a composite:
  //   compositeScaleFactor = gamePhysicalHeight / overlayDisplay.bounds.height
  // This maps game physical pixel coordinates (from layout_coordinates.json) to the overlay
  // window's logical CSS pixel space, which may have a different DPI from the game display.
  //
  // The pendingOverlayData pattern avoids a race: overlay renderer mounts asynchronously,
  // so overlay:getInitialData lets it pull data when ready instead of relying on did-finish-load.
  ipcMain.handle('overlay:activate', () => {
    const primaryDisplay = screen.getPrimaryDisplay()
    const allDisplays = screen.getAllDisplays()
    const overlayMonitor = appStore.getState().overlayMonitor

    // Determine which display the overlay opens on (may differ from game display)
    let overlayDisplay = primaryDisplay
    if (overlayMonitor === 'secondary' && allDisplays.length > 1) {
      overlayDisplay = allDisplays.find((d) => d.id !== primaryDisplay.id) ?? primaryDisplay
      logger.info('Second monitor mode activated', { gameDisplayId: primaryDisplay.id, overlayDisplayId: overlayDisplay.id })
    } else if (overlayMonitor === 'secondary') {
      logger.warn('Second monitor requested but only one display detected, falling back to primary')
    }

    // Auto-detect resolution from game window (always on primary) or primary display size
    const gameBounds = windowTracker.getGameWindowPhysicalBounds()
    const gamePhysW = gameBounds
      ? gameBounds.width
      : Math.round(primaryDisplay.size.width * primaryDisplay.scaleFactor)
    const gamePhysH = gameBounds
      ? gameBounds.height
      : Math.round(primaryDisplay.size.height * primaryDisplay.scaleFactor)
    const resolution = `${gamePhysW}x${gamePhysH}`

    const source = layoutService.getLayoutSource(resolution)
    const coords = layoutService.getLayout(resolution)

    if (!coords) {
      logger.warn('No layout coordinates for auto-detected resolution', { resolution, source })
      return { success: false, error: `Unsupported resolution: ${resolution}. No layout coordinates available.` }
    }

    const controlPanel = windowManager.getControlPanelWindow()
    if (controlPanel && !controlPanel.isDestroyed()) {
      controlPanel.minimize()
    }

    // compositeScaleFactor: maps game physical pixels → overlay logical CSS pixels.
    // When overlay is on same display as game: equals layoutService.getScaleFactor() (display DPI scale).
    // When overlay is on a different display: cross-display mapping keeps hotspots correctly aligned.
    const compositeScaleFactor = gamePhysH / overlayDisplay.bounds.height

    const overlayWin = windowManager.createOverlayWindow(overlayDisplay)
    bridge.subscribe([overlayWin])
    appStore.setState({ overlayActive: true, activeResolution: resolution, activeResolutionSource: source })

    // Global scan hotkeys, active only while the overlay is open. The overlay never
    // holds keyboard focus (showInactive + click-through), so in-window key handlers
    // can't work — globalShortcut is the only way to trigger a scan from the game.
    const sendHotkey = (action: 'scan' | 'rescan'): void => {
      const win = windowManager.getOverlayWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('overlay:hotkey', { action })
      }
    }
    globalShortcut.register('Control+Shift+S', () => sendHotkey('scan'))
    globalShortcut.register('Control+Shift+R', () => sendHotkey('rescan'))

    // Direct screenshot service to capture from the game display when it differs from overlay display
    const isCrossDisplay = overlayDisplay.id !== primaryDisplay.id
    screenshotService.setTargetDisplay(isCrossDisplay ? primaryDisplay.bounds : null)

    // Store initial setup data so the renderer can request it after mounting
    pendingOverlayData = {
      initialSetup: true,
      scanData: null,
      targetResolution: resolution,
      scaleFactor: compositeScaleFactor,
      opCombinations: [],
      trapCombinations: [],
      heroSynergies: [],
      heroTraps: [],
      heroModels: [],
      heroesForMySpotUI: [],
      selectedHeroForDraftingDbId: null,
      selectedModelHeroOrder: null,
      heroesCoords: coords.heroes_coords ?? [],
      heroesParams: coords.heroes_params ?? { width: 0, height: 0 },
      modelsCoords: coords.models_coords ?? [],
      bestPickSuggestions: [],
    }

    // Auto-detect game window and reposition overlay for windowed mode (Windows only).
    // On Linux/macOS we run as a companion window, typically on a second display.
    if (IS_WINDOWS) {
      const displayBounds = overlayDisplay.bounds

      windowTracker.startTracking((trackBounds) => {
        if (trackBounds && (
          trackBounds.width < displayBounds.width ||
          trackBounds.height < displayBounds.height
        )) {
          // Game window is smaller than display → windowed mode
          windowManager.repositionOverlay(trackBounds, overlayDisplay)
        } else {
          // Fullscreen/borderless or game not found → use full overlay display
          windowManager.repositionOverlay(displayBounds, overlayDisplay)
        }
      })
    }

    // Reset state when overlay window closes for any reason (user close, crash, etc.)
    overlayWin.on('closed', () => {
      globalShortcut.unregister('Control+Shift+S')
      globalShortcut.unregister('Control+Shift+R')
      windowTracker.stopTracking()
      screenshotService.setTargetDisplay(null)
      appStore.setState({ overlayActive: false, activeResolution: null, activeResolutionSource: null })
      draftStore.getState().resetSession()
      streamService.onSessionReset()
      pendingOverlayData = null

      const cp = windowManager.getControlPanelWindow()
      if (cp && !cp.isDestroyed()) {
        cp.restore()
        cp.focus()
      }
    })

    logger.info('Overlay activated', { resolution, source, overlayDisplayId: overlayDisplay.id, compositeScaleFactor })
    return { success: true, resolution, source }
  })

  ipcMain.on('overlay:close', () => {
    windowTracker.stopTracking()
    windowManager.closeOverlay()
    appStore.setState({ overlayActive: false, activeResolution: null, activeResolutionSource: null })
  })

  // Overlay Reset button: clear the main-process draft session (pool caches + selections).
  // Without this, a Reset followed by a Rescan diffs against the previous draft's pool.
  ipcMain.on('overlay:reset', () => {
    draftStore.getState().resetSession()
    streamService.onSessionReset()
  })

  ipcMain.on(
    'overlay:setMouseIgnore',
    (_event, data: { ignore: boolean; forward?: boolean }) => {
      windowManager.setOverlayMouseEvents(data.ignore, data.forward ?? true)
    },
  )

  // Database domain (hero, ability, settings, backup)
  registerDatabaseHandlers(dbService, backupService)

  // API config is shared by the resolution and feedback domains
  const apiConfig = loadApiConfig()

  // Feedback domain (Report Failed Recognition → export/upload samples).
  // The service itself is created in main/index.ts (shared with ScanTriggerService).
  registerFeedbackHandlers(feedbackService, windowManager)

  // ML domain
  registerMlHandlers(mlService, windowManager, scanTrigger, appStore, dbService)

  // Draft domain (My Spot, My Model, Manual Hero ID)
  registerDraftHandlers(draftStore, windowManager, dbService, appStore, layoutService, scanProcessingService)

  // Scraper domain
  registerScraperHandlers(scraperService)

  // Streamer view domain
  registerStreamHandlers(streamService, dbService, iconCache, gsiCfgService, windowManager)

  // Resolution domain
  registerResolutionHandlers(layoutService, screenshotService, windowTracker, windowManager, apiConfig)

  // Dev-only ML pipeline cockpit (gather/upload/retrain shortcuts)
  if (!app.isPackaged) {
    registerDevHandlers(appStore, dbService)
  }

  // Update domain
  ipcMain.on('app:checkUpdate', () => {
    updateService.checkForUpdates()
  })

  ipcMain.on('app:downloadUpdate', () => {
    updateService.downloadUpdate()
  })

  ipcMain.on('app:installUpdate', () => {
    updateService.installUpdate()
  })

  logger.info('IPC handlers registered')
}
