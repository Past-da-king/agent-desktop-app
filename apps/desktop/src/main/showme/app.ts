/**
 * "Show me how" wired into the app (10 Nov 2026): the one place that knows Electron. main/index.ts calls startShowMe
 * once and keeps what it returns; everything else is in ./service.ts and ./walk.ts, free of Electron and tested.
 *
 * The ring is the shared guide overlay (main/overlay/): one transparent, click-through, capture-protected window per
 * display. No window is made here.
 */
import { clipboard, nativeTheme, screen } from 'electron'

import type { AiAccount, Settings } from '@agent/core'

import { brandLook } from '../../shared/brand'
import { SHOWME_CHANNELS, SHOWME_EVENTS } from '../../shared/showme'
import { keyFor } from '../accounts'
import { CapturePrivacy } from '../capture-privacy'
import { formatAccelerator } from '../hotkey'
import type { IpcMainLike } from '../ipc'
import { listModels } from '../models'
import { createGuideOverlay } from '../overlay/overlay-window'
import type { ProviderFactory } from '../runtime/brains'
import { displaysOf } from './coords'
import { GuideModels } from './guide-model'
import { walkOverlay } from './overlay-adapter'
import { appScreenReader } from './reader'
import type { ScreenReader } from './screen'
import { ShowMeService } from './service'
import { skillSources, type AppLike, type MemoryLike } from './skills'

export interface ShowMeAppDeps {
  ipcMain: IpcMainLike
  settings: { get(): Settings }
  secrets: { get(name: string): string | null }
  providerFactory: ProviderFactory
  hasCli: boolean
  /** The models a plan offers now, from its own engine. */
  planModels?: (accountId: string) => Promise<Array<{ id: string }>>
  /** One tool-free answer from a plan's engine, for an install with no key account. */
  planTurn?: (account: AiAccount, model: string, system: string, prompt: string, signal: AbortSignal) => Promise<string>
  memories(): Promise<MemoryLike[]>
  apps(): AppLike[]
  /** Holds a shortcut while a walk runs (HotkeyManager.hold). */
  holdKey(accelerator: string, callback: () => void): (() => void) | null
  /**
   * Hides the overlay windows from screen sharing by the setting. Absent: this makes its own, which hides the ring
   * unless a setting `hideGuidesFromCapture` exists and is off.
   */
  privacy?: CapturePrivacy | null
  broadcast(channel: string, payload: unknown): void
  /** Close the quick chat bar: the walk is on his window now. */
  hideBar(): void
  /** Bring the bar back: a walk ended before its first step and the bar says why. */
  showBar?: () => void
  tmpDir: string
  log(message: string, detail?: Record<string, unknown>): void
  /** Tests and a proof build hand in their own reader. */
  reader?: ScreenReader
}

export interface ShowMeApp {
  service: ShowMeService
  dispose(): void
}

export function startShowMe(deps: ShowMeAppDeps): ShowMeApp {
  const reader = deps.reader ?? appScreenReader({ log: deps.log })
  // The ring is for his eyes only: on a client call the screen share must not show it.
  const privacy =
    deps.privacy ??
    new CapturePrivacy(() => {
      const hide = (deps.settings.get() as unknown as Record<string, unknown>)['hideGuidesFromCapture']
      return { hideGuidesFromCapture: typeof hide === 'boolean' ? hide : true, hideChatFromCapture: false }
    })
  const overlay = createGuideOverlay({ privacy })
  const look = (): ReturnType<typeof brandLook> => {
    const settings = deps.settings.get()
    return brandLook({ theme: settings.theme, accent: settings.accent, systemDark: nativeTheme.shouldUseDarkColors })
  }
  const models = new GuideModels({
    settings: deps.settings,
    secrets: deps.secrets,
    providerFactory: deps.providerFactory,
    hasCli: deps.hasCli,
    listModels: async (account: AiAccount) => {
      if (account.kind !== 'api') return ((await deps.planModels?.(account.id)) ?? []).map((model) => model.id)
      const key = keyFor(deps.secrets, account.id)
      if (key === '') return []
      const base = (account.baseUrl ?? '').trim()
      return (await listModels({ provider: account.provider ?? 'anthropic', key, ...(base === '' ? {} : { baseUrl: base }) })).models.map((model) => model.id)
    },
    ...(deps.planTurn === undefined ? {} : { planTurn: deps.planTurn }),
    tmpDir: deps.tmpDir,
  })
  const pasteKey = process.platform === 'darwin' ? 'Cmd+V' : 'Ctrl+V'
  const service = new ShowMeService({
    reader,
    overlay: walkOverlay(overlay, () => displaysOf(screen), look, pasteKey),
    model: () => models.resolve(),
    sources: async () => skillSources(await deps.memories(), deps.apps()),
    clipboard: { read: () => clipboard.readText(), write: (text) => clipboard.writeText(text), clear: () => clipboard.clear() },
    holdKey: deps.holdKey,
    keys: () => ({ skip: deps.settings.get().showMeSkipHotkey, done: deps.settings.get().showMeDoneHotkey }),
    formatKey: (accelerator) => formatAccelerator(accelerator),
    onState: (state) => {
      deps.broadcast(SHOWME_EVENTS.state, state)
      // No route could be worked out: the bar comes back and says so, instead of nothing happening.
      if (state.phase === 'ended' && state.failed) deps.showBar?.()
    },
    log: deps.log,
  })

  deps.ipcMain.handle(SHOWME_CHANNELS.start, async (_event, raw) => {
    const question = typeof raw === 'string' ? raw.slice(0, 600) : ''
    const started = await service.ask(question)
    // The bar steps aside so the window he asked about is in front again, with the ring on it.
    if (started.ok) deps.hideBar()
    return started
  })
  deps.ipcMain.handle(SHOWME_CHANNELS.stop, () => {
    service.stop()
  })
  deps.ipcMain.handle(SHOWME_CHANNELS.state, () => service.state())

  return {
    service,
    dispose: () => {
      service.dispose()
      overlay.destroyAll()
      try {
        reader.dispose()
      } catch {
        // Already gone.
      }
    },
  }
}
