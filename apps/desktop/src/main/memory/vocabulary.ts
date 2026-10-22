/**
 * The names dictation should spell right, from memory: every person, organisation and project page's name, and
 * the other spellings it answers to (its aliases). A known mis-hearing is put right on every dictation, with or
 * without clean-up ("Londercorp" -> "Initech"); clean-up is also told the names so it spells them as written.
 * Only page titles and aliases go out, never bodies, and anything that looks like a secret is left out.
 */
import type { MemoryRow, ProjectRow } from '@agent/core'

import { aliasList } from './history'
import { redactSecrets } from './redact'

export interface Vocabulary {
  /** Names as they should be written. */
  names: string[]
  /** A heard spelling and the name it means. */
  aliases: Array<{ heard: string; name: string }>
}

const NAMED_KINDS = new Set(['person', 'organisation', 'project'])
const MAX_NAMES = 80
const MAX_ALIASES = 120
const MAX_NAME = 60

export const EMPTY_VOCABULARY: Vocabulary = { names: [], aliases: [] }

/** The vocabulary from memory: named pages (open first, most recently changed first), then any page's aliases. */
export function vocabularyFrom(rows: MemoryRow[]): Vocabulary {
  // A name never carries a secret; anything the redactor would touch is left out altogether.
  const usable = (value: string): boolean => value.length >= 2 && value.length <= MAX_NAME && redactSecrets(value).text === value
  const ordered = [...rows].sort((a, b) => Number(a.status === 'closed') - Number(b.status === 'closed') || b.updatedAt - a.updatedAt)
  const names: string[] = []
  const seenNames = new Set<string>()
  const aliases: Vocabulary['aliases'] = []
  const seenHeard = new Set<string>()
  for (const row of ordered) {
    const name = row.title.trim()
    const pageAliases = aliasList(row.aliases ?? '')
    if (!usable(name) || (!NAMED_KINDS.has(row.kind) && pageAliases.length === 0)) continue
    if (names.length < MAX_NAMES && !seenNames.has(name.toLowerCase())) {
      seenNames.add(name.toLowerCase())
      names.push(name)
    }
    for (const heard of pageAliases) {
      const key = heard.toLowerCase()
      if (aliases.length >= MAX_ALIASES || !usable(heard) || key === name.toLowerCase() || seenHeard.has(key)) continue
      seenHeard.add(key)
      aliases.push({ heard, name })
    }
  }
  return { names, aliases }
}

/** Puts known mis-hearings right: each alias, as a whole word or phrase in any case, becomes its name. */
export function applyAliases(text: string, vocabulary: Vocabulary): string {
  let out = text
  // Longer spellings first, so "London Corp" wins over "London".
  for (const { heard, name } of [...vocabulary.aliases].sort((a, b) => b.heard.length - a.heard.length)) {
    // A very short spelling ("Ed", "Bo") is too likely to be an ordinary word; clean-up still hears about it.
    if (heard.replace(/\s+/g, '').length < 4) continue
    const escaped = heard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu'), name)
  }
  return out
}

/** The lines added to the clean-up brief, or '' when memory names nobody. */
export function vocabularyBrief(vocabulary: Vocabulary): string {
  if (vocabulary.names.length === 0 && vocabulary.aliases.length === 0) return ''
  const lines = ['Names the speaker uses. Spell them exactly like this when they are meant:', vocabulary.names.join(', ')]
  if (vocabulary.aliases.length > 0) {
    lines.push('Known mis-hearings, and the name meant:')
    lines.push(vocabulary.aliases.map((alias) => `${alias.heard} = ${alias.name}`).join('; '))
  }
  return lines.join('\n')
}

/**
 * Project names and the other names they answer to, for the recogniser: visible projects first, the newest first.
 * Only names go out, and anything that looks like a secret is left out.
 */
export function dictationWordsFromProjects(rows: ProjectRow[]): string[] {
  const usable = (value: string): boolean => value.length >= 2 && value.length <= MAX_NAME && redactSecrets(value).text === value
  const ordered = [...rows].sort((a, b) => Number(a.hidden === true) - Number(b.hidden === true) || b.createdAt - a.createdAt)
  const out: string[] = []
  for (const row of ordered) {
    for (const name of [row.name, ...(row.aliases ?? [])]) {
      const clean = name.trim()
      if (usable(clean)) out.push(clean)
    }
  }
  return out
}
