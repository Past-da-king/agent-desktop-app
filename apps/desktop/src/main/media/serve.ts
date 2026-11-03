/**
 * Where a shown file is streamed from: agent-media://f/<token> (media/shown.ts holds the list).
 *
 * Nothing here knows about paths. It is handed a token, asks the list what that token is, and answers with the file's
 * bytes, its type, and Range support so a video can be dragged to any point and played from there without loading the
 * whole thing first. Anything else (a wrong token, a file that has gone, a method that is not a read) is a 404, a 416
 * or a 405 with no bytes at all.
 *
 * Kept free of Electron on purpose: the whole answer can be tested with a real file and a real Request.
 */
import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'

import { tokenOf, type ShownFile } from './shown'

/** What a token means: the file, or nothing. */
export type MediaLookup = (token: string) => ShownFile | null

export type ByteRange = { kind: 'none' } | { kind: 'ok'; start: number; end: number } | { kind: 'bad' }

/**
 * One Range header against a file of `size` bytes, as RFC 7233 has it: "bytes=0-99", "bytes=100-" (to the end) and
 * "bytes=-100" (the last 100). Anything else, and a start past the end, is bad (416).
 */
export function parseRange(header: string | null, size: number): ByteRange {
  if (header === null || header.trim() === '') return { kind: 'none' }
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (m === null) return { kind: 'bad' }
  const from = m[1] ?? ''
  const to = m[2] ?? ''
  if (from === '' && to === '') return { kind: 'bad' }
  if (from === '') {
    const wanted = Number(to)
    if (!Number.isFinite(wanted) || wanted <= 0) return { kind: 'bad' }
    if (size === 0) return { kind: 'bad' }
    return { kind: 'ok', start: Math.max(0, size - wanted), end: size - 1 }
  }
  const start = Number(from)
  if (!Number.isFinite(start) || start >= size) return { kind: 'bad' }
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1)
  if (!Number.isFinite(end) || end < start) return { kind: 'bad' }
  return { kind: 'ok', start, end }
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
}

/** A file name for the Content-Disposition header: no quotes, no newlines, nothing that breaks the header. */
function safeName(name: string): string {
  return name.replace(/["\\\r\n]/g, '_').slice(0, 120)
}

/** The answer to one request for a shown file. */
export async function serveShown(request: Request, lookup: MediaLookup): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Only a read is allowed', { status: 405, headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' } })
  }
  const token = tokenOf(request.url)
  if (token === null) return notFound()
  const file = lookup(token)
  if (file === null) return notFound()
  let size = 0
  try {
    const stat = statSync(file.path)
    if (!stat.isFile()) return notFound()
    size = stat.size
  } catch {
    return notFound()
  }
  const common = {
    'content-type': file.mime,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-disposition': `inline; filename="${safeName(file.name)}"`,
  }
  const range = parseRange(request.headers.get('range'), size)
  if (range.kind === 'bad') {
    return new Response(null, { status: 416, headers: { ...common, 'content-range': `bytes */${size}` } })
  }
  if (range.kind === 'ok') {
    const length = range.end - range.start + 1
    const headers = { ...common, 'content-range': `bytes ${range.start}-${range.end}/${size}`, 'content-length': String(length) }
    if (request.method === 'HEAD') return new Response(null, { status: 206, headers })
    const stream = createReadStream(file.path, { start: range.start, end: range.end })
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: 206, headers })
  }
  const headers = { ...common, 'content-length': String(size) }
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  const stream = createReadStream(file.path)
  return new Response(Readable.toWeb(stream) as ReadableStream, { status: 200, headers })
}
