/**
 * The preload of a mini-app's offscreen look check (main/miniapps/check.ts): the one door of the check window, the
 * same message format the window's MessagePort carries (shared/miniapp-kit.ts agent.js uses window.__miniappHost).
 */
import { contextBridge, ipcRenderer } from 'electron'

const CHANNELS = { hello: 'agent:miniapp-check.hello', post: 'agent:miniapp-check.post', push: 'agent:miniapp-check.push' }

if (ipcRenderer.sendSync(CHANNELS.hello) === true) {
  contextBridge.exposeInMainWorld('__miniappHost', {
    post: (text: string) => ipcRenderer.send(CHANNELS.post, String(text)),
    onMessage: (callback: (text: string) => void) => {
      ipcRenderer.on(CHANNELS.push, (_event, text: string) => callback(text))
    },
  })
}
