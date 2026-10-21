/**
 * How the agent's browser presents itself: as a desktop, a tablet or a phone, at any viewport size,
 * independent of the small panel it is shown in. The page is laid out at the chosen size through the
 * Chromium device emulation (the same machinery as the DevTools device toolbar) and drawn scaled down
 * to fit the panel, so a 1440x900 desktop page or a 390x844 phone page both show whole and crisp.
 *
 * Everything here is pure: the presets, the user agent and client hints, the CDP commands, and the
 * fit maths. browser.ts sends the commands through the webContents debugger.
 */

export type ViewMode = 'desktop' | 'tablet' | 'phone' | 'fit'

/** What the agent (or the person) asked for. `fit` lays the page out at the panel's own size. */
export interface ViewSpec {
  mode: ViewMode
  /** CSS pixels the page lays out at. Ignored for `fit`. */
  width: number
  height: number
  /** The page's devicePixelRatio. */
  dpr: number
  /** Page zoom, 1 is normal. Zoom 0.8 lays out a wider page into the same viewport. */
  zoom: number
  /** Touch input and coarse pointer. */
  touch: boolean
  /** The `mobile` flag: meta viewport honoured, overlay scrollbars, Sec-CH-UA-Mobile ?1. */
  mobile: boolean
  /** A user agent to send instead of the mode's own. Empty means the mode's own. */
  userAgent: string
  /**
   * True when the agent asked for an exact size or aspect. A plain desktop view is not fixed: it takes the
   * shape of wherever it is shown (see shapedView), so it always fills the panel and the full screen.
   */
  fixed?: boolean
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface FitResult {
  /** Where the native view goes, in window pixels. */
  bounds: Rect
  /** Page CSS pixels to view pixels. */
  scale: number
}

export interface CdpCommand {
  method: string
  params: Record<string, unknown>
}

export const MIN_SIDE = 200
export const MAX_SIDE = 4000

export const PRESETS: Record<Exclude<ViewMode, 'fit'>, ViewSpec> = {
  desktop: { mode: 'desktop', width: 1440, height: 900, dpr: 1, zoom: 1, touch: false, mobile: false, userAgent: '' },
  tablet: { mode: 'tablet', width: 820, height: 1180, dpr: 2, zoom: 1, touch: true, mobile: true, userAgent: '' },
  phone: { mode: 'phone', width: 390, height: 844, dpr: 3, zoom: 1, touch: true, mobile: true, userAgent: '' },
}

export const FIT_VIEW: ViewSpec = { ...PRESETS.desktop, mode: 'fit', width: 0, height: 0 }

export function presetView(mode: ViewMode): ViewSpec {
  if (mode === 'fit') return { ...FIT_VIEW }
  return { ...PRESETS[mode] }
}

/**
 * Merge a request into a starting view. A new mode starts from that mode's preset; a size, zoom or
 * dpr on its own changes only that. Sizes are clamped so a typo cannot ask for a 100000px page.
 */
export function resolveView(
  current: ViewSpec,
  request: {
    mode?: ViewMode
    width?: number
    height?: number
    dpr?: number
    zoom?: number
    touch?: boolean
    userAgent?: string
    aspect?: string
  },
): ViewSpec {
  const base = request.mode !== undefined && request.mode !== current.mode ? presetView(request.mode) : { ...current }
  let width = request.width ?? base.width
  let height = request.height ?? base.height
  const ratio = parseAspect(request.aspect)
  if (ratio !== null && base.mode !== 'fit') {
    if (request.width !== undefined && request.height === undefined) height = width / ratio
    else if (request.height !== undefined && request.width === undefined) width = height * ratio
    else height = width / ratio
  }
  const asked = request.width !== undefined || request.height !== undefined || ratio !== null
  const next: ViewSpec = {
    ...base,
    fixed: request.mode !== undefined && request.mode !== current.mode ? asked : asked || current.fixed === true,
    width: base.mode === 'fit' ? 0 : clampSide(width),
    height: base.mode === 'fit' ? 0 : clampSide(height),
    dpr: clampNumber(request.dpr ?? base.dpr, 0.5, 4),
    zoom: clampNumber(request.zoom ?? base.zoom, 0.25, 3),
    touch: request.touch ?? base.touch,
    userAgent: request.userAgent !== undefined ? request.userAgent.trim().slice(0, 512) : base.userAgent,
  }
  return next
}

/** Below this the desktop page keeps a real desktop width and is drawn scaled down. */
export const DESKTOP_MIN_WIDTH = 1280

/**
 * A desktop view that was not given an exact size takes the shape of its slot: in a big slot (the full
 * screen) the page lays out at the slot's own size, drawn 1:1; in a small slot (the side panel) it keeps
 * a desktop width and takes the slot's height, so the scaled page fills the slot with no empty bands.
 */
export function shapedView(view: ViewSpec, slot: Rect): ViewSpec {
  if (view.mode !== 'desktop' || slot.width <= 0 || slot.height <= 0) return view
  const zoom = view.zoom > 0 ? view.zoom : 1
  // The narrowest the page lays out at: the width the agent asked for, or a real desktop width. A wider slot (the
  // full-size view) gets its own width, drawn 1:1; a narrower one (the panel) keeps that width, scaled down. The
  // height always follows the slot's shape, so the card or the window is filled with no empty bands.
  const least = view.fixed === true ? view.width : Math.max(PRESETS.desktop.width, DESKTOP_MIN_WIDTH)
  const width = slot.width / zoom >= least ? Math.round(slot.width / zoom) : least
  const height = Math.round((width * slot.height) / slot.width)
  return { ...view, width: clampSide(width), height: clampSide(height) }
}

/** "16:9", "16/9", "1.6" or "9x16". Null when it is not a ratio. */
export function parseAspect(value: string | undefined): number | null {
  if (value === undefined) return null
  const text = value.trim()
  if (text === '') return null
  const pair = /^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/i.exec(text)
  if (pair !== null) {
    const a = Number(pair[1])
    const b = Number(pair[2])
    return a > 0 && b > 0 ? a / b : null
  }
  const single = Number(text)
  return Number.isFinite(single) && single > 0.1 && single < 10 ? single : null
}

/**
 * The view's rectangle inside the panel slot and the scale to draw at. The page keeps its own size
 * and is scaled to fit the slot whole, centred (a phone is letterboxed with bars at the sides). It is
 * never scaled up past 1, so a page smaller than the slot is shown at its real size.
 */
export function fitView(slot: Rect, view: ViewSpec): FitResult {
  if (view.mode === 'fit' || view.width <= 0 || view.height <= 0) {
    return { bounds: { ...slot }, scale: 1 }
  }
  if (slot.width <= 0 || slot.height <= 0) {
    return { bounds: { ...slot, width: 0, height: 0 }, scale: 1 }
  }
  const scale = Math.min(1, slot.width / view.width, slot.height / view.height)
  const width = Math.max(1, Math.round(view.width * scale))
  const height = Math.max(1, Math.round(view.height * scale))
  return {
    bounds: {
      x: slot.x + Math.floor((slot.width - width) / 2),
      y: slot.y + Math.floor((slot.height - height) / 2),
      width,
      height,
    },
    scale,
  }
}

export interface EngineInfo {
  /** The engine's own Chrome version, read out of its user agent, for example 152.0.7977.167. */
  chromeVersion: string
  /** process.platform of this computer. */
  platform: string
}

export function chromeVersionOf(userAgent: string): string {
  return /Chrome\/([\d.]+)/.exec(userAgent)?.[1] ?? '130.0.0.0'
}

/**
 * The user agent for a mode. Desktop tells the truth about the operating system, so navigator.platform
 * and the UA agree; the version is always the engine's own, never a newer one it cannot back up.
 * No Electron or app token: sites treat those as an embedded shell.
 */
export function userAgentFor(view: ViewSpec, engine: EngineInfo): string {
  if (view.userAgent !== '') return view.userAgent
  const v = engine.chromeVersion
  if (view.mode === 'phone') {
    return `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Mobile Safari/537.36`
  }
  if (view.mode === 'tablet') {
    return `Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`
  }
  return `Mozilla/5.0 (${desktopPlatformToken(engine.platform)}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`
}

function desktopPlatformToken(platform: string): string {
  if (platform === 'win32') return 'Windows NT 10.0; Win64; x64'
  if (platform === 'darwin') return 'Macintosh; Intel Mac OS X 10_15_7'
  return 'X11; Linux x86_64'
}

/** Client hints that match the user agent, so Sec-CH-UA and navigator.userAgentData agree with it. */
export function userAgentMetadata(view: ViewSpec, engine: EngineInfo): Record<string, unknown> {
  const full = engine.chromeVersion
  const major = full.split('.')[0] ?? '130'
  const handheld = view.mode === 'phone' || view.mode === 'tablet'
  const platform = handheld ? 'Android' : desktopHintPlatform(engine.platform)
  return {
    brands: [
      { brand: 'Not?A_Brand', version: '99' },
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major },
    ],
    fullVersionList: [
      { brand: 'Not?A_Brand', version: '99.0.0.0' },
      { brand: 'Chromium', version: full },
      { brand: 'Google Chrome', version: full },
    ],
    fullVersion: full,
    platform,
    platformVersion: handheld ? '14.0.0' : engine.platform === 'win32' ? '10.0.0' : engine.platform === 'darwin' ? '10.15.7' : '6.5.0',
    architecture: handheld ? '' : engine.platform === 'darwin' ? 'arm' : 'x86',
    model: view.mode === 'phone' ? 'Pixel 8' : view.mode === 'tablet' ? 'Pixel Tablet' : '',
    mobile: view.mode === 'phone',
    bitness: handheld ? '' : '64',
    wow64: false,
  }
}

function desktopHintPlatform(platform: string): string {
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return 'macOS'
  return 'Linux'
}

function navigatorPlatform(view: ViewSpec, platform: string): string {
  if (view.mode === 'phone' || view.mode === 'tablet') return 'Linux armv8l'
  if (platform === 'win32') return 'Win32'
  if (platform === 'darwin') return 'MacIntel'
  return 'Linux x86_64'
}

/**
 * The CDP commands that make the page see `view`, drawn at `scale` into a `layout` sized view.
 * For `fit` the page simply takes the view's own size.
 *
 * `followElement`: the page is a <webview> the renderer sizes to the layout size and scales with CSS, so the
 * metrics override leaves the size to the element (width and height 0) and only sets the device: its pixel
 * ratio, the mobile flag and the screen. The page then resizes in the same frame as its card.
 */
export function emulationCommands(view: ViewSpec, engine: EngineInfo, fit: FitResult, followElement = false): CdpCommand[] {
  const commands: CdpCommand[] = []
  const custom = view.userAgent !== ''
  commands.push({
    method: 'Emulation.setUserAgentOverride',
    params: {
      userAgent: userAgentFor(view, engine),
      // A plain list: Chromium adds the q-values itself (passing them doubled them, "en;q=0.9;q=0.9").
      acceptLanguage: 'en-US,en',
      platform: navigatorPlatform(view, engine.platform),
      // A hand-written user agent cannot be parsed back into hints; sending none is closer to the truth.
      ...(custom ? {} : { userAgentMetadata: userAgentMetadata(view, engine) }),
    },
  })
  if (view.mode === 'fit') {
    commands.push({ method: 'Emulation.clearDeviceMetricsOverride', params: {} })
  } else {
    commands.push({
      method: 'Emulation.setDeviceMetricsOverride',
      params: {
        width: followElement ? 0 : view.width,
        height: followElement ? 0 : view.height,
        deviceScaleFactor: view.dpr,
        mobile: view.mobile,
        scale: followElement ? 1 : round4(fit.scale),
        screenWidth: view.width,
        screenHeight: view.height,
        screenOrientation:
          view.width > view.height
            ? { type: 'landscapePrimary', angle: 90 }
            : { type: 'portraitPrimary', angle: 0 },
      },
    })
  }
  commands.push({ method: 'Emulation.setTouchEmulationEnabled', params: { enabled: view.touch, maxTouchPoints: view.touch ? 5 : 1 } })
  commands.push({
    method: 'Emulation.setEmitTouchEventsForMouse',
    params: { enabled: view.touch, configuration: view.mobile ? 'mobile' : 'desktop' },
  })
  return commands
}

/** "Desktop 1440x900", "Phone 390x844", "Fits the panel". */
export function viewLabel(view: ViewSpec): string {
  if (view.mode === 'fit') return 'Fits the panel'
  const name = view.mode === 'desktop' ? 'Desktop' : view.mode === 'tablet' ? 'Tablet' : 'Phone'
  const zoom = view.zoom === 1 ? '' : ` at ${Math.round(view.zoom * 100)}%`
  return `${name} ${view.width}x${view.height}${zoom}`
}

export function isViewMode(value: unknown): value is ViewMode {
  return value === 'desktop' || value === 'tablet' || value === 'phone' || value === 'fit'
}

/** Accepts the words people and models use. */
export function viewModeOf(value: unknown): ViewMode | null {
  if (typeof value !== 'string') return null
  const word = value.trim().toLowerCase()
  if (isViewMode(word)) return word
  if (word === 'mobile' || word === 'iphone' || word === 'android') return 'phone'
  if (word === 'ipad') return 'tablet'
  if (word === 'laptop' || word === 'computer' || word === 'pc') return 'desktop'
  if (word === 'panel' || word === 'native') return 'fit'
  return null
}

function clampSide(value: number): number {
  if (!Number.isFinite(value)) return PRESETS.desktop.width
  return Math.round(Math.min(MAX_SIDE, Math.max(MIN_SIDE, value)))
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
