import { describe, expect, it } from 'vitest'

import {
  MAX_ATTACHMENT_BYTES,
  attachmentProblem,
  megabytes,
  mimeForFile,
} from '@agent/core'

describe('the attachment size rule', () => {
  it('allows anything up to 20 MB', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(20 * 1024 * 1024)
    expect(attachmentProblem('photo.jpg', 0)).toBeNull()
    expect(attachmentProblem('photo.jpg', MAX_ATTACHMENT_BYTES)).toBeNull()
  })

  it('explains a file that is too big in plain words', () => {
    const message = attachmentProblem('video.mp4', MAX_ATTACHMENT_BYTES + 1)
    expect(message).toBe(`video.mp4 is ${megabytes(MAX_ATTACHMENT_BYTES + 1)}. Files up to 20 MB can be attached.`)
    expect(message).toContain('20 MB')
  })

  it('says a file could not be read rather than pretending it is fine', () => {
    expect(attachmentProblem('broken', Number.NaN)).toBe('broken could not be read.')
    expect(attachmentProblem('broken', -1)).toBe('broken could not be read.')
  })

  it('reads common kinds and falls back to an opaque file', () => {
    expect(mimeForFile('a.PNG')).toBe('image/png')
    expect(mimeForFile('notes.md')).toBe('text/markdown')
    expect(mimeForFile('no-extension')).toBe('application/octet-stream')
    expect(mimeForFile('strange.zzz')).toBe('application/octet-stream')
  })
})
