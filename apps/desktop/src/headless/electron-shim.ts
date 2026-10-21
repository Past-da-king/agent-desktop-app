/**
 * Stands in for 'electron' in the headless bundle (scripts/build-headless.mjs aliases it here). A few shared modules
 * import Electron at the top for code the headless node never runs (settings.ts -> hotkeys.ts -> hotkey.ts for the
 * Quick Ask window). Anything that really reaches for Electron fails loudly with a plain message instead of crashing
 * the load.
 */
function absent(name: string): never {
  throw new Error(`${name} is not available in the headless node (no screen).`)
}

const missing = (name: string): unknown =>
  new Proxy(function () {}, {
    get: (_target, prop) => (prop === 'then' ? undefined : absent(`electron.${name}.${String(prop)}`)),
    apply: () => absent(`electron.${name}()`),
    construct: () => absent(`new electron.${name}()`),
  })

export const app = missing('app')
export const BrowserWindow = missing('BrowserWindow')
export const WebContentsView = missing('WebContentsView')
export const nativeTheme = missing('nativeTheme')
export const nativeImage = missing('nativeImage')
export const screen = missing('screen')
export const session = missing('session')
export const shell = missing('shell')
export const webContents = missing('webContents')
export const safeStorage = missing('safeStorage')
export const Notification = missing('Notification')
export const Menu = missing('Menu')
export const Tray = missing('Tray')
export const ipcMain = missing('ipcMain')
export const clipboard = missing('clipboard')
export const dialog = missing('dialog')
export const globalShortcut = missing('globalShortcut')
export const powerMonitor = missing('powerMonitor')
export const systemPreferences = missing('systemPreferences')
export default {}
