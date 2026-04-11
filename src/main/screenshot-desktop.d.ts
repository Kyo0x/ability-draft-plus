declare module 'screenshot-desktop' {
  interface ScreenshotOptions {
    format?: 'png' | 'jpg'
    filename?: string
    screen?: string
  }

  function screenshot(options?: ScreenshotOptions): Promise<Buffer>

  export default screenshot
}