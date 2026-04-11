import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import sharp from 'sharp'

// Mock electron's desktopCapturer (used by captureWindow)
const mockGetSources = vi.fn()
vi.mock('electron', () => ({
  desktopCapturer: {
    getSources: (...args: unknown[]) => mockGetSources(...args),
  },
}))

// Mock screenshot-desktop (used by capture)
const mockScreenshot = vi.fn()
vi.mock('screenshot-desktop', () => ({
  default: (...args: unknown[]) => mockScreenshot(...args),
}))

// Mock node:child_process's spawn (used by the Wayland/grim fallback)
const mockSpawn = vi.fn()
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}))

vi.mock('electron-log/main', () => ({
  default: {
    scope: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}))

import { createScreenshotService } from '../../../../src/main/services/screenshot-service'

/** This suite may run on a real Wayland/Hyprland host — force a deterministic,
 *  non-Wayland environment by default so capture() takes the screenshot-desktop
 *  path. The dedicated "Wayland fallback" describe block below opts back in. */
const ORIGINAL_ENV = { ...process.env }
function setWaylandEnv(enabled: boolean): void {
  if (enabled) {
    process.env['XDG_SESSION_TYPE'] = 'wayland'
    process.env['WAYLAND_DISPLAY'] = 'wayland-1'
  } else {
    delete process.env['XDG_SESSION_TYPE']
    delete process.env['WAYLAND_DISPLAY']
    delete process.env['HYPRLAND_INSTANCE_SIGNATURE']
  }
}

/** 2x2 BGRA bitmap: every pixel B=10, G=20, R=30, A=255. */
function makeBgraBitmap(width = 2, height = 2): Buffer {
  const buffer = Buffer.alloc(width * height * 4)
  for (let i = 0; i < buffer.length; i += 4) {
    buffer[i] = 10
    buffer[i + 1] = 20
    buffer[i + 2] = 30
    buffer[i + 3] = 255
  }
  return buffer
}

function makeSource(
  id: string,
  displayId: string,
  options: { name?: string; width?: number; height?: number; empty?: boolean } = {},
) {
  const width = options.width ?? 2
  const height = options.height ?? 2
  return {
    id,
    display_id: displayId,
    name: options.name ?? '',
    thumbnail: {
      toBitmap: () => (options.empty ? Buffer.alloc(0) : makeBgraBitmap(width, height)),
      getSize: () => ({ width, height }),
    },
  }
}

describe('ScreenshotService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    setWaylandEnv(false)
    mockScreenshot.mockResolvedValue(Buffer.from('screenshot-data'))
  })

  afterEach(() => {
    vi.useRealTimers()
    process.env = { ...ORIGINAL_ENV }
  })

  describe('capture', () => {
    it('captures a screenshot on first call', async () => {
      const service = createScreenshotService()
      const result = await service.capture()

      expect(mockScreenshot).toHaveBeenCalledWith({ format: 'png' })
      expect(result).toEqual(Buffer.from('screenshot-data'))
    })

    it('returns cached screenshot within TTL', async () => {
      const service = createScreenshotService()

      await service.capture()
      vi.advanceTimersByTime(1000) // Within 2s TTL
      const result = await service.capture()

      expect(mockScreenshot).toHaveBeenCalledTimes(1) // Only one actual capture
      expect(result).toEqual(Buffer.from('screenshot-data'))
    })

    it('captures new screenshot after TTL expires', async () => {
      const service = createScreenshotService()

      await service.capture()
      vi.advanceTimersByTime(2100) // Past 2s TTL

      const newBuffer = Buffer.from('new-screenshot')
      mockScreenshot.mockResolvedValueOnce(newBuffer)
      const result = await service.capture()

      expect(mockScreenshot).toHaveBeenCalledTimes(2)
      expect(result).toEqual(newBuffer)
    })

    it('bypasses cache when forceCapture is true', async () => {
      const service = createScreenshotService()

      await service.capture()
      const result = await service.capture(true)

      expect(mockScreenshot).toHaveBeenCalledTimes(2)
      expect(result).toBeDefined()
    })
  })

  describe('prefetch', () => {
    it('starts background capture interval', async () => {
      const service = createScreenshotService()
      service.startPrefetch()

      // Initial capture + interval
      await vi.advanceTimersByTimeAsync(0)
      expect(mockScreenshot).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1500)
      expect(mockScreenshot).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(1500)
      expect(mockScreenshot).toHaveBeenCalledTimes(3)

      service.stopPrefetch()
    })

    it('does not start multiple prefetch timers', async () => {
      const service = createScreenshotService()
      service.startPrefetch()
      service.startPrefetch() // Second call should be no-op

      await vi.advanceTimersByTimeAsync(0)
      expect(mockScreenshot).toHaveBeenCalledTimes(1)

      service.stopPrefetch()
    })

    it('stops prefetch cleanly', async () => {
      const service = createScreenshotService()
      service.startPrefetch()

      await vi.advanceTimersByTimeAsync(0)
      expect(mockScreenshot).toHaveBeenCalledTimes(1)

      service.stopPrefetch()

      await vi.advanceTimersByTimeAsync(3000)
      expect(mockScreenshot).toHaveBeenCalledTimes(1) // No more captures
    })
  })

  describe('clearCache', () => {
    it('clears cached screenshot', async () => {
      const service = createScreenshotService()

      await service.capture()
      service.clearCache()

      await service.capture()
      expect(mockScreenshot).toHaveBeenCalledTimes(2)
    })
  })

  describe('Wayland fallback (grim)', () => {
    function makeFakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> } {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter
        stderr: EventEmitter
        kill: ReturnType<typeof vi.fn>
      }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = vi.fn()
      return child
    }

    beforeEach(() => {
      setWaylandEnv(true)
    })

    it('uses grim instead of screenshot-desktop when on a Wayland session', async () => {
      const child = makeFakeChild()
      mockSpawn.mockReturnValue(child)

      const service = createScreenshotService()
      const capturePromise = service.capture()

      expect(mockSpawn).toHaveBeenCalledWith('grim', expect.arrayContaining(['-t', 'png', '-']))
      child.stdout.emit('data', Buffer.from('grim-png-data'))
      child.emit('close', 0)

      const result = await capturePromise
      expect(result).toEqual(Buffer.from('grim-png-data'))
      expect(mockScreenshot).not.toHaveBeenCalled()
    })

    it('falls back to screenshot-desktop when grim fails', async () => {
      const child = makeFakeChild()
      mockSpawn.mockReturnValue(child)

      const service = createScreenshotService()
      const capturePromise = service.capture()

      child.emit('error', new Error('grim not found'))

      const result = await capturePromise
      expect(mockScreenshot).toHaveBeenCalledWith({ format: 'png' })
      expect(result).toEqual(Buffer.from('screenshot-data'))
    })
  })

  describe('captureWindow', () => {
    it('captures a window source matched by exact title', async () => {
      mockGetSources.mockResolvedValue([
        makeSource('window:1', '', { name: 'Discord', width: 2, height: 2 }),
        makeSource('window:2', '', { name: 'Dota 2', width: 2, height: 2 }),
      ])

      const service = createScreenshotService()
      const png = await service.captureWindow('Dota 2', { width: 2, height: 2 })

      expect(mockGetSources).toHaveBeenCalledWith({
        types: ['window'],
        thumbnailSize: { width: 2, height: 2 },
      })
      expect(png).not.toBeNull()
      const meta = await sharp(png as Buffer).metadata()
      expect(meta.width).toBe(2)
    })

    it('returns null when the window is not among the sources', async () => {
      mockGetSources.mockResolvedValue([
        makeSource('window:1', '', { name: 'Discord' }),
      ])
      const service = createScreenshotService()
      expect(await service.captureWindow('Dota 2', { width: 2, height: 2 })).toBeNull()
    })

    it('returns null when the captured size deviates from the expected size', async () => {
      // Windowed mode: the window includes its frame, so it is larger than the
      // client area the caller expects
      mockGetSources.mockResolvedValue([
        makeSource('window:2', '', { name: 'Dota 2', width: 8, height: 8 }),
      ])
      const service = createScreenshotService()
      expect(await service.captureWindow('Dota 2', { width: 2, height: 2 })).toBeNull()
    })

    it('returns null instead of throwing when capture fails', async () => {
      mockGetSources.mockRejectedValue(new Error('capture backend gone'))
      const service = createScreenshotService()
      expect(await service.captureWindow('Dota 2', { width: 2, height: 2 })).toBeNull()
    })
  })
})
