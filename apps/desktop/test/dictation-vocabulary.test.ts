import { describe, expect, it } from 'vitest'

import type { ProjectRow } from '@agent/core'

import { dictationWordsFromProjects } from '../src/main/memory/vocabulary'

function project(id: string, name: string, extra: Partial<ProjectRow> = {}): ProjectRow {
  return { id, createdAt: Number(id.replace(/\D/g, '')), name, description: '', aliases: [], icon: { glyph: 'folder', color: 'blue' }, path: '', profile: '', hidden: false, chats: [], ...extra } as ProjectRow
}

describe('dictation words from projects', () => {
  it('gives project names and their other names, visible and newest first, leaving secrets and long text out', () => {
    const words = dictationWordsFromProjects([
      project('p1', 'Old Shown'),
      project('p2', 'Kept Away', { hidden: true }),
      project('p3', 'Lender Selector', { aliases: ['lender select', 'x'] }),
      project('p4', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'),
      project('p5', 'A'.repeat(80)),
    ])
    expect(words).toEqual(['Lender Selector', 'lender select', 'Old Shown', 'Kept Away'])
  })
})
