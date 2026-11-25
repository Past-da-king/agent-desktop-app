/** Short-lived execution-time gh boundary, shared by app and plan-engine shells. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { JsonObject, ToolContext } from '@agent/core'
import type { PrGate } from './pr-gate'

type Scope = { env: NodeJS.ProcessEnv; permits: Set<string> }
const scopes = new AsyncLocalStorage<Scope>()
const permitsByContext = new WeakMap<ToolContext, string>()
export function rememberGhPermit(ctx: ToolContext, token: string): void {
  permitsByContext.set(ctx, token)
  scopes.getStore()?.permits.add(token)
}
export function ghExecutionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scope = scopes.getStore()
  if (!scope) return env
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  const clean = { ...env }
  delete clean[pathKey]
  return {
    ...clean,
    ...scope.env,
    PATH: scope.env['AGENT_PR_GATE_DIR'] + delimiter + (env[pathKey] ?? ''),
  }
}

// This file is data written outside the repository for the child Node runtime.
// It never buffers the real command's stdin/stdout, and propagates its exit status.
export const GH_EXEC_PROGRAM = String.raw`
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), cp = require('node:child_process');
(async () => {
  let args = process.argv.slice(2);
  const channel = process.env.AGENT_PR_GATE_CHANNEL;
  if (!channel) { console.error('PR gate execution channel is unavailable.'); process.exitCode = 75; return; }
  const reply = await new Promise((resolve, reject) => {
    const request = http.request(channel, { method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
      let data = ''; response.on('data', chunk => data += chunk); response.on('end', () => resolve(JSON.parse(data)));
    }); request.on('error', reject); request.end(JSON.stringify({ args, cwd: process.cwd() }));
  });
  if (reply.held) { console.error(reply.held); process.exitCode = 75; return; }
  const own = fs.realpathSync(process.env.AGENT_PR_GATE_DIR);
  let real;
  const names = process.platform === 'win32' ? ['gh.exe'] : ['gh'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    let resolved; try { resolved = fs.realpathSync(dir); } catch { continue; }
    if (resolved.toLowerCase() === own.toLowerCase()) continue;
    for (const name of names) {
      const file = path.join(dir, name);
      try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) { real = file; break; } } catch {}
    }
    if (real) break;
  }
  if (!real) { console.error('Real gh executable was not found outside the PR gate shim.'); process.exitCode = 127; return; }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = cp.spawn(real, args, { stdio: 'inherit', env, windowsHide: true, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(real) });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { console.error(error.message); process.exitCode = 127; });
  child.on('exit', (code, signal) => { if (signal && process.platform !== 'win32') process.kill(process.pid, signal); else process.exitCode = code === null ? 1 : code; });
})().catch(error => { console.error('PR gate execution refused: ' + error.message); process.exitCode = 75; });
`

export async function withGhExecution<T>(
  gate: PrGate | undefined,
  ctx: ToolContext,
  work: () => Promise<T>,
  _approved?: { tool: string; input: JsonObject },
): Promise<T> {
  if (!gate?.enabled()) return work()
  const dir = mkdtempSync(join(tmpdir(), 'agent-gh-gate-'))
  const pass = randomBytes(32).toString('hex')
  const permits = new Set<string>()
  const permit = permitsByContext.get(ctx)
  permitsByContext.delete(ctx)
  if (permit) permits.add(permit)
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/' + pass) {
      res.writeHead(403).end()
      return
    }
    let body = ''
    try {
      for await (const chunk of req) {
        body += String(chunk)
        if (body.length > 1024 * 1024) {
          res.writeHead(413).end()
          return
        }
      }
      const data = JSON.parse(body) as { args?: unknown; cwd?: unknown }
      if (
        !Array.isArray(data.args) ||
        !data.args.every((arg) => typeof arg === 'string') ||
        typeof data.cwd !== 'string'
      )
        throw new Error('Invalid gh execution request')
      const held = await gate.checkGhExecution(
        permits,
        data.args as string[],
        data.cwd,
        ctx,
      )
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ held }))
    } catch {
      res
        .writeHead(400)
        .end(JSON.stringify({ held: 'PR gate execution check failed closed.' }))
    }
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('PR gate execution channel did not open')
    const script = join(dir, 'gh.cjs')
    writeFileSync(script, GH_EXEC_PROGRAM, { mode: 0o600 })
    const sh = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"
    writeFileSync(
      join(dir, 'gh'),
      '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ' +
        sh(process.execPath) +
        ' ' +
        sh(script) +
        ' "$@"\n',
      { mode: 0o700 },
    )
    // PowerShell array splatting preserves arguments; cmd uses the app warning only.
    const ps = (value: string) => "'" + value.replace(/'/g, "''") + "'"
    writeFileSync(
      join(dir, 'gh.ps1'),
      "$env:ELECTRON_RUN_AS_NODE='1'; & " +
        ps(process.execPath) +
        ' ' +
        ps(script) +
        ' @args; exit $LASTEXITCODE\r\n',
      { mode: 0o700 },
    )
    return await scopes.run(
      {
        permits,
        env: {
          AGENT_PR_GATE_CHANNEL:
            'http://127.0.0.1:' + address.port + '/' + pass,
          AGENT_PR_GATE_DIR: dir,
        },
      },
      work,
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
}
