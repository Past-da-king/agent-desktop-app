/** Short-lived execution-time gh boundary, shared by app and plan-engine shells. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { quote } from 'shell-quote'
import type { JsonObject, ToolContext } from '@agent/core'
import type { PrGate } from './pr-gate'
import { reviewableCall } from './pr-gate-detect'

type Scope = { env: NodeJS.ProcessEnv }
const scopes = new AsyncLocalStorage<Scope>()
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
  const wsl = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe') : null;
  const forward = (file, words, options = {}) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = cp.spawn(file, words, { stdio: 'inherit', env, windowsHide: true, ...options });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('error', error => { console.error(error.message); process.exitCode = 127; });
    child.on('exit', (code, signal) => { if (signal && process.platform !== 'win32') process.kill(process.pid, signal); else process.exitCode = code === null ? 1 : code; });
  };
  if (args[0] === '--agent-wsl-launch') {
    args.shift();
    if (!wsl) throw new Error('WSL launcher is Windows-only');
    const prefix = []; let at = 0;
    while (at < args.length && args[at].startsWith('-')) {
      const flag = args[at++];
      if (['-e', '--exec', '--'].includes(flag)) break;
      if (['-d', '--distribution', '-u', '--user', '--cd'].includes(flag)) {
        if (args[at] === undefined) throw new Error('Missing WSL option operand');
        prefix.push(flag, args[at++]);
      } else {
        // Administrative WSL calls do not execute an agent shell.
        if (['--status', '--list', '-l', '--help', '--version'].includes(flag)) { forward(wsl, args); return; }
        throw new Error('Unrecognised WSL command option; use --exec with a named shell');
      }
    }
    const command = args.slice(at);
    if (!command.length) throw new Error('Name the WSL command explicitly');
    const unix = file => cp.execFileSync(wsl, [...prefix, '--exec', 'wslpath', '-u', file], { encoding: 'utf8', windowsHide: true }).trim();
    const node = unix(process.execPath), program = unix(__filename);
    const prefixData = Buffer.from(JSON.stringify(prefix.filter((_, i) => prefix[i - 1] !== '--cd' && prefix[i] !== '--cd'))).toString('base64');
    const sh = value => "'" + value.replace(/'/g, "'\\''") + "'";
    const launcher = '#!/bin/sh\nreal=\nold_ifs=$IFS; IFS=:\nfor directory in $PATH; do\n [ "$directory" = "$AGENT_PR_GATE_UNIX_DIR" ] && continue\n if [ -x "$directory/gh" ]; then real="$directory/gh"; break; fi\ndone\nIFS=$old_ifs\n[ -n "$real" ] || exit 127\nexport ELECTRON_RUN_AS_NODE=1\nexport WSLENV="$WSLENV:ELECTRON_RUN_AS_NODE/w"\nexec ' + sh(node) + ' ' + sh(program) + ' --agent-wsl-gh ' + sh(prefixData) + ' "$real" "$PWD" "$@"\n';
    const boot = 'set -eu; gate_dir=$(mktemp -d /tmp/agent-gh-gate-XXXXXX); trap \'rm -rf -- "$gate_dir"\' EXIT; printf %s ' + sh(launcher) + ' > "$gate_dir/gh"; chmod 700 "$gate_dir/gh"; export AGENT_PR_GATE_UNIX_DIR="$gate_dir"; export PATH="$gate_dir:$PATH"; printf \'export PATH="$AGENT_PR_GATE_UNIX_DIR:$PATH"\n\' > "$gate_dir/bash-env"; export BASH_ENV="$gate_dir/bash-env"; "$@"';
    const env = { ...process.env, WSLENV: [process.env.WSLENV, 'AGENT_PR_GATE_CHANNEL', 'AGENT_PR_GATE_DIR'].filter(Boolean).join(':') };
    forward(wsl, [...prefix, '--exec', 'sh', '-c', boot, 'agent-wsl', ...command], { env }); return;
  }
  let wslReal, wslCwd, wslPrefix;
  if (args[0] === '--agent-wsl-gh') {
    args.shift(); wslPrefix = JSON.parse(Buffer.from(args.shift(), 'base64').toString());
    wslReal = args.shift(); wslCwd = args.shift();
    if (!wsl || !wslReal || !wslCwd) throw new Error('Invalid WSL gh invocation');
  }
  if (!channel) { console.error('PR gate execution channel is unavailable.'); process.exitCode = 75; return; }
  const reply = await new Promise((resolve, reject) => {
    const request = http.request(channel, { method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
      let data = ''; response.on('data', chunk => data += chunk); response.on('end', () => resolve(JSON.parse(data)));
    }); request.on('error', reject); request.end(JSON.stringify({ args, cwd: wslCwd || process.cwd() }));
  });
  if (reply.held) { console.error(reply.held); process.exitCode = 75; return; }
  if (wslReal) { forward(wsl, [...wslPrefix, '--cd', wslCwd, '--exec', wslReal, ...args]); return; }
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
  approved?: { tool: string; input: JsonObject },
): Promise<T> {
  if (!gate?.enabled()) return work()
  const dir = mkdtempSync(join(tmpdir(), 'agent-gh-gate-'))
  const pass = randomBytes(32).toString('hex')
  const outerApproved =
    !!approved && reviewableCall(approved.tool, approved.input)
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
      const command = quote(['gh', ...data.args])
      const held = outerApproved
        ? null
        : await gate.check('shell_run', { command, cwd: data.cwd }, { ...ctx })
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
    const bashEnv = join(dir, 'bash-env.sh')
    // Bash login startup can rebuild PATH. BASH_ENV runs after that for noninteractive
    // commands, so nested bash -lc cannot accidentally lose the execution boundary.
    writeFileSync(bashEnv, 'export PATH="$AGENT_PR_GATE_DIR:$PATH"\n', {
      mode: 0o600,
    })
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
    writeFileSync(
      join(dir, 'gh.cmd'),
      '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"' +
        process.execPath.replace(/%/g, '%%') +
        '" "' +
        script.replace(/%/g, '%%') +
        '" %*\r\n',
      { mode: 0o700 },
    )
    if (process.platform === 'win32')
      writeFileSync(
        join(dir, 'wsl.cmd'),
        '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"' +
          process.execPath.replace(/%/g, '%%') +
          '" "' +
          script.replace(/%/g, '%%') +
          '" --agent-wsl-launch %*\r\n',
        { mode: 0o700 },
      )
    return await scopes.run(
      {
        env: {
          AGENT_PR_GATE_CHANNEL:
            'http://127.0.0.1:' + address.port + '/' + pass,
          AGENT_PR_GATE_DIR: dir,
          BASH_ENV: bashEnv,
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
