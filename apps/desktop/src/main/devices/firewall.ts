/**
 * Windows Firewall for the Devices port. Windows asks once whether the app may use the network; an unanswered or
 * refused prompt leaves Block rules, and a phone on the same Wi-Fi cannot connect. Settings > Devices shows an
 * "Allow connections" step instead of sending the person into Windows settings: ONE elevated command (one UAC
 * prompt) that removes this program's inbound Block rules and adds an Allow rule for the program and the port.
 * Reading the rules needs no elevation. Other systems: nothing to do here.
 */
import { execFile, spawn } from 'node:child_process'

export const RULE_NAME = 'Agent devices'

export interface FirewallRule {
  name: string
  enabled: boolean
  direction: 'in' | 'out' | ''
  action: 'allow' | 'block' | ''
  program: string
  localPort: string
  protocol: string
  profiles: string
}

export type FirewallState = 'allowed' | 'missing' | 'blocked' | 'unknown' | 'not-needed'

/** Parses `netsh advfirewall firewall show rule ... verbose` (English output; field names are stable). */
export function parseFirewallRules(text: string): FirewallRule[] {
  const rules: FirewallRule[] = []
  let current: FirewallRule | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim().toLowerCase()
    const value = line.slice(at + 1).trim()
    if (key === 'rule name') {
      current = { name: value, enabled: false, direction: '', action: '', program: '', localPort: '', protocol: '', profiles: '' }
      rules.push(current)
      continue
    }
    if (current === null) continue
    if (key === 'enabled') current.enabled = value.toLowerCase() === 'yes'
    else if (key === 'direction') current.direction = value.toLowerCase() === 'in' ? 'in' : value.toLowerCase() === 'out' ? 'out' : ''
    else if (key === 'action') current.action = value.toLowerCase() === 'allow' ? 'allow' : value.toLowerCase() === 'block' ? 'block' : ''
    else if (key === 'program') current.program = value
    else if (key === 'localport') current.localPort = value
    else if (key === 'protocol') current.protocol = value
    else if (key === 'profiles') current.profiles = value
  }
  return rules
}

const samePath = (a: string, b: string): boolean => a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase()

/**
 * What the rules mean for this program and port. A Block rule for the program wins over any Allow rule (that is
 * how Windows Firewall works), so it counts first.
 */
export function firewallState(rules: FirewallRule[], program: string, port: number): FirewallState {
  const inbound = rules.filter((rule) => rule.enabled && rule.direction === 'in')
  if (inbound.some((rule) => rule.action === 'block' && samePath(rule.program, program))) return 'blocked'
  const allowsProgram = inbound.some((rule) => rule.action === 'allow' && samePath(rule.program, program))
  const allowsPort = inbound.some(
    (rule) => rule.action === 'allow' && (rule.program === '' || rule.program.toLowerCase() === 'any') && rule.localPort.split(',').map((p) => p.trim()).includes(String(port)),
  )
  return allowsProgram || allowsPort ? 'allowed' : 'missing'
}

/** Single quotes for a PowerShell string. */
function ps(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

/** The script the elevated PowerShell runs: drop this program's inbound rules, then allow it and the port. */
export function allowScript(program: string, port: number): string {
  const p = ps(program)
  return [
    "$ErrorActionPreference = 'Continue'",
    `Get-NetFirewallApplicationFilter -Program ${p} -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' } | Remove-NetFirewallRule`,
    `netsh advfirewall firewall delete rule name=${ps(RULE_NAME)} | Out-Null`,
    `netsh advfirewall firewall delete rule name=${ps(`${RULE_NAME} (port ${port})`)} | Out-Null`,
    `netsh advfirewall firewall add rule name=${ps(RULE_NAME)} dir=in action=allow program=${p} enable=yes profile=private,domain`,
    `netsh advfirewall firewall add rule name=${ps(`${RULE_NAME} (port ${port})`)} dir=in action=allow protocol=TCP localport=${port} enable=yes profile=private,domain`,
  ].join('\n')
}

/** -EncodedCommand takes base64 of UTF-16LE: no quoting of paths through two shells. */
export function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** The (not elevated) PowerShell command line that asks Windows to run the script elevated: one UAC prompt. */
export function elevateArgs(program: string, port: number): string[] {
  const inner = encodeCommand(allowScript(program, port))
  const outer = `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${inner}'`
  return ['-NoProfile', '-NonInteractive', '-Command', outer]
}

export interface FirewallDeps {
  platform: string
  /** The app's own executable (process.execPath). */
  program: string
  run?: (file: string, args: string[]) => Promise<string>
}

function runCapture(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null && stdout === '') reject(error)
      else resolve(stdout)
    })
  })
}

export class WindowsFirewall {
  private readonly run: (file: string, args: string[]) => Promise<string>

  constructor(private readonly deps: FirewallDeps) {
    this.run = deps.run ?? runCapture
  }

  get needed(): boolean {
    return this.deps.platform === 'win32'
  }

  async state(port: number): Promise<FirewallState> {
    if (!this.needed) return 'not-needed'
    try {
      const text = await this.run('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in', 'verbose'])
      return firewallState(parseFirewallRules(text), this.deps.program, port)
    } catch {
      return 'unknown'
    }
  }

  /** Shows the one UAC prompt and waits for it. Resolves when the elevated script ended (or was refused). */
  allow(port: number): Promise<void> {
    if (!this.needed) return Promise.resolve()
    return new Promise((resolve) => {
      const child = spawn('powershell.exe', elevateArgs(this.deps.program, port), { windowsHide: true, stdio: 'ignore' })
      child.on('error', () => resolve())
      child.on('exit', () => resolve())
    })
  }
}
