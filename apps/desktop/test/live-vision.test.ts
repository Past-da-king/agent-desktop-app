/**
 * LIVE, opt-in (LIVE_VISION=1 OPENCODE_GO_API_KEY=...): a picture really reaches a model on OpenCode Go.
 *
 * OpenCode Go routes every request by the x-opencode-session header, and one of the engines behind it has no
 * image input: the same picture is refused on some sessions and answered on others ("image input is not
 * available on this engine"). This test is the proof of the fix: the plain provider is refused at least once,
 * and the wrapped provider (vision.ts) still gets the picture read, without the chat's model changing.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import {
  modelCatalogue,
  pickImageModel,
  providerFor,
  userMsg,
  type LlmProvider,
  type CapabilityOptions,
  type Catalogue,
  type RefusalRecord,
} from '@agent/core'

import { withImageHandling, freshImageSession, type VisionStores } from '../src/main/runtime/vision'

const key = process.env['OPENCODE_GO_API_KEY'] ?? ''
const live = process.env['LIVE_VISION'] === '1' && key !== ''
const PROVIDER = 'opencode_go'
const BASE = 'https://opencode.ai/zen/go/v1'
const MODEL = process.env['LIVE_VISION_MODEL'] ?? 'deepseek-v4.1-flash'
const DIGITS = '3319'

/** The picture the model has to read: four big digits, drawn without any image library. */
function picture(file: string): void {
  const glyphs: Record<string, string[]> = {
    '7': ['11111', '00001', '00001', '11111', '00001', '00001', '11111'],
    '3': ['11111', '00001', '00001', '01111', '00001', '00001', '11111'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '9': ['11111', '10001', '10001', '11111', '00001', '00001', '11111'],
  }
  const width = 640
  const height = 200
  const scale = 20
  const rows: Buffer[] = []
  const ink = new Map<string, [number, number]>()
  let x = 90
  for (const digit of DIGITS) {
    const shape = glyphs[digit] ?? []
    for (let ry = 0; ry < shape.length; ry += 1) {
      for (let rx = 0; rx < (shape[ry] ?? '').length; rx += 1) {
        if ((shape[ry] ?? '')[rx] !== '1') continue
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) ink.set(`${x + rx * scale + dx},${30 + ry * scale + dy}`, [17, 17, 17])
        }
      }
    }
    x += 6 * scale
  }
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3)
    for (let px = 0; px < width; px += 1) {
      const dot = y > height - 41 ? ([220, 30, 30] as [number, number]) : (ink.get(`${px},${y}`) ?? [255, 255, 255])
      row[1 + px * 3] = dot[0]
      row[2 + px * 3] = dot[1]
      row[3 + px * 3] = dot[2]
    }
    rows.push(row)
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(body.length, 0)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), body])) >>> 0, 0)
    return Buffer.concat([head, Buffer.from(type, 'ascii'), body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}

let table: number[] | null = null
function crc32(bytes: Buffer): number {
  if (table === null) {
    table = []
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of bytes) crc = (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function memoryStores(): VisionStores {
  const catalogues = new Map<string, Catalogue>()
  const refusals = new Map<string, RefusalRecord>()
  return {
    catalogueStore: { read: (k) => catalogues.get(k) ?? null, write: (k, v) => void catalogues.set(k, v) },
    refusalStore: {
      read: (k) => refusals.get(k) ?? null,
      write: (k, v) => void refusals.set(k, v),
      clear: (k) => void refusals.delete(k),
    },
  }
}

const ASK = 'What four-digit number is written in the picture? Answer with the digits only.'

describe.skipIf(!live)('live: a picture through OpenCode Go', () => {
  it('gets read even when the route that answers first has no image input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-vision-'))
    const file = join(dir, 'digits.png')
    picture(file)

    const stores = memoryStores()
    const options: CapabilityOptions = {
      provider: PROVIDER,
      baseUrl: BASE,
      apiKey: key,
      catalogueStore: stores.catalogueStore,
      refusalStore: stores.refusalStore,
    }
    const catalogue = await modelCatalogue(options)
    expect(catalogue, 'the provider must publish its model list').not.toBeNull()
    const alternative = pickImageModel(catalogue, MODEL)
    const said = catalogue?.models.find((model) => model.id === MODEL)
    console.log(`metadata says ${MODEL} takes pictures: ${String(said?.image)}; alternative: ${String(alternative)}`)

    // 1. The plain provider: the same request is refused on some sessions. That is the bug's cause.
    let refused = 0
    let read = ''
    for (let attempt = 0; attempt < 5 && read === ''; attempt += 1) {
      const plain = providerFor({ provider: PROVIDER, key, baseUrl: BASE, sessionId: freshImageSession() })
      try {
        const answer = await plain.complete('You read pictures.', [userMsg(ASK, [file])], [], MODEL, 4000)
        read = answer.message.blocks.map((block) => (block.t === 'text' ? block.text : '')).join(' ').trim()
      } catch (error) {
        refused += 1
        console.log(`plain attempt ${attempt + 1} refused: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`)
      }
    }
    console.log(`plain provider: ${refused} refusals before an answer; answer: ${read.slice(0, 80)}`)

    // 2. The app's path: one call, retried on fresh sessions, and the picture is read.
    const sessions: string[] = []
    const make = (): LlmProvider => {
      const session = freshImageSession()
      sessions.push(session)
      return providerFor({ provider: PROVIDER, key, baseUrl: BASE, sessionId: session })
    }
    const retries: number[] = []
    const switched: string[] = []
    const wrapped = withImageHandling(make(), {
      override: 'auto',
      capability: options,
      refresh: make,
      alternatives: () => (alternative === null ? [] : [alternative]),
      onRetry: (attempt) => retries.push(attempt),
      onSwitch: (model) => switched.push(model),
    })
    const outcome = await wrapped.complete('You read pictures.', [userMsg(ASK, [file])], [], MODEL, 4000)
    const words = outcome.message.blocks.map((block) => (block.t === 'text' ? block.text : '')).join(' ')
    console.log(`wrapped: answer "${words.trim().slice(0, 80)}", retries ${retries.length}, switched ${switched.join(',') || 'no'}, sessions ${sessions.length}`)

    expect(words).toMatch(/3\s*3\s*1\s*9/)
  }, 300_000)
})
