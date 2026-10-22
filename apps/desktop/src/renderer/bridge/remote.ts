/**
 * The remote bridge: `AgentApi` over the node's /v1/rpc WebSocket (docs/devices-protocol.md s5.1), for the node's
 * web UI at /app/ on another device (a phone WebView, a browser). The pass rides in the agent_pass cookie the page
 * was opened with, so this file never sees it. Calls made while the line is down wait for it; after a reconnect
 * every list is read again. What only makes sense on the computer itself (window controls, shortcuts, dictation
 * anywhere, file pickers, keys) does nothing here, or answers that it is not available.
 */
import {
  DEFAULT_SETTINGS,
  type AgentApi,
  type Attachment,
  type DataChange,
  type DeviceFactsInfo as DeviceFacts,
  type EntityName,
  type Settings,
  type Unsubscribe,
} from '@agent/core'

import { EVENTS } from '../../shared/channels'
import { DEVICES_EVENTS } from '../../shared/devices-channels'
import { MEMORY_EVENTS } from '../../shared/memory-channels'
import { decodeWire, encodeWire } from '../../shared/rpc-methods'

const CALL_TIMEOUT_MS = 60_000
const ENTITIES: EntityName[] = ['chat_item', 'turn', 'memory', 'goal', 'task', 'trigger', 'project', 'device']
/** Settings this device keeps for itself: how the app looks here. Everything else is the computer's. */
const LOOK_KEYS = ['theme', 'accent', 'mascot'] as const
const LOOK_STORE = 'agent-remote-look'
const MAX_UPLOAD = 20 * 1024 * 1024

type Listener = (payload: unknown) => void

interface Pending {
  method: string
  args: unknown[]
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: number
  sent: boolean
}

/** What this device says about itself. A native shell (the phone app) can supply its own through window.agentDevice. */
export function deviceFacts(): DeviceFacts {
  const shell = (window as unknown as { agentDevice?: { facts?: () => unknown } }).agentDevice
  if (shell?.facts !== undefined) {
    try {
      const raw = shell.facts()
      const value = (typeof raw === 'string' ? JSON.parse(raw) : raw) as DeviceFacts
      if (typeof value === 'object' && value !== null && typeof value.kind === 'string') return value
    } catch {
      // Fall back to what the page can see.
    }
  }
  const ua = navigator.userAgent
  const platform: DeviceFacts['platform'] = /Android/i.test(ua)
    ? 'android'
    : /iPhone|iPad|iPod/i.test(ua)
      ? 'ios'
      : /Windows/i.test(ua)
        ? 'windows'
        : /Mac OS X|Macintosh/i.test(ua)
          ? 'macos'
          : 'linux'
  const touch = navigator.maxTouchPoints > 0
  const short = Math.min(window.screen.width, window.screen.height)
  const kind: DeviceFacts['kind'] = touch && short < 600 ? 'phone' : touch && short < 1100 ? 'tablet' : 'desktop'
  const name = kind === 'phone' ? 'Phone browser' : kind === 'tablet' ? 'Tablet browser' : 'Browser'
  return {
    name,
    kind,
    platform,
    appVersion: '',
    screen: { width: window.innerWidth, height: window.innerHeight },
    canOpenLinks: true,
    canReceiveFiles: true,
    fingerprint: '',
    urls: [],
  }
}

class Wire {
  private socket: WebSocket | null = null
  private open = false
  private next = 1
  private readonly pending = new Map<string, Pending>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private retry = 1000
  private everOpened = false
  private helloTimer = 0

  constructor(private readonly url: string) {
    this.connect()
    window.addEventListener('resize', () => {
      window.clearTimeout(this.helloTimer)
      this.helloTimer = window.setTimeout(() => this.hello(), 400)
    })
    window.addEventListener('online', () => {
      if (!this.open) this.connect()
    })
  }

  call(method: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = String(this.next++)
      const timer = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Your computer did not answer in time.'))
      }, CALL_TIMEOUT_MS)
      const item: Pending = { method, args, resolve, reject, timer, sent: false }
      this.pending.set(id, item)
      if (this.open) this.send(id, item)
    })
  }

  on(name: string, listener: Listener): Unsubscribe {
    let set = this.listeners.get(name)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(name, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
    }
  }

  emitLocal(name: string, payload: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener(payload)
  }

  private send(id: string, item: Pending): void {
    item.sent = true
    this.socket?.send(JSON.stringify({ type: 'call', id, method: item.method, args: encodeWire(item.args) }))
  }

  private hello(): void {
    if (this.open) this.socket?.send(JSON.stringify({ type: 'hello', device: deviceFacts() }))
  }

  private connect(): void {
    if (this.socket !== null && this.socket.readyState <= WebSocket.OPEN) return
    const socket = new WebSocket(this.url)
    this.socket = socket
    socket.onopen = () => {
      this.open = true
      this.retry = 1000
      this.hello()
      for (const [id, item] of this.pending) if (!item.sent) this.send(id, item)
      if (this.everOpened) {
        // Anything could have changed while the line was down: every list reads itself again.
        for (const entity of ENTITIES) this.emitLocal(EVENTS.data, { entity, reset: true } satisfies DataChange)
        this.emitLocal(EVENTS.chat, { type: 'chat_changed' })
        this.emitLocal(DEVICES_EVENTS.changed, null)
      }
      this.everOpened = true
      this.emitLocal('remote.connection', true)
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(event.data) as Record<string, unknown>
      } catch {
        return
      }
      if (frame['type'] === 'result') {
        const id = String(frame['id'])
        const item = this.pending.get(id)
        if (item === undefined) return
        this.pending.delete(id)
        window.clearTimeout(item.timer)
        if (frame['ok'] === true) item.resolve(decodeWire(frame['value']))
        else item.reject(new Error(typeof frame['error'] === 'string' ? frame['error'] : 'That did not work.'))
      } else if (frame['type'] === 'event' && typeof frame['name'] === 'string') {
        this.emitLocal(frame['name'], decodeWire(frame['payload']))
      }
    }
    socket.onclose = (event) => {
      this.open = false
      this.socket = null
      this.emitLocal('remote.connection', false)
      // Calls already on the wire may never get an answer: they fail now; queued ones wait for the next line.
      for (const [id, item] of this.pending) {
        if (!item.sent) continue
        this.pending.delete(id)
        window.clearTimeout(item.timer)
        item.reject(new Error('Lost the connection to your computer.'))
      }
      // 4003: this device was taken out. Reloading shows the node's "not linked" page instead of retrying.
      if (event.code === 4003) {
        window.location.reload()
        return
      }
      const wait = this.retry
      this.retry = Math.min(this.retry * 2, 10_000)
      window.setTimeout(() => this.connect(), wait)
    }
  }
}

function readLook(): Partial<Settings> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(LOOK_STORE) ?? '{}') as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of LOOK_KEYS) if (typeof raw[key] === 'string') out[key] = raw[key]
    return out as Partial<Settings>
  } catch {
    return {}
  }
}

function notHere(what = 'That'): Promise<never> {
  return Promise.reject(new Error(`${what} works on the computer itself.`))
}

const noop = (): Unsubscribe => () => undefined

function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.style.display = 'none'
    input.onchange = () => {
      resolve(Array.from(input.files ?? []))
      input.remove()
    }
    document.body.appendChild(input)
    input.click()
  })
}

export async function createRemoteAgent(): Promise<AgentApi> {
  let nodeName = 'your computer'
  try {
    const health = (await (await fetch('/v1/health', { cache: 'no-store' })).json()) as { name?: unknown }
    if (typeof health.name === 'string' && health.name !== '') nodeName = health.name
  } catch {
    // The name is a nicety; the wire reconnects on its own.
  }
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wire = new Wire(`${scheme}//${window.location.host}/v1/rpc`)
  const rpc =
    <T>(method: string) =>
    (...args: unknown[]): Promise<T> =>
      wire.call(method, args) as Promise<T>
  const on =
    <T>(name: string) =>
    (callback: (payload: T) => void): Unsubscribe =>
      wire.on(name, (payload) => callback(payload as T))

  let look = readLook()
  const withLook = (settings: Settings): Settings => ({ ...settings, ...look })
  let lastSettings: Settings = { ...DEFAULT_SETTINGS }

  const saveSettings = async (patch: Partial<Settings>): Promise<Settings> => {
    const keys = Object.keys(patch)
    const local = keys.every((key) => (LOOK_KEYS as readonly string[]).includes(key))
    if (!local) return notHere('Changing that setting')
    look = { ...look, ...patch }
    window.localStorage.setItem(LOOK_STORE, JSON.stringify(look))
    const next = withLook(lastSettings)
    wire.emitLocal(EVENTS.settings, lastSettings)
    return next
  }

  const uploads = async (files: File[]): Promise<Attachment[]> => {
    const out: Attachment[] = []
    for (const file of files) {
      if (file.size > MAX_UPLOAD) continue
      const bytes = new Uint8Array(await file.arrayBuffer())
      out.push((await wire.call('files.savePasted', [file.name || 'file', file.type || 'application/octet-stream', bytes])) as Attachment)
    }
    return out
  }

  const api: AgentApi = {
    platform: 'web',
    version: '0.0.0',
    remote: { nodeName },

    settings: {
      get: async () => {
        lastSettings = (await wire.call('settings.get', [])) as Settings
        return withLook(lastSettings)
      },
      save: saveSettings,
      providers: rpc('settings.providers'),
      setApiKey: () => notHere('Adding a key'),
      checkKey: () => notHere('Checking a key'),
      listModels: async () => ({ ok: false, models: [], message: 'Choose models on the computer itself.' }),
      checkCli: () => notHere('Checking the plan'),
      cliLogin: () => notHere('Signing in to a plan'),
      reset: () => notHere('Resetting'),
      accounts: {
        add: () => notHere('Adding an account'),
        update: () => notHere('Changing an account'),
        remove: () => notHere('Taking out an account'),
        setKey: () => notHere('Adding a key'),
        check: () => notHere('Checking an account'),
        listModels: async () => ({ ok: false, models: [], message: 'Choose models on the computer itself.' }),
        signIn: () => notHere('Signing in'),
        chatBrain: rpc('settings.accounts.chatBrain'),
      },
      onChanged: (callback) =>
        wire.on(EVENTS.settings, (payload) => {
          lastSettings = payload as Settings
          callback(withLook(lastSettings))
        }),
    },

    account: {
      signIn: async () => ({ ok: false, error: 'Sign in on the computer itself.' }),
      signOut: () => notHere('Signing out'),
      firstSync: rpc('account.status'),
      syncNow: rpc('account.syncNow'),
      status: rpc('account.status'),
      onStatus: on(EVENTS.accountStatus),
      onProgress: on(EVENTS.accountProgress),
    },

    data: {
      list: (entity) => wire.call('data.list', [entity]) as never,
      get: (entity, id) => wire.call('data.get', [entity, id]) as never,
      upsert: (entity, row) => wire.call('data.upsert', [entity, row]) as never,
      remove: rpc('data.remove'),
      onChanged: on(EVENTS.data),
    },

    chat: {
      send: (text, attachments, chat) => wire.call('chat.send', [text, attachments ?? [], chat ?? '']) as Promise<void>,
      stop: (chat) => wire.call('chat.stop', [chat ?? '']) as Promise<void>,
      state: (chat) => wire.call('chat.state', [chat ?? '']) as never,
      states: rpc('chat.states'),
      branch: rpc('chat.branch'),
      answer: rpc('chat.answer'),
      decide: rpc('chat.decide'),
      tap: rpc('chat.tap'),
      onEvent: on(EVENTS.chat),
    },

    routines: { runNow: rpc('routines.runNow') },

    browser: {
      setBounds: async () => undefined,
      state: rpc('browser.state'),
      back: async () => undefined,
      reload: async () => undefined,
      selectTab: async () => undefined,
      closeTab: async () => undefined,
      takeOver: () => notHere('Taking over the browser'),
      giveBack: async () => undefined,
      openInSystem: async () => undefined,
      setView: async () => undefined,
      setExpanded: async () => undefined,
      frame: async () => null,
      go: () => notHere('Browsing'),
      newTab: () => notHere('Browsing'),
      devtools: async () => undefined,
      setMuted: async () => undefined,
      people: rpc('browser.people'),
      usePerson: async () => undefined,
      signOut: () => notHere('Signing out of a site'),
      onState: on(EVENTS.browser),
      attach: async () => false,
    },

    helpers: { stop: rpc('helpers.stop'), stopAll: rpc('helpers.stopAll'), cards: rpc('helpers.cards'), onCards: on(EVENTS.helperCards) },

    apps: {
      status: rpc('apps.status'),
      setKey: async () => ({ ok: false, message: 'Add the key on the computer itself.' }),
      catalog: rpc('apps.catalog'),
      search: rpc('apps.search'),
      connect: async () => ({ ok: false, message: 'Connect apps on the computer itself.' }),
      disconnect: () => notHere('Disconnecting an app'),
      setRules: () => notHere('Changing what the agent may do'),
      learned: rpc('apps.learned'),
      removeLearned: () => notHere('Removing a learned app'),
      setTrusted: () => notHere('Trusting a learned app'),
      onChanged: (callback) => wire.on(EVENTS.apps, () => callback()),
    },

    profiles: {
      list: rpc('profiles.list'),
      create: async () => ({ ok: false, message: 'Make profiles on the computer itself.' }),
      update: async () => ({ ok: false, message: 'Change profiles on the computer itself.' }),
      remove: () => notHere('Removing a profile'),
      setMember: () => notHere('Changing a profile'),
      onChanged: (callback) => wire.on(EVENTS.profiles, () => callback()),
    },

    window: {
      minimize: () => undefined,
      toggleMaximize: () => undefined,
      close: () => undefined,
      isMaximized: async () => false,
      onMaximizeChange: noop,
      onQuickAsk: noop,
      onRoute: noop,
      onHotkeyStatus: noop,
    },

    files: {
      pick: async () => uploads(await pickFiles()),
      pathsFor: () => [],
      pickFolder: async () => null,
      // Images in cards and chips load from the node, with this device's cookie.
      thumbnail: async (path) => `/v1/file?path=${encodeURIComponent(path)}`,
      savePasted: rpc('files.savePasted'),
      clipboardFiles: async () => [],
    },

    system: { info: rpc('system.info') },
    environment: { scan: (refresh) => wire.call('environment.scan', [refresh === true]) as never },

    shell: {
      openExternal: async (url) => {
        window.open(url, '_blank', 'noopener,noreferrer')
      },
      reveal: async () => undefined,
    },

    voice: {
      setKey: () => notHere('Adding a voice key'),
      check: rpc('voice.check'),
      transcribe: rpc('voice.transcribe'),
      speak: rpc('voice.speak'),
      noteAudio: rpc('voice.noteAudio'),
      liveToken: rpc('voice.liveToken'),
      callSave: rpc('voice.callSave'),
      callTargets: rpc('voice.callTargets'),
      callHandoff: rpc('voice.callHandoff'),
      callStart: async () => ({ ok: false, message: 'Live calls work on the computer itself for now.' }),
      callAudio: () => undefined,
      callMute: async () => undefined,
      callEnd: async () => null,
      onCall: noop,
    },

    hotkeys: { status: async () => [], pause: async () => undefined },

    dictation: {
      audio: () => undefined,
      micState: async () => undefined,
      stop: async () => undefined,
      ready: async () => undefined,
      onCommand: noop,
      onView: noop,
      // The message box records here and transcribes in one call (DictateButton's own path).
      toggle: async () => {
        throw new Error('Dictation into this window only works on the computer itself.')
      },
      cancel: async () => undefined,
      retry: async () => undefined,
      onDraft: noop,
    },

    memory: {
      newChat: (target) => wire.call('memory.newChat', [target ?? null]) as never,
      retrySave: rpc('memory.retrySave'),
      pickImport: async () => null,
      previewImport: () => notHere('Importing memory'),
      runImport: () => notHere('Importing memory'),
      previewTidy: () => notHere('Importing memory'),
      startTidy: () => notHere('Importing memory'),
      stopTidy: () => notHere('Importing memory'),
      tidyState: rpc('memory.tidyState'),
      undoTidy: () => notHere('Undoing an import'),
      onTidy: on(MEMORY_EVENTS.tidy),
      searchChats: rpc('memory.searchChats'),
      runDaily: () => notHere('Running the end of day now'),
      upkeep: rpc('memory.upkeep'),
      undoChange: rpc('memory.undoChange'),
      history: rpc('memory.history'),
      restoreVersion: rpc('memory.restoreVersion'),
      onUpkeep: on(MEMORY_EVENTS.upkeep),
    },

    app: {
      info: rpc('app.info'),
      openLogsFolder: async () => undefined,
      openLicences: async () => undefined,
    },

    devices: {
      status: rpc('devices.status'),
      setEnabled: () => notHere('Changing devices'),
      setExtraUrls: () => notHere('Changing devices'),
      setNetwork: () => notHere('Changing devices'),
      offer: () => notHere('Adding a device'),
      cancelOffer: async () => undefined,
      list: rpc('devices.list'),
      setRoles: () => notHere('Changing devices'),
      move: () => notHere('Changing devices'),
      revoke: () => notHere('Taking out a device'),
      setShareGroup: () => notHere('Changing devices'),
      allowFirewall: () => notHere('Changing devices'),
      onChanged: (callback) => wire.on(DEVICES_EVENTS.changed, () => callback()),
    },
    // Workers run on the computer that has them; they are managed there, not from another device.
    workers: {
      list: async () => [],
      events: async () => [],
      logs: async () => [],
      start: () => notHere('Starting a worker'),
      stop: () => notHere('Stopping a worker'),
      restart: () => notHere('Restarting a worker'),
      remove: () => notHere('Removing a worker'),
      setSecret: () => notHere('Adding a worker key'),
      openFolder: () => notHere('Opening a folder'),
      onChange: noop,
    },
  }
  return api
}
