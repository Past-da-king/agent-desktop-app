/** Express-style paths with :params (and a trailing * for a folder), matched against a request path. No dependency. */

export interface CompiledPath {
  pattern: RegExp
  names: string[]
}

export function compilePath(path: string): CompiledPath {
  const names: string[] = []
  const source = path
    .split('/')
    .map((part, i, all) => {
      // A last segment of * takes the rest of the path, slashes and all (static folders).
      if (part === '*' && i === all.length - 1) {
        names.push('*')
        return '(.*)'
      }
      if (part.startsWith(':')) {
        names.push(part.slice(1))
        return '([^/]+)'
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return { pattern: new RegExp(`^${source}$`), names }
}

/** The params when `path` matches, else null. Params are URL-decoded; a bad escape is no match. */
export function matchPath(compiled: CompiledPath, path: string): Record<string, string> | null {
  const found = compiled.pattern.exec(path)
  if (found === null) return null
  const params: Record<string, string> = {}
  try {
    compiled.names.forEach((name, i) => {
      params[name] = decodeURIComponent(found[i + 1] ?? '')
    })
  } catch {
    return null
  }
  return params
}

/** The pass from `Authorization: Bearer` or the `agent_pass` cookie (protocol s2), or ''. */
export function passFrom(headers: Record<string, string | string[] | undefined>): string {
  const auth = headers['authorization']
  const line = Array.isArray(auth) ? auth[0] : auth
  if (typeof line === 'string') {
    const found = /^Bearer\s+(\S+)$/i.exec(line.trim())
    if (found !== null) return found[1] ?? ''
  }
  const cookie = headers['cookie']
  const text = Array.isArray(cookie) ? cookie.join('; ') : cookie
  if (typeof text === 'string') {
    for (const part of text.split(';')) {
      const [name, ...rest] = part.trim().split('=')
      if (name === 'agent_pass') return rest.join('=')
    }
  }
  return ''
}
