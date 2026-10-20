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
