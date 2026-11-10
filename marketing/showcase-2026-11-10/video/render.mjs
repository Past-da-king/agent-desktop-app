#!/usr/bin/env node
// Renders comp.html frame by frame with headless Chromium and pipes the frames to ffmpeg.
// usage: node render.mjs --spec edit.json --format 9x16|16x9 --out file.mp4 --pw <folder with node_modules/playwright-core>
//        [--from 0 --to 5] renders part of it; [--still 12.5 --png out.png] writes one frame.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
const specPath = path.resolve(arg('spec', 'edit.json'))
const spec = JSON.parse(readFileSync(specPath, 'utf8'))
const format = arg('format', '9x16')
const out = path.resolve(arg('out', `out-${format}.mp4`))
const require = createRequire(path.join(path.resolve(arg('pw', here)), 'node_modules', 'x.js'))
const { chromium } = require('playwright-core')

// footage frames are addressed relative to the spec file
spec.source.dir = pathToFileURL(path.resolve(path.dirname(specPath), spec.source.dir)).href
const fps = spec.fps
const from = Number(arg('from', 0)), to = Number(arg('to', spec.duration))

const browser = await chromium.launch({ args: ['--allow-file-access-from-files', '--font-render-hinting=none', '--force-color-profile=srgb'] })
const size = format === '9x16' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 }
const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 })
page.on('pageerror', (e) => { console.error('page error:', e.message); process.exitCode = 1 })
await page.goto(pathToFileURL(path.join(here, 'comp.html')).href)
await page.evaluate(([s, f]) => window.setup(s, f), [spec, format])

const still = arg('still')
if (still != null) {
  await page.evaluate((t) => window.renderAt(t), Number(still))
  writeFileSync(path.resolve(arg('png', `still-${format}.png`)), await page.screenshot({ type: 'png' }))
  await browser.close(); process.exit(0)
}

// audio: each track is a file placed at an output second; with none, a silent track (players expect AAC)
const tracks = (spec.audio || []).map((a) => ({ ...a, file: path.resolve(path.dirname(specPath), a.file) }))
const dur = to - from
const ff = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-']
for (const a of tracks) ff.push('-i', a.file)
if (!tracks.length) ff.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo')
let af
if (tracks.length) {
  const parts = tracks.map((a, i) => {
    const delay = Math.round((a.at - from) * 1000)
    const trim = `atrim=start=${Math.max(0, a.start || 0) + Math.max(0, -delay / 1000)}${a.end != null ? ':end=' + a.end : ''},asetpts=PTS-STARTPTS`
    return `[${i + 1}:a]${trim},aresample=48000,aformat=channel_layouts=stereo,volume=${a.gain ?? 1}${a.filter ? ',' + a.filter : ''},adelay=${Math.max(0, delay)}:all=1[a${i}]`
  })
  af = parts.join(';') + ';' + tracks.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${tracks.length}:normalize=0:duration=longest,alimiter=limit=0.95,apad[aout]`
}
if (af) ff.push('-filter_complex', af, '-map', '0:v', '-map', '[aout]'); else ff.push('-map', '0:v', '-map', '1:a')
ff.push('-t', String(dur), '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
  '-r', String(fps), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', out)
const proc = spawn('ffmpeg', ff, { stdio: ['pipe', 'inherit', 'inherit'] })
const done = new Promise((res, rej) => proc.on('exit', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exit ' + c)))))

const n0 = Math.round(from * fps), n1 = Math.round(to * fps)
for (let n = n0; n < n1; n++) {
  await page.evaluate((t) => window.renderAt(t), n / fps)
  const png = await page.screenshot({ type: 'png' })
  if (!proc.stdin.write(png)) await new Promise((r) => proc.stdin.once('drain', r))
  if ((n - n0) % 150 === 0) console.error(`${format}: ${((n - n0) / fps).toFixed(0)} s of ${dur.toFixed(0)} s`)
}
proc.stdin.end()
await done
await browser.close()
console.error('wrote ' + out)
