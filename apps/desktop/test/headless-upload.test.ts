/**
 * browser_upload on the headless node's own browser (a real Chromium driven the way the server drives it): the same
 * routes as the app, and the file counts only when the sample site received its bytes.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { browserOwner } from '../src/main/browser/owner'
import { findChromium, HeadlessBrowser } from '../src/headless/browser'
// @ts-expect-error a plain script shared with the built-app proof
import { startUploadSite } from './fixtures/upload-site.mjs'

const chromium = findChromium()

let server: Server
let received: Array<{ page: string; name: string; size: number }>
let base = ''
let dir = ''
let file = ''
let browser: HeadlessBrowser

beforeAll(async () => {
  const site = (await startUploadSite(0)) as { server: Server; port: number; received: typeof received }
  server = site.server
  received = site.received
  base = `http://127.0.0.1:${site.port}`
  dir = mkdtempSync(join(tmpdir(), 'agent-node-upload-'))
  file = join(dir, 'cv.txt')
  writeFileSync(file, 'x'.repeat(777))
  if (chromium !== null) browser = new HeadlessBrowser({ dir: join(dir, 'browser'), executable: chromium, idleMs: 60_000 })
})

afterAll(async () => {
  await browser?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
})

const as = <T>(work: () => Promise<T>): Promise<T> => browserOwner.run({ owner: 'main' }, work)

async function arrived(page: string): Promise<Array<{ name: string; size: number }>> {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline && !received.some((entry) => entry.page === page)) await new Promise((resolve) => setTimeout(resolve, 50))
  return received.filter((entry) => entry.page === page).map(({ name, size }) => ({ name, size }))
}

describe.skipIf(chromium === null)('browser_upload on the headless node', () => {
  it('fills a hidden field, answers a chooser, drops on a zone, and says ERROR when nothing takes the file', async () => {
    await as(() => browser.open(`${base}/label`))
    expect(await as(() => browser.upload({ name: 'Upload resume' }, [file]))).toMatch(/^Uploaded cv\.txt \(777 bytes\) by the input route/)
    expect(await arrived('label')).toEqual([{ name: 'cv.txt', size: 777 }])

    await as(() => browser.open(`${base}/oncreate`))
    expect(await as(() => browser.upload({ name: 'Add attachment' }, [file]))).toMatch(/by the chooser route/)
    expect(await arrived('oncreate')).toEqual([{ name: 'cv.txt', size: 777 }])

    await as(() => browser.open(`${base}/drop`))
    expect(await as(() => browser.upload({ name: 'Drop your file here' }, [file]))).toMatch(/by the drop route/)
    expect(await arrived('drop')).toEqual([{ name: 'cv.txt', size: 777 }])

    await as(() => browser.open(`${base}/nothing`))
    expect(await as(() => browser.upload({ name: 'Upload document' }, [file]))).toMatch(/^ERROR: No file field was found/)
    expect(received.some((entry) => entry.page === 'nothing')).toBe(false)
  }, 90_000)
})
