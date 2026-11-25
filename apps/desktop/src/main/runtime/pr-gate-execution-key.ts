/** Parsed execution identities for the cooperative gh pass. No credentials are carried. */
import { parse } from 'shell-quote'
import { realpathSync, readFileSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import type { JsonObject } from '@agent/core'
export function executionCwd(cwd: string): string {
  if (cwd === '*') return cwd
  try {
    return realpathSync(cwd)
  } catch {
    return resolve(cwd)
  }
}
export function ghExecutionKey(args: string[], cwd: string): string {
  return JSON.stringify({ args, cwd: executionCwd(cwd) })
}
export function ghOperations(
  tool: string,
  input: JsonObject,
  fallback: string,
): string[] {
  const out: string[] = []
  const inspect = (text: string, initial: string, depth = 0): void => {
    if (depth > 8) return
    let cwd = initial
    try {
      const words = parse(text, (name) => '$' + name),
        parts: string[][] = [[]]
      for (const word of words) {
        if (typeof word === 'string') parts[parts.length - 1]!.push(word)
        else if ('op' in word) parts.push([])
      }
      for (const part of parts) {
        const exe = (part[0] ?? '')
          .split(/[\\/]/)
          .pop()!
          .replace(/\.exe$/i, '')
          .toLowerCase()
        if (exe === 'cd' && part[1]) {
          cwd = resolve(
            cwd,
            part[1] === '~'
              ? homedir()
              : part[1].startsWith('~/')
                ? join(homedir(), part[1].slice(2))
                : part[1],
          )
          continue
        }
        if (exe === 'gh') out.push(ghExecutionKey(part.slice(1), cwd))
        else if (exe === 'npx' && ['tsx', 'ts-node'].includes(part[1] ?? ''))
          inspect(part.slice(1).join(' '), cwd, depth + 1)
        else if (exe === 'npx' && ['tsx', 'ts-node'].includes(part[1] ?? ''))
          inspect(part.slice(1).join(' '), cwd, depth + 1)
        else if (
          ['node', 'python', 'python3', 'tsx', 'ts-node'].includes(exe)
        ) {
          const at = part.findIndex((word) =>
            ['-e', '--eval', '-c'].includes(word),
          )
          if (at >= 0) out.push(...codeOperations(part[at + 1] ?? '', cwd))
          else {
            let file: string | undefined
            for (let at = 1; at < part.length; at++) {
              if (
                ['-r', '--require', '--import', '--loader'].includes(part[at]!)
              ) {
                at++
                continue
              }
              if (/\.(?:py|js|mjs|cjs|ts|mts|cts)$/.test(part[at]!)) {
                file = part[at]
                break
              }
            }
            if (file)
              try {
                const path = resolve(cwd, file)
                if (statSync(path).size <= 1_000_000)
                  out.push(...codeOperations(readFileSync(path, 'utf8'), cwd))
              } catch {
                /* inspected best effort */
              }
          }
        } else if (['bash', 'sh', 'pwsh', 'powershell'].includes(exe)) {
          const at = part.findIndex((word) =>
            ['-c', '-lc', '-command'].includes(word.toLowerCase()),
          )
          if (at >= 0) inspect(part.slice(at + 1).join(' '), cwd, depth + 1)
        }
      }
    } catch {
      /* Unknown wrappers do not acquire a broad execution pass. */
    }
  }
  const cwd = tool === 'run_code' ? '*' : String(input['cwd'] ?? fallback)
  if (tool === 'run_code')
    out.push(...codeOperations(String(input['code'] ?? ''), cwd))
  else inspect(String(input['command'] ?? input['cmd'] ?? ''), cwd)
  return out
}

function codeOperations(code: string, cwd: string): string[] {
  const out: string[] = []
  for (const match of code.matchAll(
    /(?:execFileSync|execFile|spawnSync|spawn|subprocess\.(?:run|call|Popen))\s*\(\s*(?:(['"])([^'"]+)\1\s*,\s*)?\[([^\]]*)\]/g,
  )) {
    const words = [...match[3]!.matchAll(/(['"])([^'"]*)\1/g)].map(
      (value) => value[2]!,
    )
    if (match[2]) words.unshift(match[2])
    if (
      words[0]
        ?.split(/[\\/]/)
        .pop()
        ?.replace(/\.exe$/i, '') === 'gh'
    )
      out.push(ghExecutionKey(words.slice(1), cwd))
  }
  for (const match of code.matchAll(
    /(?:os\.system|execSync|exec)\s*\(\s*(['"])([^'"\n]*)\1/g,
  ))
    out.push(...ghOperations('shell_run', { command: match[2]!, cwd }, cwd))
  return out
}
