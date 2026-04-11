import { ipcMain } from 'electron'
import log from 'electron-log/main'
import type { StoreApi } from 'zustand/vanilla'
import type { DraftStore } from '../store/draft-store'
import type { WindowManager } from '../services/window-manager'
import type { DatabaseService } from '../services/database-service'
import type { ScanProcessingService } from '../services/scan-processing-service'
import type { LayoutService } from '../services/layout-service'
import type { AppStore } from '../store/app-store'

// @DEV-GUIDE: Draft domain IPC handlers for "My Spot" and "My Model" selection during overlay.
// These are fire-and-forget (ipcMain.on) because the renderer doesn't need a response.
//
// Both handlers implement toggle behavior: clicking the same hero again deselects it.
// After updating the DraftStore, the selection is broadcast to BOTH windows so the overlay
// and control panel stay in sync. The next ML scan will use these selections to personalize
// the synergy/trap suggestions (filtering by the user's hero and model).

const logger = log.scope('ipc:draft')

export function registerDraftHandlers(
  store: StoreApi<DraftStore>,
  windowManager: WindowManager,
  dbService: DatabaseService,
  appStore: AppStore,
  layoutService: LayoutService,
  scanProcessingService: ScanProcessingService,
): void {
  ipcMain.on(
    'draft:selectMySpot',
    (_event, data: { heroOrder: number; dbHeroId: number }) => {
      const state = store.getState()

      // Toggle: clicking the same hero deselects
      const isDeselecting = state.mySelectedSpotDbId === data.dbHeroId
      const newDbId = isDeselecting ? null : data.dbHeroId
      const newOrder = isDeselecting ? null : data.heroOrder

      state.selectMySpot(newDbId, newOrder)
      logger.info('My Spot selection changed', {
        dbHeroId: newDbId,
        heroOrder: newOrder,
      })

      broadcastToAll(windowManager, 'draft:selectMySpot', {
        selectedHeroOrderForDrafting: newOrder,
      })
    },
  )

  ipcMain.on(
    'draft:selectMyModel',
    (_event, data: { heroOrder: number; dbHeroId: number }) => {
      const state = store.getState()

      // Toggle: clicking the same hero deselects
      const isDeselecting = state.mySelectedModelDbHeroId === data.dbHeroId
      const newDbId = isDeselecting ? null : data.dbHeroId
      const newOrder = isDeselecting ? null : data.heroOrder

      state.selectMyModel(newDbId, newOrder)
      logger.info('My Model selection changed', {
        dbHeroId: newDbId,
        heroOrder: newOrder,
      })

      broadcastToAll(windowManager, 'draft:selectMyModel', {
        selectedModelHeroOrder: newOrder,
      })
    },
  )

  ipcMain.on(
    'draft:identifyHero',
    (_event, data: { heroOrder: number; heroId: number }) => {
      const state = store.getState()
      const hero = dbService.heroes.getById(data.heroId)
      if (!hero) {
        logger.warn('Manual hero identification failed — hero not found', { heroId: data.heroId })
        return
      }

      // Update the hero in identifiedHeroModelsCache
      const updatedModels = state.identifiedHeroModelsCache.map((m) => {
        if (m.heroOrder !== data.heroOrder) return m
        return {
          ...m,
          heroName: hero.name,
          heroDisplayName: hero.displayName,
          dbHeroId: hero.heroId,
          winrate: hero.winrate,
          highSkillWinrate: hero.highSkillWinrate,
          pickRate: hero.pickRate,
          hsPickRate: hero.hsPickRate,
          identificationConfidence: 1.0, // manual override = full confidence
        }
      })

      store.setState({ identifiedHeroModelsCache: updatedModels })
      logger.info('Manual hero identification', {
        heroOrder: data.heroOrder,
        heroName: hero.displayName,
      })

      // Re-process to re-enrich and broadcast updated overlay data
      const resolution = appStore.getState().activeResolution
      if (resolution) {
        const scaleFactor = layoutService.getScaleFactor()
        // Pass the cached selected abilities so picked-ability display is preserved
        scanProcessingService.handleScanResults(
          state.lastSelectedAbilities,
          false,
          resolution,
          scaleFactor,
        )
      }
    },
  )

  logger.info('Draft IPC handlers registered')
}

function broadcastToAll(
  wm: WindowManager,
  channel: string,
  data: unknown,
): void {
  const cp = wm.getControlPanelWindow()
  const overlay = wm.getOverlayWindow()
  if (cp && !cp.isDestroyed()) cp.webContents.send(channel, data)
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send(channel, data)
}
