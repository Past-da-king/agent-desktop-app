// Repo rules from AGENTS.md that a machine can check. Run by gate.sh. Exit 1 on any violation.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIRS = ['packages/core/src', 'apps/desktop/src']
const SKIP = new Set(['node_modules', 'dist', 'out', '.git'])
const files = []
const walk = (d) => {
  if (!fs.existsSync(d)) return
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(ts|tsx|css|html|json)$/.test(e.name)) files.push(p)
  }
}
SRC_DIRS.forEach((d) => walk(path.join(root, d)))

const problems = []
const rel = (p) => path.relative(root, p)
const FORBIDDEN_INFRA = /guavas|past9|ap@|impetix|kronas|100\.86\.|ssh pc2|phoneaos\.past9|\.vercel\.app|ayanda/i
// Product rule (23 Oct 2026): the product never knows one person's earlier tools. No feature, string, test or channel
// may name a private predecessor app (its name, its folder, its globals); imports go through generic formats.
const FORBIDDEN_PREDECESSOR = /A\.O\.S|\baos\b|\.aos\b|__aos|importAos|aos[-_]import|AOS_HOME/i
{
  const extra = []
  const walkAll = (d) => {
    if (!fs.existsSync(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walkAll(p)
      else if (/\.(ts|tsx|mjs|js|css|html|json)$/.test(e.name)) extra.push(p)
    }
  }
  ;['packages/core/src', 'packages/core/test', 'apps/desktop/src', 'apps/desktop/test', 'scripts'].forEach((d) => walkAll(path.join(root, d)))
  for (const f of extra) {
    if (f === fileURLToPath(import.meta.url)) continue
    fs.readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (FORBIDDEN_PREDECESSOR.test(line)) problems.push(`${rel(f)}:${i + 1} names a private predecessor app: ${line.trim().slice(0, 80)}`)
      })
  }
}
// Mock seed data may name the demo persona; real infra names are never allowed anywhere.
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8')
  const r = rel(f)
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    const at = `${r}:${i + 1}`
    if (FORBIDDEN_INFRA.test(line)) problems.push(`${at} mentions personal infrastructure: ${line.trim().slice(0, 80)}`)
    for (const ch of line) {
      const cp = ch.codePointAt(0) ?? 0
      if (cp > 0x2122 && /\p{Extended_Pictographic}/u.test(ch)) { problems.push(`${at} contains an emoji/pictograph (${ch})`); break }
    }
    // Product rule (22 Oct 2026): nothing customised to one machine. A user folder is a placeholder (You, sam, me) and
    // a private address is a range or lives in the window's demo data; never someone's real home folder or host.
    const userDir = /[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)([A-Za-z0-9._-]+)/.exec(line)
    if (userDir !== null && !/^(You|sam|me|user|name|Public|Default)$/i.test(userDir[1])) problems.push(`${at} names a real user folder (${userDir[0]})`)
    if (/\/home\/(?!user\/|you\/|me\/)[a-z][a-z0-9_-]*\/|\/mnt\/[a-z]\/Users\//.test(line)) problems.push(`${at} names a home folder on one machine`)
    if (!/renderer\/bridge\//.test(r)) {
      for (const m of line.matchAll(/\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))(?:\.\d{1,3}){2,3}\b/g)) {
        const parts = m[0].split('.')
        if (parts.length === 4 && !/^(0|255)$/.test(parts[3])) problems.push(`${at} names one machine's private address (${m[0]})`)
      }
    }
    if (/@ts-ignore|@ts-nocheck/.test(line)) problems.push(`${at} uses a ts-ignore`)
    if (/nodeIntegration:\s*true|contextIsolation:\s*false|sandbox:\s*false/.test(line) && !/\/\/ allow:/.test(line)) problems.push(`${at} weakens Electron security`)
    if (/renderer\//.test(r) && /\b(alert|confirm|prompt)\s*\(/.test(line) && !/\.(alert|confirm|prompt)\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) problems.push(`${at} uses a native dialog`)
    if (/renderer\//.test(r) && /dangerouslySetInnerHTML/.test(line) && !/Mascot\.tsx$/.test(r)) problems.push(`${at} dangerouslySetInnerHTML outside Mascot.tsx`)
    if (/renderer\//.test(r) && /from ['"](node:|fs|path|child_process|electron)['"]/.test(line)) problems.push(`${at} renderer imports a Node/Electron module`)
    if (/renderer\//.test(r) && /\bapi\.(anthropic|openai)\.com|generativelanguage\.googleapis/.test(line)) problems.push(`${at} renderer talks to an AI provider directly`)
    if (/(sk-ant-|sk-or-)[A-Za-z0-9]{12,}|AIza[0-9A-Za-z_-]{30,}/.test(line)) problems.push(`${at} looks like a real API key`)
  })
}
if (problems.length) {
  console.log(problems.slice(0, 40).join('\n'))
  console.log(`lint-checks: ${problems.length} problem(s)`)
  process.exit(1)
}
console.log(`lint-checks: ok (${files.length} files)`)
