/**
 * Files for learned apps: a tool input can name a file on this computer, and the page gets a real File
 * (name, mime type, bytes). The app reads the file itself and moves it into the page in chunks, so a
 * 150 MB video never passes through the model as base64 and never sits in one giant script message.
 *
 * How an input names a file (both work for any tool):
 * - an input declared with type "file" (webapp_save params), given as a path: {"video": "C:/clips/ep1.mp4"};
 * - any input given as {"$file": "C:/clips/ep1.mp4", "name"?: "ep1.mp4", "type"?: "video/mp4"}.
 * Inside the tool body that input is a File (a Blob with .name and .type): await args.video.arrayBuffer(),
 * new FormData().append('f', args.video), or hand it to the site's own upload code.
 *
 * In the page the chunks wait in window.__agentFiles[key] as Blobs (Chromium can keep big blobs out of the
 * page's heap) and are dropped as soon as the tool has run.
 */
import { randomBytes } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'

import type { JsonObject, JsonValue } from '@agent/core'

/** The key an input object uses to name a file: {"$file": "C:/path/file.mp4"}. */
export const FILE_KEY = '$file'
/** The type a learned tool declares for an input that is a file on this computer. */
export const FILE_TYPE = 'file'
/** Bytes per chunk sent into the page: about 2.7 MB of script text each. */
export const FILE_CHUNK_BYTES = 2 * 1024 * 1024
/** The largest file a tool can be handed (WhatsApp's own limit is 2 GB; a page holds this comfortably). */
export const MAX_FILE_BYTES = 1024 * 1024 * 1024

/** One file a tool call carries: where it is on disk and what the page will see. */
export interface FileArg {
  key: string
  path: string
  name: string
  type: string
  size: number
}

export type PreparedArgs = { ok: true; args: JsonObject; files: FileArg[] } | { ok: false; error: string }

const MIMES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export function mimeOf(path: string): string {
  return MIMES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function declaredFile(params: JsonObject, name: string): boolean {
  const spec = params[name]
  return isObject(spec) && spec['type'] === FILE_TYPE
}

/** "150.3 MB" */
export function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * Finds the files a call names and swaps each for a placeholder the page turns back into a File. Checks
 * each one is a real file of a size a page can take. Nothing is read yet.
 */
export async function prepareFileArgs(params: JsonObject, input: JsonObject): Promise<PreparedArgs> {
  const files: FileArg[] = []
  const swap = async (value: JsonValue, declared: boolean): Promise<{ value: JsonValue } | { error: string }> => {
    let path = ''
    let name = ''
    let type = ''
    if (declared && typeof value === 'string') path = value
    else if (isObject(value) && typeof value[FILE_KEY] === 'string') {
      path = value[FILE_KEY]
      name = typeof value['name'] === 'string' ? value['name'] : ''
      type = typeof value['type'] === 'string' ? value['type'] : ''
    } else return { value }
    path = path.trim()
    if (path === '' || !isAbsolute(path)) return { error: `Give the file as a full path on this computer (got "${path}").` }
    let size = 0
    try {
      const info = await stat(path)
      if (!info.isFile()) return { error: `${path} is not a file.` }
      size = info.size
    } catch {
      return { error: `No such file: ${path}` }
    }
    if (size > MAX_FILE_BYTES) return { error: `${basename(path)} is ${sizeText(size)}; a learned app can be handed at most ${sizeText(MAX_FILE_BYTES)}.` }
    const key = `f${randomBytes(6).toString('hex')}`
    const fileName = name.trim() === '' ? basename(path) : name.trim()
    files.push({ key, path, name: fileName, type: type.trim() === '' ? mimeOf(fileName) : type.trim(), size })
    return { value: { __agentFile: key } }
  }
  const args: JsonObject = {}
  for (const [key, value] of Object.entries(input)) {
    const declared = declaredFile(params, key)
    const items = Array.isArray(value) ? value : [value]
    const out: JsonValue[] = []
    for (const item of items) {
      const swapped = await swap(item, declared)
      if ('error' in swapped) return { ok: false, error: swapped.error }
      out.push(swapped.value)
    }
    args[key] = Array.isArray(value) ? out : (out[0] ?? null)
  }
  return { ok: true, args, files }
}

/** Opens a slot for one file in the page. */
export function fileOpenScript(file: FileArg): string {
  return `(function(){var F=window.__agentFiles||(window.__agentFiles={});F[${JSON.stringify(file.key)}]={name:${JSON.stringify(file.name)},type:${JSON.stringify(file.type)},size:${file.size},parts:[],got:0};return 0})()`
}

/** Adds one chunk (base64) to a file's slot; answers how many bytes the page holds so far. */
export function fileChunkScript(key: string, base64: string): string {
  return (
    `(function(){var f=(window.__agentFiles||{})[${JSON.stringify(key)}];if(!f)throw new Error('The page reloaded while a file was being sent in.');` +
    `var b=${JSON.stringify(base64)};var u;if(typeof Uint8Array.fromBase64==='function'){u=Uint8Array.fromBase64(b)}else{var s=atob(b);u=new Uint8Array(s.length);for(var i=0;i<s.length;i++)u[i]=s.charCodeAt(i)}` +
    `f.parts.push(new Blob([u]));f.got+=u.length;return f.got})()`
  )
}

/** Drops files from the page (after the run, or when sending one in failed). */
export function fileDropScript(keys: string[]): string {
  return `(function(){var F=window.__agentFiles||{};${JSON.stringify(keys)}.forEach(function(k){delete F[k]});return 0})()`
}

/**
 * The page-side prelude that turns each {__agentFile:key} placeholder in args back into a File. Used by
 * runScript when a call carries files.
 */
export const FILE_REVIVE =
  "function(x){var F=window.__agentFiles||{};function rv(v){if(v&&typeof v==='object'){if(typeof v.__agentFile==='string'){var f=F[v.__agentFile];" +
  "if(!f)throw new Error('A file did not reach the page (it reloaded?). Run the tool again.');if(f.got!==f.size)throw new Error('Only part of '+f.name+' reached the page.');" +
  "return new File(f.parts,f.name,{type:f.type})}if(Array.isArray(v))return v.map(rv);var o={};for(var k in v)o[k]=rv(v[k]);return o}return v}return rv(x)}"

export type Evaluate = (code: string, timeoutMs?: number) => Promise<unknown>

/**
 * Sends each file into the page, chunk by chunk, from disk. Throws (after dropping what was sent) when
 * the page stops answering or reloads.
 */
export async function sendFilesToPage(files: FileArg[], evaluate: Evaluate, chunkBytes = FILE_CHUNK_BYTES): Promise<void> {
  try {
    for (const file of files) {
      await evaluate(fileOpenScript(file))
      const handle = await open(file.path, 'r')
      try {
        const buffer = Buffer.alloc(Math.max(1, Math.min(chunkBytes, file.size)))
        let offset = 0
        while (offset < file.size) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, file.size - offset), offset)
          if (bytesRead === 0) break
          offset += bytesRead
          const got = await evaluate(fileChunkScript(file.key, buffer.subarray(0, bytesRead).toString('base64')), 60_000)
          if (got !== offset) throw new Error(`the page holds ${String(got)} of ${offset} bytes of ${file.name}`)
        }
        if (offset !== file.size) throw new Error(`${file.name} changed size while it was read`)
      } finally {
        await handle.close()
      }
    }
  } catch (cause) {
    await evaluate(fileDropScript(files.map((f) => f.key))).catch(() => undefined)
    throw new Error(`Could not send the file into the page: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/** How long a run carrying files may take: the usual 30 s, plus a second per MB (uploads), at most 15 minutes. */
export function runTimeoutFor(files: FileArg[]): number {
  const bytes = files.reduce((sum, f) => sum + f.size, 0)
  return Math.min(15 * 60_000, 30_000 + Math.ceil(bytes / (1024 * 1024)) * 1_000)
}
