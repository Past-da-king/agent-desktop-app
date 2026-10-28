/**
 * Guard: no child process may open a console window on Windows (28 Oct 2026: consoles flashed on Ayanda's screen).
 * Every call of a child_process function (spawn, spawnSync, exec, execSync, execFile, execFileSync, fork) in the app
 * and its packages, and every local alias of one (`const run = deps.spawn ?? spawn`), must pass `windowsHide` in the
 * call itself. A call that truly cannot take it says why on the line before with `// windows-hide-ok: <reason>`.
 * Third-party code is not checked here; our own calls stay explicit.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const ROOTS = ['apps/desktop/src', 'packages/core/src']
const CHILD_FNS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])

function files(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...files(path))
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name) && !name.endsWith('.d.ts')) out.push(path)
  }
  return out
}

/** The names this file can call that start a child process. */
export function childNames(source: string): Set<string> {
  const names = new Set<string>()
  const importRe = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"](?:node:)?child_process['"]/g
  for (let m = importRe.exec(source); m !== null; m = importRe.exec(source)) {
    if (m[1] !== undefined) continue
    for (const part of m[2]!.split(',')) {
      const piece = part.trim()
      if (piece === '' || piece.startsWith('type ')) continue
      const [orig, alias] = piece.split(/\s+as\s+/).map((s) => s.trim())
      if (CHILD_FNS.has(orig!)) names.add(alias ?? orig!)
    }
  }
  const nsRe = /import\s+\*\s+as\s+(\w+)\s+from\s+['"](?:node:)?child_process['"]|(?:const|let)\s+(\w+)\s*=\s*require\(\s*['"](?:node:)?child_process['"]\s*\)/g
  for (let m = nsRe.exec(source); m !== null; m = nsRe.exec(source)) for (const fn of CHILD_FNS) names.add(`${m[1] ?? m[2]}.${fn}`)
  // Aliases: `const run = this.deps.spawn ?? (spawn as SpawnLike)`, `const spawnImpl = spawnImplOption ?? spawn`.
  let grew = true
  while (grew) {
    grew = false
    const aliasRe = /(?:const|let)\s+(\w+)\s*=\s*([^\n;]+)/g
    for (let m = aliasRe.exec(source); m !== null; m = aliasRe.exec(source)) {
      const [, name, rhs] = m
      if (names.has(name!)) continue
      const words = rhs!.match(/[A-Za-z_$][\w$]*/g) ?? []
      if (words.some((w) => names.has(w)) && !/\(/.test(rhs!.replace(/\((\w+) as \w+\)/g, '$1'))) {
        names.add(name!)
        grew = true
      }
    }
  }
  return names
}

/** The text of the call starting at `open` (the index of its opening parenthesis), balanced. */
function callText(source: string, open: number): string {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const c = source[i]
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return source.slice(open)
}

export interface Offence {
  file: string
  line: number
  call: string
}

export function offences(file: string, source: string): Offence[] {
  const names = childNames(source)
  const out: Offence[] = []
  for (const name of names) {
    const re = new RegExp(`(?<![\\w$.])${name.replace(/\./g, '\\.')}\\s*\\(`, 'g')
    for (let m = re.exec(source); m !== null; m = re.exec(source)) {
      const before = source.slice(0, m.index)
      // Skip a definition, a type position and a member of another object (`this.spawn(`, `db.exec(`).
      if (/(function\s+|\.)\s*$/.test(before) || /typeof\s+$/.test(before)) continue
      const call = callText(source, m.index + m[0].length - 1)
      if (/windowsHide/.test(call)) continue
      const line = before.split('\n').length
      const prev = source.split('\n')[line - 2] ?? ''
      if (/windows-hide-ok:/.test(prev) || /windows-hide-ok:/.test(source.split('\n')[line - 1] ?? '')) continue
      out.push({ file, line, call: `${name}${call.slice(0, 80).replace(/\s+/g, ' ')}` })
    }
  }
  return out
}

describe('no console windows: every child process passes windowsHide', () => {
  it('finds no call without it', () => {
    const found: string[] = []
    let calls = 0
    for (const root of ROOTS) {
      for (const path of files(join(repo, root))) {
        const source = readFileSync(path, 'utf8')
        calls += childNames(source).size
        for (const o of offences(relative(repo, path).replace(/\\/g, '/'), source)) found.push(`${o.file}:${o.line} ${o.call}`)
      }
    }
    expect(calls).toBeGreaterThan(10)
    expect(found).toEqual([])
  })

  it('catches what it is meant to catch', () => {
    const bad = "import { spawn, execFile as ef } from 'node:child_process'\nspawn('netsh', ['x'], { stdio: 'pipe' })\nef('a', [], () => {})\n"
    expect(offences('x.ts', bad).map((o) => o.line).sort()).toEqual([2, 3])
    const alias = "import { spawn } from 'node:child_process'\nconst run = deps.spawn ?? (spawn as Like)\nrun('a', [])\n"
    expect(offences('x.ts', alias).map((o) => o.line)).toEqual([3])
    const ok = "import { spawn } from 'node:child_process'\nspawn('a', [], { windowsHide: true })\n// windows-hide-ok: posix only\nspawn('b')\n"
    expect(offences('x.ts', ok)).toEqual([])
    const typeOnly = "import type { spawn } from 'node:child_process'\nexport type S = typeof spawn\n"
    expect(offences('x.ts', typeOnly)).toEqual([])
  })
})
