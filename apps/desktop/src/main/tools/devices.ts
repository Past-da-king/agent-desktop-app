/**
 * Tools that act on the device the person is using (docs/devices-protocol.md s8): open_url and send_file.
 *
 * The device is the origin of the newest message in the chat (meta.origin). When that is this computer (or the row
 * has no origin, as every message from before Devices), they act here as before: open_url opens the person's own
 * browser, and a file is already here. When it is another device (a phone in Remote mode), they go to it as a
 * device command and wait a little for it to confirm.
 */
import { existsSync, statSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'

import { MAIN_CHAT, schema, str, type Tool } from '@agent/core'

import type { DataStore } from '../runtime/data'
import { fileUrl, type DeviceCommands } from '../devices/commands'
import { latestOrigin } from '../devices/origin'

export interface DeviceToolDeps {
  store: DataStore
  /** This node's device id ('' when Devices is off: every message is then from here). */
  selfId: () => string
  /** The command sender, once the node server is running; null when Devices is off. */
  commands: () => DeviceCommands | null
  /** Opens a link in the person's own browser on this computer. */
  openLocal: (url: string) => void
}

export function deviceTools(deps: DeviceToolDeps): Tool[] {
  return [openUrlTool(deps), sendFileTool(deps)]
}

function openUrlTool(deps: DeviceToolDeps): Tool {
  return {
    spec: {
      name: 'open_url',
      description:
        "Open a web address for the user on the device they are using right now (their phone when they wrote from it, else this computer's own browser). For showing them a page, a sign-in or a map; not for reading a page yourself.",
      schema: schema(['url'], { url: str('The https:// address') }),
    },
    run: async (input, ctx) => {
      const url = typeof input['url'] === 'string' ? input['url'].trim() : ''
      if (!/^https?:\/\/[^\s]+$/i.test(url)) return 'open_url needs a full http:// or https:// address.'
      const chat = ctx.chat ?? MAIN_CHAT
      const origin = await latestOrigin(deps.store, chat)
      const commands = deps.commands()
      if (origin === null || origin.deviceId === deps.selfId() || commands === null) {
        deps.openLocal(url)
        return `Opened ${url} in the user's browser on this computer.`
      }
      if (!origin.canOpenLinks) return `The user's ${origin.name} cannot open links. Give them the link in your reply instead.`
      const outcome = await commands.send(origin.deviceId, { kind: 'open_url', url }, chat, `The user's ${origin.name}`, ctx.owner ?? '')
      if (outcome.status === 'done') return `Opened ${url} on the user's ${origin.name}.`
      if (outcome.status === 'failed') return `The user's ${origin.name} could not open it${outcome.note === '' ? '' : `: ${outcome.note}`}. Give them the link in your reply.`
      return outcome.note
    },
  }
}

function sendFileTool(deps: DeviceToolDeps): Tool {
  return {
    spec: {
      name: 'send_file',
      description:
        'Send a file on this computer to the device the user is using right now (their phone when they wrote from it). It lands in their downloads. When they are on this computer, the file is already here: give them its path.',
      schema: schema(['path'], { path: str('Full path of the file on this computer'), name: str('File name to show, optional') }),
    },
    run: async (input, ctx) => {
      const path = typeof input['path'] === 'string' ? input['path'].trim() : ''
      if (path === '' || !isAbsolute(path)) return 'send_file needs the full path of a file on this computer.'
      if (!existsSync(path) || !statSync(path).isFile()) return `There is no file at ${path}.`
      const name = (typeof input['name'] === 'string' && input['name'].trim() !== '' ? input['name'].trim() : basename(path)).slice(0, 200)
      const chat = ctx.chat ?? MAIN_CHAT
      const origin = await latestOrigin(deps.store, chat)
      const commands = deps.commands()
      if (origin === null || origin.deviceId === deps.selfId() || commands === null) {
        return `The user is on this computer, so the file is already here: ${path}`
      }
      if (!origin.canReceiveFiles) return `The user's ${origin.name} cannot take files. Tell them where it is instead: ${path}`
      const outcome = await commands.send(origin.deviceId, { kind: 'send_file', url: fileUrl(path), path, name }, chat, `The user's ${origin.name}`, ctx.owner ?? '')
      if (outcome.status === 'done') return `Sent ${name} to the user's ${origin.name}.`
      if (outcome.status === 'failed') return `The user's ${origin.name} could not take ${name}${outcome.note === '' ? '' : `: ${outcome.note}`}.`
      return outcome.note
    },
  }
}
