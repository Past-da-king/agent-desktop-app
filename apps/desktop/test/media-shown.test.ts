import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { cleanPath, MEDIA_TYPES, ShownMedia, shownUrl, tokenOf } from '../src/main/media/shown'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-media-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function file(name: string, bytes = 'hello'): string {
  const dir = tempDir()
  const path = join(dir, name)
  writeFileSync(path, Buffer.from(bytes))
  return path
}

describe('the list of files an agent has shown', () => {
  it('keeps a real video, with its type and size, and gives it an address that carries no path', () => {
    const dir = tempDir()
    const shown = new ShownMedia(join(dir, 'shown-media.json'))
    const video = file('clip.mp4', 'x'.repeat(2048))
    const result = shown.show(video)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.kind).toBe('video')
    expect(result.file.mime).toBe('video/mp4')
    expect(result.file.size).toBe(2048)
    expect(result.file.name).toBe('clip.mp4')
    const url = shownUrl(result.file.token)
    expect(url).toMatch(/^agent-media:\/\/f\/[a-f0-9]{32}$/)
    expect(url).not.toContain(dir)
    expect(tokenOf(url)).toBe(result.file.token)
  })

  it('shows a picture and a sound too, and refuses what the window cannot play', () => {
    const dir = tempDir()
    const shown = new ShownMedia(join(dir, 'shown-media.json'))
    expect(shown.show(file('shot.png')).ok).toBe(true)
    expect(shown.show(file('voice.mp3')).ok).toBe(true)
    const refused = shown.show(file('notes.docx'))
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.why).toContain('cannot show notes.docx')
    expect(Object.keys(MEDIA_TYPES)).toContain('.mp4')
  })

  it('refuses a folder, a file that is not there, and a path that is not full', () => {
    const dir = tempDir()
    const shown = new ShownMedia(join(dir, 'shown-media.json'))
    const folder = shown.show(dir)
    expect(folder.ok).toBe(false)
    if (!folder.ok) expect(folder.why).toContain('is a folder')
    const missing = shown.show(join(dir, 'nothing.mp4'))
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.why).toContain('There is no file at')
    const relative = shown.show('clip.mp4')
    expect(relative.ok).toBe(false)
    if (!relative.ok) expect(relative.why).toContain('not a full path')
  })

  it('resolves a link and .. to the real file, so one file has one address and nothing above it is reachable', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'deep', 'inside'), { recursive: true })
    const real = join(dir, 'deep', 'inside', 'clip.mp4')
    writeFileSync(real, Buffer.from('bytes'))
    const link = join(dir, 'shortcut.mp4')
    symlinkSync(real, link)
    const shown = new ShownMedia(join(dir, 'shown-media.json'))
    const viaLink = shown.show(link)
    const viaDotDot = shown.show(join(dir, 'deep', 'inside', '..', 'inside', 'clip.mp4'))
    expect(viaLink.ok && viaDotDot.ok).toBe(true)
    if (!viaLink.ok || !viaDotDot.ok) return
    expect(viaLink.file.path).toBe(viaDotDot.file.path)
    expect(viaLink.file.token).toBe(viaDotDot.file.token)
    expect(viaDotDot.file.path).not.toContain('..')
  })

  it('answers only for a token an agent was given, never for a made up one', () => {
    const dir = tempDir()
    const shown = new ShownMedia(join(dir, 'shown-media.json'))
    const result = shown.show(file('shot.png'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(shown.get(result.file.token)?.path.endsWith('shot.png')).toBe(true)
    expect(shown.get('0'.repeat(32))).toBeNull()
    expect(shown.get('../../etc/passwd')).toBeNull()
    expect(shown.get(result.file.token.toUpperCase())).not.toBeNull()
  })

  it('still knows a file after a restart, and forgets one that has gone', () => {
    const dir = tempDir()
    const kept = file('kept.webm')
    const going = file('going.gif')
    const first = new ShownMedia(join(dir, 'shown-media.json'))
    const a = first.show(kept)
    const b = first.show(going)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    rmSync(going)
    const second = new ShownMedia(join(dir, 'shown-media.json'))
    expect(second.get(a.file.token)?.name).toBe('kept.webm')
    expect(second.get(b.file.token)).toBeNull()
  })

  it('takes a path as a model wrote it, in quotes, and keeps a UNC or a drive letter as it is', () => {
    expect(cleanPath('  "C:\\clips\\one.mp4"  ')).toBe('C:\\clips\\one.mp4')
    expect(cleanPath("'/home/me/one.mp4'")).toBe('/home/me/one.mp4')
    expect(cleanPath('C:\\clips\\one.mp4')).toBe('C:\\clips\\one.mp4')
    expect(cleanPath('\\\\server\\share\\one.mp4')).toBe('\\\\server\\share\\one.mp4')
  })

  it('refuses a URL or an address with a scheme, which is not a file on this computer', () => {
    const dir = tempDir()
    const shown = new ShownMedia(join(dir, 'shown-media.json'))
    const result = shown.show('https://example.com/clip.mp4')
    expect(result.ok).toBe(false)
  })
})
