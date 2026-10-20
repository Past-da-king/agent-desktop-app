import { contextBridge, ipcRenderer } from 'electron'

import type { AgentApi, Unsubscribe } from '@agent/core'

const platform: AgentApi['platform'] =
  process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'

const reject = (): Promise<never> => Promise.reject(new Error('not implemented yet'))
const stop = (): Unsubscribe => () => undefined

const api: AgentApi = {
  platform,
  version: process.versions.electron ?? '0.0.0',

  settings: {
    get: reject,
    save: reject,
    providers: reject,
    setApiKey: reject,
    checkKey: reject,
    reset: reject,
    onChanged: stop,
  },

  account: {
    signIn: reject,
    signOut: reject,
    firstSync: reject,
    syncNow: reject,
    status: reject,
    onStatus: stop,
    onProgress: stop,
  },

  data: {
    list: reject,
    upsert: reject,
    remove: reject,
    onChanged: stop,
  },

  chat: {
    send: reject,
    stop: reject,
    state: reject,
    answer: reject,
    decide: reject,
    onEvent: stop,
  },

  routines: {
    runNow: reject,
  },

  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized') as Promise<boolean>,
    onMaximizeChange: (cb: (maximized: boolean) => void): Unsubscribe => {
      const listener = (_event: unknown, maximized: boolean): void => cb(maximized)
      ipcRenderer.on('window:maximize-changed', listener)
      return () => {
        ipcRenderer.removeListener('window:maximize-changed', listener)
      }
    },
    onQuickAsk: stop,
  },

  files: {
    pick: reject,
    pathsFor: () => [],
    pickFolder: reject,
  },

  shell: {
    openExternal: reject,
    reveal: reject,
  },
}

contextBridge.exposeInMainWorld('agent', api)
