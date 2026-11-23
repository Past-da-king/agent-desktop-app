/**
 * ONE place where the computer's shell policy (Settings, This computer: Run without asking / Ask / Never) becomes
 * what each plan engine is started with. Codex and Claude both read it from here, so they cannot drift apart again
 * (23 Nov 2026: a Codex helper on Run without asking was still sandboxed to its folder, and on Windows that sandbox
 * refused WSL, \\wsl.localhost paths and ssh, while Claude helpers on the same setting reached all of them).
 *
 *  - always: the engine is free. Codex runs with no sandbox, never asks, network on; Claude's tools all pass the app's gate.
 *  - ask or never: the restriction stays. Codex is read-only without its own shell, so every action goes through the
 *    app's tools, which ask (or refuse); Claude's gate asks (or refuses).
 * Other brains (DeepSeek, OpenCode Go and the like) have no engine of their own: they act only through the app's tools,
 * which read the same setting.
 */
export type ShellPolicy = 'always' | 'ask' | 'never'
export type EngineAccess = 'free' | 'asked'

export interface CodexLaunch {
  sandboxMode: 'read-only' | 'danger-full-access'
  approvalPolicy: 'never'
  networkAccessEnabled: boolean
  /** Codex's own shell tool: on only when the engine is free. */
  ownShell: boolean
  /** Windows sandbox setting for Codex's config; none when nothing is sandboxed. */
  windowsSandbox: 'unelevated' | undefined
}

export interface ClaudeLaunch {
  permissionMode: 'default'
  /** Every Claude tool call is decided by the app before it runs (PreToolUse hook and canUseTool). */
  decidedByApp: true
  /** The app's gate lets commands and file changes through without asking. */
  shellFree: boolean
}

export function engineAccess(shell: ShellPolicy): EngineAccess {
  return shell === 'always' ? 'free' : 'asked'
}

export function codexLaunch(access: EngineAccess, _platform: NodeJS.Platform = process.platform): CodexLaunch {
  const free = access === 'free'
  return {
    // Full access when free: workspace-write on Windows keeps wsl.exe, \\wsl.localhost and ssh out (E_ACCESSDENIED).
    sandboxMode: free ? 'danger-full-access' : 'read-only',
    // The app asks the person itself, so Codex never blocks on top.
    approvalPolicy: 'never',
    networkAccessEnabled: free,
    ownShell: free,
    windowsSandbox: undefined,
  }
}

export function claudeLaunch(access: EngineAccess): ClaudeLaunch {
  return { permissionMode: 'default', decidedByApp: true, shellFree: access === 'free' }
}

export function enginePolicy(
  shell: ShellPolicy,
  platform: NodeJS.Platform = process.platform,
): { access: EngineAccess; codex: CodexLaunch; claude: ClaudeLaunch } {
  const access = engineAccess(shell)
  return { access, codex: codexLaunch(access, platform), claude: claudeLaunch(access) }
}
