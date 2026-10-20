/**
 * Auto update is deliberately a stub in v1. There is no update server in the source: a build can
 * provide `AGENT_UPDATE_URL` at runtime, and when it is absent or not an http(s) URL this module
 * does nothing. electron-updater can be wired here later without changing the rest of the app.
 */
export interface UpdateState {
  status: 'disabled' | 'idle'
  url: string | null
}

export function updateUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env['AGENT_UPDATE_URL']?.trim() ?? ''
  if (raw === '') return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

/** Called once at startup. An empty update URL is a valid, quiet configuration. */
export function startUpdates(env: NodeJS.ProcessEnv = process.env): UpdateState {
  const url = updateUrl(env)
  return url === null ? { status: 'disabled', url: null } : { status: 'idle', url }
}
