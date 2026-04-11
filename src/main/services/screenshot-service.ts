import { desktopCapturer } from 'electron'
import sharp from 'sharp'
import log from 'electron-log/main'
import screenshot from 'screenshot-desktop'
import { spawn } from 'node:child_process'
import {
  SCREENSHOT_CACHE_TTL,
  SCREENSHOT_PREFETCH_INTERVAL,
} from '@shared/constants/thresholds'

// @DEV-GUIDE: Two capture paths:
// - capture(forceCapture?): full screen via screenshot-desktop, cached for
//   SCREENSHOT_CACHE_TTL (2s) unless forceCapture bypasses it. On Linux/Wayland
//   (incl. Hyprland) screenshot-desktop is unreliable, so it falls back to
//   spawning `grim`; on any other Linux capture failure it also tries grim as
//   a last resort. startPrefetch()/stopPrefetch() keep a warm cached frame so
//   a scan trigger doesn't pay full capture latency. setTargetDisplay() scopes
//   capture (and grim's `-g` geometry) to a specific display's bounds — used
//   for companion mode, where the overlay sits on a different monitor than
//   the game.
// - captureWindow(title, expectedSize): Electron's native desktopCapturer,
//   by exact window title — the fast path for fullscreen/borderless Dota on
//   Windows. Returns null (never throws) when the source is unavailable or
//   the frame size doesn't match; callers fall back to capture().
//
// PNG encoding for captureWindow is NOT done with NativeImage.toPNG(): that is
// synchronous on the main process thread (~100ms+ at 1440p) and froze the event
// loop once auto-rescan started running every 5s. Instead the raw BGRA bitmap is
// swapped to RGBA (cheap) and encoded by sharp on the libuv threadpool.

const logger = log.scope('screenshot')

const WINDOW_SIZE_TOLERANCE_PX = 2
// Fast compression: scan screenshots are transient (worker decodes them right
// away); trading size for encode speed keeps the threadpool stall negligible.
const PNG_COMPRESSION_LEVEL = 1
const SCREENSHOT_TIMEOUT_MS = 5000

export interface ScreenshotService {
  /** Full screen (or the target display set via setTargetDisplay), cached. */
  capture(forceCapture?: boolean): Promise<Buffer>
  /**
   * Capture one window by exact title at the expected physical size. Null when
   * the window source is unavailable or the frame size doesn't match.
   */
  captureWindow(
    title: string,
    expectedSize: { width: number; height: number },
  ): Promise<Buffer | null>
  startPrefetch(): void
  stopPrefetch(): void
  clearCache(): void
  /** Set the logical bounds of the display to capture (Electron display.bounds).
   *  Pass null to revert to the default full-screen capture. */
  setTargetDisplay(bounds: { x: number; y: number; width: number; height: number } | null): void
}

/** Electron bitmaps are BGRA; sharp expects RGBA — swap in place (a few ms). */
function bgraToRgba(buffer: Buffer): Buffer {
  for (let i = 0; i < buffer.length; i += 4) {
    const blue = buffer[i]
    buffer[i] = buffer[i + 2]
    buffer[i + 2] = blue
  }
  return buffer
}

async function encodePng(thumbnail: Electron.NativeImage): Promise<Buffer> {
  const size = thumbnail.getSize()
  const raw = thumbnail.toBitmap()
  if (raw.length === 0 || size.width === 0 || size.height === 0) {
    throw new Error('Capture returned an empty image')
  }
  return sharp(bgraToRgba(raw), {
    raw: { width: size.width, height: size.height, channels: 4 },
  })
    .png({ compressionLevel: PNG_COMPRESSION_LEVEL })
    .toBuffer()
}

export function createScreenshotService(): ScreenshotService {
  let cachedBuffer: Buffer | null = null
  let cacheTimestamp = 0
  let prefetchTimer: ReturnType<typeof setInterval> | null = null
  let targetDisplayBounds: { x: number; y: number; width: number; height: number } | null = null

  const isLinux = process.platform === 'linux'
  const isWaylandSession =
    process.env['XDG_SESSION_TYPE'] === 'wayland' ||
    Boolean(process.env['WAYLAND_DISPLAY']) ||
    Boolean(process.env['HYPRLAND_INSTANCE_SIGNATURE'])

  async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      promise
        .then((result) => {
          clearTimeout(timer)
          resolve(result)
        })
        .catch((error) => {
          clearTimeout(timer)
          reject(error)
        })
    })
  }

  async function captureWithGrim(): Promise<Buffer> {
    // Build grim args: optionally restrict capture to a specific display region
    const grimArgs: string[] = []
    if (targetDisplayBounds !== null) {
      const { x, y, width: w, height: h } = targetDisplayBounds
      grimArgs.push('-g', `${x},${y} ${w}x${h}`)
    }
    grimArgs.push('-t', 'png', '-')

    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn('grim', grimArgs)
      const chunks: Buffer[] = []
      let stderr = ''
      let finished = false

      const killTimer = setTimeout(() => {
        if (finished) return
        child.kill('SIGKILL')
        reject(new Error(`grim timed out after ${SCREENSHOT_TIMEOUT_MS}ms`))
      }, SCREENSHOT_TIMEOUT_MS)

      child.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      child.on('error', (error) => {
        if (finished) return
        finished = true
        clearTimeout(killTimer)
        reject(error)
      })

      child.on('close', (code) => {
        if (finished) return
        finished = true
        clearTimeout(killTimer)

        if (code === 0) {
          resolve(Buffer.concat(chunks))
          return
        }
        reject(new Error(stderr || `grim exited with code ${code}`))
      })
    })
  }

  async function captureWithFallback(): Promise<Buffer> {
    if (isLinux && isWaylandSession) {
      try {
        return await captureWithGrim()
      } catch (grimError) {
        const grimMsg = grimError instanceof Error ? grimError.message : String(grimError)
        logger.warn('Wayland grim capture failed, attempting screenshot-desktop fallback', {
          error: grimMsg,
        })

        try {
          return await withTimeout(
            screenshot({ format: 'png' }) as Promise<Buffer>,
            SCREENSHOT_TIMEOUT_MS,
            'screenshot-desktop capture',
          )
        } catch (primaryError) {
          const primaryMsg = primaryError instanceof Error ? primaryError.message : String(primaryError)
          throw new Error(
            `Screenshot capture failed on Linux Wayland. Ensure grim is installed (e.g. \"sudo pacman -S grim\") and screen capture is allowed. grim error: ${grimMsg}. screenshot-desktop error: ${primaryMsg}`,
          )
        }
      }
    }

    try {
      return await withTimeout(
        screenshot({ format: 'png' }) as Promise<Buffer>,
        SCREENSHOT_TIMEOUT_MS,
        'screenshot-desktop capture',
      )
    } catch (primaryError) {
      const primaryMsg = primaryError instanceof Error ? primaryError.message : String(primaryError)

      if (!isLinux) {
        throw primaryError
      }

      logger.warn('Primary screenshot capture failed, attempting Linux fallback', {
        error: primaryMsg,
      })

      try {
        const fallback = await captureWithGrim()
        logger.info('Linux screenshot fallback succeeded (grim)')
        return fallback
      } catch (fallbackError) {
        const fallbackMsg =
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        throw new Error(
          `Screenshot capture failed on Linux. Install grim (e.g. \"sudo pacman -S grim\") and retry. Primary error: ${primaryMsg}. Fallback error: ${fallbackMsg}`,
        )
      }
    }
  }

  async function captureAndCache(): Promise<Buffer> {
    const buffer = await captureWithFallback()
    cachedBuffer = buffer
    cacheTimestamp = Date.now()
    return buffer
  }

  async function capture(forceCapture = false): Promise<Buffer> {
    const now = Date.now()
    if (
      !forceCapture &&
      cachedBuffer &&
      now - cacheTimestamp < SCREENSHOT_CACHE_TTL
    ) {
      return cachedBuffer
    }
    return captureAndCache()
  }

  async function captureWindow(
    title: string,
    expectedSize: { width: number; height: number },
  ): Promise<Buffer | null> {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: expectedSize,
      })
      const source = sources.find((s) => s.name === title)
      if (!source) {
        logger.debug('Window source not found, falling back', { title })
        return null
      }

      const size = source.thumbnail.getSize()
      if (
        Math.abs(size.width - expectedSize.width) > WINDOW_SIZE_TOLERANCE_PX ||
        Math.abs(size.height - expectedSize.height) > WINDOW_SIZE_TOLERANCE_PX
      ) {
        // Windowed mode (frame included) or unexpected scaling — coordinates
        // would misalign; let the caller use the screen path instead.
        logger.debug('Window capture size mismatch, falling back', {
          title,
          captured: size,
          expected: expectedSize,
        })
        return null
      }

      const png = await encodePng(source.thumbnail)
      logger.debug('Captured game window', { title, ...size })
      return png
    } catch (error) {
      logger.warn('Window capture failed, falling back to screen', {
        title,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  function startPrefetch(): void {
    if (prefetchTimer) return
    logger.debug('Starting screenshot prefetch')
    captureAndCache().catch((err) =>
      logger.warn('Prefetch capture failed', { error: String(err) }),
    )
    prefetchTimer = setInterval(() => {
      captureAndCache().catch((err) =>
        logger.warn('Prefetch capture failed', { error: String(err) }),
      )
    }, SCREENSHOT_PREFETCH_INTERVAL)
  }

  function stopPrefetch(): void {
    if (prefetchTimer) {
      clearInterval(prefetchTimer)
      prefetchTimer = null
      logger.debug('Stopped screenshot prefetch')
    }
  }

  function clearCache(): void {
    cachedBuffer = null
    cacheTimestamp = 0
  }

  function setTargetDisplay(bounds: { x: number; y: number; width: number; height: number } | null): void {
    targetDisplayBounds = bounds
    // Invalidate cache so next capture uses the new target
    clearCache()
    logger.info('Screenshot target display set', bounds ?? { note: 'full screen' })
  }

  return {
    capture,
    captureWindow,
    startPrefetch,
    stopPrefetch,
    clearCache,
    setTargetDisplay,
  }
}
