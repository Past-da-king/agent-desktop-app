/**
 * show_media: put a file from this computer in the chat, where the person can play it.
 *
 * "I have to go outside the application just to see a video" (Ayanda, 3 Nov 2026). So an agent that has a local video,
 * picture or sound calls this instead of telling him a path: a card lands in the chat with a real player and, for a
 * picture, a click to enlarge. The file is shown by token only (media/shown.ts), never by its path.
 *
 * The card is the tool's own chat row (kind 'media'), so it appears even when the model then says nothing about it.
 */
import { isAbsolute } from 'node:path'

import { MAIN_CHAT, schema, str, type Tool } from '@agent/core'

import type { DataStore } from '../runtime/data'
import { cleanPath, shownUrl, type ShowResult, type ShownFile } from '../media/shown'

export interface MediaToolDeps {
  store: DataStore
  /** The list of files an agent has shown (media/shown.ts). */
  show: (path: string) => ShowResult
  /** This node's device id, when Devices is on, so the tool can tell that the person is on their phone. */
  selfId?: () => string
  /** The device the newest message in a chat came from, when Devices is on. */
  origin?: (chat: string) => Promise<{ deviceId: string; name: string } | null>
}

/** What the chat row carries. The renderer draws the card from this and nothing else. */
export function mediaMeta(file: ShownFile, caption: string, chat: string): string {
  return JSON.stringify({ kind: file.kind, src: shownUrl(file.token), token: file.token, name: file.name, caption, mime: file.mime, size: file.size, path: file.path, chat })
}

export function mediaTools(deps: MediaToolDeps): Tool[] {
  return [
    {
      spec: {
        name: 'show_media',
        description:
          'Show a video, picture or sound from this computer IN THE CHAT, where the person can play it: a card with a real player, and a picture he can click to enlarge. Use it whenever he would have to leave the app to open a file, and instead of telling him a path. The file stays where it is; nothing is copied or sent anywhere. On his phone the card cannot play yet: there, send_file puts it in his downloads.',
        schema: schema(['path'], {
          path: str('The full path of the file on this computer, as files_find or files_list shows it'),
          caption: str('One short line to show under it, optional'),
        }),
      },
      run: async (input, ctx) => {
        const raw = typeof input['path'] === 'string' ? input['path'] : ''
        const path = cleanPath(raw)
        if (path === '' || !isAbsolute(path)) return 'show_media needs the full path of a file on this computer, as files_list shows it.'
        const shown = deps.show(path)
        if (!shown.ok) return shown.why
        const caption = typeof input['caption'] === 'string' ? input['caption'].trim().slice(0, 200) : ''
        const chat = ctx.chat ?? MAIN_CHAT
        await deps.store.upsert('chat_item', {
          kind: 'media',
          text: caption === '' ? shown.file.name : caption,
          meta: mediaMeta(shown.file, caption, chat),
          ...(chat === MAIN_CHAT ? {} : { chat }),
          createdAt: Date.now(),
        })
        const away = await awayName(deps, chat)
        if (away !== null) {
          return `The card is in the chat, but the person is on their ${away} now: it plays when they are back on this computer. Send it to them there with send_file if they need it now. Say one line about it, never the path.`
        }
        return `The card is in the chat, playing ${shown.file.name}. Say one line about it and carry on; never paste the path or tell him to open it elsewhere. If you are drawing a card of your own, its address is ${shownUrl(shown.file.token)}.`
      },
    },
  ]
}

/**
 * The name of the other device the newest message came from (his phone), or null when he is here. A card in this
 * window is no use to someone looking at their phone, so the tool says so and points at send_file.
 */
async function awayName(deps: MediaToolDeps, chat: string): Promise<string | null> {
  if (deps.origin === undefined || deps.selfId === undefined) return null
  const origin = await deps.origin(chat)
  if (origin === null || origin.deviceId === deps.selfId()) return null
  return origin.name === '' ? 'phone' : origin.name
}
