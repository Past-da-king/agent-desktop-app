#!/usr/bin/env node
// Exports an A.O.S-style memory bank (a SQLite file with `memories`, `person_profiles` and `project_profiles`) to the
// JSON the Agent app imports (Settings > Memory > Import). The bank is opened READ-ONLY. Every title, body and topic
// goes through the app's own secret redaction (apps/desktop/src/main/memory/redact.ts) before it is written.
//
// Usage: node scripts/export-memory-bank.mjs <memory.db> <out.json>
// Needs Node 22.6+ (node:sqlite and TypeScript type stripping for the redaction module).
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { redactSecrets } from '../apps/desktop/src/main/memory/redact.ts'

const [dbPath, outPath] = process.argv.slice(2)
if (!dbPath || !outPath) {
  console.error('Usage: node scripts/export-memory-bank.mjs <memory.db> <out.json>')
  process.exit(2)
}

const started = Date.now()
const db = new DatabaseSync(dbPath, { readOnly: true })
const hits = {}
let redacted = 0
function clean(text) {
  const result = redactSecrets(String(text ?? ''))
  for (const [label, count] of Object.entries(result.hits)) hits[label] = (hits[label] ?? 0) + count
  redacted += result.total
  return result.text
}
function topicsOf(raw) {
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((t) => typeof t === 'string').map(clean) : []
  } catch {
    return []
  }
}
const has = (table) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined

const memories = []
for (const row of db.prepare('SELECT * FROM memories ORDER BY created_at').all()) {
  memories.push({
    id: row.id,
    title: clean(row.title),
    text: clean(row.body),
    kind: row.kind,
    project: row.scope === 'global' ? '' : row.project_id ?? '',
    topics: topicsOf(row.topics),
    life: row.life ?? '',
    date: new Date(row.happened_at || row.created_at).toISOString(),
    status: row.status === 'active' ? 'active' : 'retired',
  })
}

// People: the bank's person profiles are the richest pages about each person.
const people = []
if (has('person_profiles')) {
  const aliases = has('person_aliases') ? db.prepare('SELECT alias, person_id FROM person_aliases').all() : []
  for (const row of db.prepare('SELECT * FROM person_profiles').all()) {
    const parts = []
    if (row.role) parts.push(row.role)
    if (row.org) parts.push(`Organisation: ${row.org}`)
    if (row.identity) parts.push(`Account: ${row.identity}`)
    if (row.owns) parts.push(`The authority on: ${row.owns}`)
    if (row.working_with) parts.push(`Working with them: ${row.working_with}`)
    if (row.profile) parts.push(row.profile)
    const names = aliases.filter((a) => a.person_id === row.id && !/^u0[0-9a-z]{8,}$/.test(a.alias)).map((a) => a.alias)
    people.push({ row, names })
    memories.push({
      id: row.id,
      title: clean(row.name),
      text: clean(parts.join('\n\n')),
      kind: 'person',
      project: '',
      topics: ['people', ...names.slice(0, 6).map(clean)],
      life: row.life ?? '',
      date: new Date(row.updated_at).toISOString(),
      status: 'active',
    })
  }
}

// Projects: goal, where it stands, what is left.
if (has('project_profiles')) {
  for (const row of db.prepare('SELECT * FROM project_profiles').all()) {
    const parts = []
    if (row.goal) parts.push(`**Goal** ${row.goal}`)
    if (row.state) parts.push(`**Where it stands** ${row.state}`)
    if (row.distance) parts.push(`**What is left** ${row.distance}`)
    if (parts.length === 0) continue
    memories.push({
      id: `project:${row.project_id}`,
      title: clean(row.name || row.project_id),
      text: clean(parts.join('\n\n')),
      kind: 'project',
      project: row.project_id,
      topics: [row.project_id],
      life: row.life ?? '',
      date: new Date(row.updated_at).toISOString(),
      status: 'active',
    })
  }
}

// Organisations: gathered from who works where in the person profiles.
const orgs = new Map()
for (const { row } of people) {
  if (!row.org) continue
  const name = String(row.org).replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim()
  if (name === '' || /^external\b/i.test(name)) continue
  const key = name.toLowerCase()
  const entry = orgs.get(key) ?? { name, members: [], updated: 0 }
  entry.members.push(`- [[${row.name}]]: ${String(row.role ?? '').split('\n')[0]}`)
  entry.updated = Math.max(entry.updated, row.updated_at)
  orgs.set(key, entry)
}
for (const [key, org] of orgs) {
  memories.push({
    id: `org:${key.replace(/[^a-z0-9]+/g, '-')}`,
    title: clean(org.name),
    text: clean(`${org.name}: people the user works with there.\n\n${org.members.join('\n')}`),
    kind: 'organisation',
    project: '',
    topics: ['organisation'],
    life: 'work',
    date: new Date(org.updated).toISOString(),
    status: 'active',
  })
}

const counts = {}
for (const m of memories) {
  const key = `${m.status}:${m.kind}`
  counts[key] = (counts[key] ?? 0) + 1
}
const out = {
  format: 'agent-memory-export',
  version: 1,
  source: 'A.O.S Memory Bank',
  exportedAt: new Date().toISOString(),
  redactions: hits,
  memories,
}
writeFileSync(outPath, JSON.stringify(out, null, 1), { mode: 0o600 })
console.log(JSON.stringify({ written: memories.length, counts, redacted, hits, ms: Date.now() - started }, null, 1))
