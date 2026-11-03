/**
 * media.fetch: the bytes of a file an agent showed, for another of the person's devices (his phone).
 *
 * show_media (tools/media.ts) puts a card in the chat and serves the file to THIS window by token (media/serve.ts).
 * A phone cannot reach agent-media://, so it asks over the device link it already has: the chat names the row, the
 * token names the file, and the answer is one range of bytes. A video asks for the range it is about to play, so it
 * starts at once instead of waiting for a whole film over mobile data.
 *
 * The only files a device may ever read here are the ones an agent showed: ShownMedia.get is the allow-list, and a
 * token that is not in it (or whose file has gone) is an error, never a path. Nothing else is reachable: no folder, no
 * path, no listing. Every argument is checked before a byte is read, and a call never answers more than one chunk.
 *
 * Kept free of Electron, like serve.ts, so the whole answer can be tested with a real file.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'

import type { DevicesHost } from '../devices/types'
import type { MediaKind, ShownFile } from './shown'

/** The dotted method a device calls (devices/rpc.ts addRpc). */
export const MEDIA_FETCH = 'media.fetch'

/** The most one call answers. A player reads a film in pieces this size. */
export const MEDIA_MAX_CHUNK = 1024 * 1024

/** Said for a token that is not on the list: the same words whether it was never shown or the file has gone. */
export const NOT_SHOWN = 'That is not a file an agent has shown, or it has gone since. Ask for it again.'

export interface MediaFetchDeps {
  /** The files an agent showed (ShownMedia.get): the only thing this can read. */
  get(token: string): ShownFile | null
  log?: (message: string, detail?: Record<string, unknown>) => void
}

/** One range of a shown file, with enough about the file to draw and play it. */
export interface MediaChunk {
  /** The chat the row is in, as the caller named it: the answer says which ask it belongs to. */
  chat: string
  token: string
  name: string
  mime: string
  kind: MediaKind
  /** The whole file's size, so a player knows where the end is. */
  size: number
  offset: number
  length: number
  /** There are more bytes after this range. */
  more: boolean
  bytes: Uint8Array
}

function refuse(why: string): never {
  throw new Error(why)
}

/** The ask, checked: every field present and of the right kind, and nothing else read yet. */
function askOf(args: unknown[]): { chat: string; token: string; offset: number; length: number } {
  const first: unknown = args[0]
  const ask = typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : {}
  const chat = typeof ask['chat'] === 'string' ? ask['chat'].trim() : ''
  if (chat === '') refuse('media.fetch needs the chat the file was shown in.')
  const token = typeof ask['token'] === 'string' ? ask['token'].trim() : ''
  if (token === '') refuse('media.fetch needs a token: the one the chat row carries.')
  const rawOffset = ask['offset'] ?? 0
  const rawLength = ask['length'] ?? MEDIA_MAX_CHUNK
  if (typeof rawOffset !== 'number' || !Number.isFinite(rawOffset)) refuse('media.fetch needs a number for offset.')
  if (typeof rawLength !== 'number' || !Number.isFinite(rawLength)) refuse('media.fetch needs a number for length.')
  return { chat, token, offset: Math.trunc(rawOffset), length: Math.trunc(rawLength) }
}

/**
 * One chunk of a file an agent showed. Throws with words a person can read: the file is not shown, or the range is
 * not in it. A length of 0 or none means "the rest of the file, up to one chunk".
 */
export function readChunk(args: unknown[], deps: MediaFetchDeps): MediaChunk {
  const ask = askOf(args)
  const file = deps.get(ask.token)
  if (file === null) refuse(NOT_SHOWN)
  let size = 0
  try {
    const stat = statSync(file.path)
    if (!stat.isFile()) refuse(NOT_SHOWN)
    size = stat.size
  } catch {
    refuse(NOT_SHOWN)
  }
  if (ask.offset < 0 || ask.offset >= size) refuse('That range is not in the file.')
  const wanted = ask.length <= 0 ? MEDIA_MAX_CHUNK : ask.length
  const length = Math.min(wanted, MEDIA_MAX_CHUNK, size - ask.offset)
  if (length <= 0) refuse('That range is not in the file.')
  const bytes = new Uint8Array(length)
  const fd = openSync(file.path, 'r')
  try {
    let read = 0
    while (read < length) {
      const got = readSync(fd, bytes, read, length - read, ask.offset + read)
      if (got <= 0) break
      read += got
    }
    if (read < length) refuse('That file could not be read to the end.')
  } finally {
    closeSync(fd)
  }
  return {
    chat: ask.chat,
    token: file.token,
    name: file.name,
    mime: file.mime,
    kind: file.kind,
    size,
    offset: ask.offset,
    length,
    more: ask.offset + length < size,
    bytes,
  }
}

/**
 * Answer media.fetch for every paired device. It needs no role check beyond the pairing itself: a phone paired as a
 * screen must be able to play what the agent showed it, and the allow-list is what it may read.
 */
export function registerMediaFetch(host: DevicesHost, deps: MediaFetchDeps): void {
  host.addRpc(MEDIA_FETCH, async (deviceId, args) => {
    const chunk = readChunk(args, deps)
    deps.log?.('Media fetch', { for: deviceId, from: chunk.offset, length: chunk.length, size: chunk.size })
    return chunk
  })
}
