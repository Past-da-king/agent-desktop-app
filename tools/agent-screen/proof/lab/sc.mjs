// Tiny client for agent-screen.exe: import { open } from './sc.mjs'
import { spawn } from 'node:child_process'
export function open(exe = 'C:/temp/agent-cursor/repo/tools/agent-screen/bin/win-x64/agent-screen.exe') {
  const child = spawn(exe, ['--parent', String(process.pid)], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
  let buf = '', id = 0
  const pending = new Map(), events = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (c) => { buf += c; for (;;) { const at = buf.indexOf('\n'); if (at < 0) break; const line = buf.slice(0, at).trim(); buf = buf.slice(at + 1); if (!line) continue; let m; try { m = JSON.parse(line) } catch { continue } if (m.event) { events.push(m); continue } const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m) } } })
  const call = (op, args = {}) => new Promise((res) => { const n = ++id; pending.set(n, (m) => res(m.ok ? m.result : { __error: m.code, message: m.error })); child.stdin.write(JSON.stringify({ id: n, op, ...args }) + '\n') })
  return { call, events, close: () => { try { child.stdin.end(JSON.stringify({ op: 'quit' }) + '\n') } catch {} } }
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
