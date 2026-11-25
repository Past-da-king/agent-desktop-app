import { parse, quote } from 'shell-quote'
import { readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
type Args = Record<string, unknown>
function object(value: unknown): Args {
  if (typeof value === 'string') {
    try {
      return object(JSON.parse(value))
    } catch {
      const params = new URLSearchParams(value)
      return Object.fromEntries(params)
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Args)
    : {}
}
function unreadable(v: unknown): boolean {
  return (
    typeof v === 'string' && /(^@|\$\(|\x60|<\(|\$\{?[\w]|\{\{vault:)/.test(v)
  )
}
export function readyComment(v: unknown): boolean {
  return typeof v === 'string' && /^\s*ready\s+for\s+review\b/i.test(v)
}
function graph(query: unknown): boolean {
  if (typeof query !== 'string' || unreadable(query)) return true
  if (
    /\b(markPullRequestReadyForReview|requestReviews|mergePullRequest|enablePullRequestAutoMerge)\s*\(/.test(
      query,
    )
  )
    return true
  if (
    /\bcreatePullRequest\s*\(/.test(query) &&
    !/\bdraft\s*:\s*true\b/.test(query)
  )
    return true
  return (
    /\b(addComment|addPullRequestReview)\s*\(/.test(query) &&
    /\bready\s+for\s+review\b/i.test(query)
  )
}
export function githubWrite(
  url: string,
  method: string,
  body: unknown,
  unknownBody = false,
): boolean {
  let path = url,
    web = false
  if (/^https?:/i.test(url)) {
    try {
      const parsed = new URL(url)
      if (!['api.github.com', 'github.com'].includes(parsed.hostname))
        return false
      web = parsed.hostname === 'github.com'
      path = parsed.pathname
    } catch {
      return false
    }
  }
  if (!/^(POST|PATCH|PUT)$/i.test(method)) return false
  const data = object(body),
    opaque = unknownBody || unreadable(body)
  if (/(^|\/)graphql(?:\?|$)/i.test(path)) return opaque || graph(data['query'])
  if (web) {
    if (
      /\/pull\/\d+\/(?:ready_for_review|review-requests|merge|auto_merge)(?:\/|$)/i.test(
        path,
      )
    )
      return true
    if (/\/(?:pulls|pull\/(?:new|create)|compare)(?:\/|$)/i.test(path))
      return opaque || data['draft'] !== true
    if (/\/(?:issues|pull)\/\d+\/comments?(?:\/|$)/i.test(path))
      return opaque || readyComment(data['body'] ?? data['comment[body]'])
  }
  if (
    /\/pulls\/\d+\/(?:requested_reviewers|merge|auto_merge)(?:\?|$)/i.test(path)
  )
    return true
  if (/\/pulls(?:\?|$)/i.test(path) && /^POST$/i.test(method))
    return opaque || ![true, 'true'].includes(data['draft'] as boolean | string)
  if (/\/pulls\/\d+(?:\?|$)/i.test(path))
    return (
      opaque || [false, 'false'].includes(data['draft'] as boolean | string)
    )
  if (/\/pulls\/\d+\/reviews(?:\?|$)/i.test(path))
    return opaque || unreadable(data['body']) || readyComment(data['body'])
  return (
    /\/issues\/\d+\/comments(?:\?|$)/i.test(path) &&
    (opaque || unreadable(data['body']) || readyComment(data['body']))
  )
}
function option(words: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < words.length; i++)
    for (const name of names) {
      const word = words[i] ?? ''
      if (word.toLowerCase() === name.toLowerCase()) return words[i + 1]
      if (word.toLowerCase().startsWith(name.toLowerCase() + '='))
        return word.slice(name.length + 1)
      if (/^-[a-zA-Z]$/.test(name) && word.startsWith(name) && word.length > 2)
        return word.slice(2)
    }
  return undefined
}
function base(w: string): string {
  return w
    .split(/[\\/]/)
    .pop()!
    .replace(/\.exe$/i, '')
    .toLowerCase()
}
function gh(args: string[]): boolean {
  // Skip global flags before finding the noun; flag values are never commands.
  while (args[0]?.startsWith('-')) {
    const flag = args.shift()!
    if (['-R', '--repo', '--hostname'].includes(flag)) args.shift()
  }
  const issue = args[0] === 'issue' ? 0 : -1,
    pr = args[0] === 'pr' ? 0 : -1,
    rest = args[0] === 'api' ? 0 : -1
  const flags: string[] = []
  for (let i = 2; i < args.length; i++) {
    const word = args[i]!
    if (
      [
        '--title',
        '-t',
        '--body',
        '-b',
        '--body-file',
        '-F',
        '--base',
        '-B',
        '--head',
        '-H',
        '--repo',
        '-R',
      ].includes(word)
    ) {
      i++
      continue
    }
    flags.push(word)
  }
  if (flags.includes('--dry-run')) return false
  const comment = (): boolean =>
    readyComment(option(args, '--body', '-b')) ||
    option(args, '--body-file', '-F') !== undefined ||
    unreadable(option(args, '--body', '-b'))
  if (issue >= 0 && args[issue + 1] === 'comment') return comment()
  if (pr >= 0) {
    const action = args[pr + 1]
    if (action === 'create' || action === 'new')
      return !flags.some(
        (w) => /^--draft(?:=(?:true|1))?$/.test(w) || w === '-d',
      )
    if (action === 'ready') return !args.includes('--undo')
    if (['merge', 'review-request', 'request-review'].includes(action ?? ''))
      return true
    if (action === 'edit')
      return args.some((w) => /^--add-reviewer(?:=|$)/.test(w))
    if (action === 'comment' || action === 'review') return comment()
    return false
  }
  if (args[0] === 'alias' && args[1] === 'set')
    return shell('gh ' + args.slice(3).join(' '), 1)
  if (rest >= 0) {
    const path =
      args
        .slice(rest + 1)
        .find((w) =>
          /^(?:\/?repos\/|\/?repositories\/|https:\/\/|\/?graphql$)/.test(w),
        ) ?? ''
    const data: Args = {}
    let opaque = option(args, '--input') !== undefined
    for (let i = rest + 1; i < args.length; i++) {
      const word = args[i]!
      let field: string | undefined
      if (/^(?:-f|-F|--field|--raw-field)$/.test(word)) field = args[++i]
      else if (/^(?:-f|-F)[^=]+=/.test(word)) field = word.slice(2)
      else if (/^--(?:raw-)?field=/.test(word))
        field = word.slice(word.indexOf('=') + 1)
      if (field) {
        const equal = field.indexOf('=')
        if (equal >= 0) {
          const value = field.slice(equal + 1)
          data[field.slice(0, equal)] = value
          opaque ||= unreadable(value)
        }
      }
    }
    const method =
      option(args, '-X', '--method') ??
      (opaque || Object.keys(data).length ? 'POST' : 'GET')
    return githubWrite(path, method, data, opaque)
  }
  return false
}
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'pwsh', 'powershell'])
const INERT = new Set([
  'echo',
  'printf',
  'grep',
  'rg',
  'cat',
  'write-output',
  'write-host',
])
const PREFIX = new Set([
  'then',
  'do',
  'else',
  'elif',
  'if',
  'while',
  'until',
  '!',
  '{',
  '}',
])
function argv(words: string[], depth: number): boolean {
  if (depth > 12) return false
  let start = 0
  while (PREFIX.has(words[start] ?? '') || /^[\w_]+=/.test(words[start] ?? ''))
    start++
  words = words.slice(start)
  const exe = base(words[0] ?? ''),
    args = words.slice(1)
  if (!exe || INERT.has(exe)) return false
  if (['eval', 'iex', 'invoke-expression'].includes(exe))
    return shell(args.join(' '), depth + 1)
  if (SHELLS.has(exe)) {
    const i = args.findIndex((w) => /^-(?:[a-z]*c|command)$/i.test(w))
    if (i >= 0)
      return shell(
        args
          .slice(i + 1)
          .join(' ')
          .replace(
            ['pwsh', 'powershell'].includes(exe) ? /\x60\r?\n/g : /$^/g,
            '',
          ),
        depth + 1,
      )
    if (
      args.some((word) => /^-n$|^-.*n.*$/.test(word)) &&
      !['pwsh', 'powershell'].includes(exe)
    )
      return false
    const fileIndex = args.findIndex((word) => /^-file$/i.test(word))
    const file =
      fileIndex >= 0
        ? args[fileIndex + 1]
        : args.find((word) => !word.startsWith('-'))
    if (!file || file === '-') return false
    return inspectFile(file, depth + 1)
  }
  if (exe === 'wsl') {
    let i = 0
    while (i < args.length) {
      const a = args[i]!
      if (a === '--' || a === '-e' || a === '--exec') {
        i++
        break
      }
      if (['-d', '--distribution', '-u', '--user', '--cd'].includes(a)) {
        i += 2
        continue
      }
      if (a.startsWith('-')) {
        i++
        continue
      }
      break
    }
    return argv(args.slice(i), depth + 1)
  }
  if (exe === 'ssh') {
    let i = 0
    while (args[i]?.startsWith('-')) {
      const a = args[i++]!
      if (['-p', '-i', '-l', '-o', '-F', '-J', '-S'].includes(a)) i++
    }
    return shell(args.slice(i + 1).join(' '), depth + 1)
  }
  if (
    [
      'env',
      'sudo',
      'command',
      'exec',
      'nohup',
      'xargs',
      'timeout',
      'time',
      'nice',
      'setsid',
      'stdbuf',
      'flock',
      'watch',
      'build-slot',
      'npx',
      'busybox',
    ].includes(exe)
  ) {
    if (exe === 'command' && args.includes('-v')) return false
    const paired: Record<string, string[]> = {
      sudo: ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt'],
      env: ['-u', '--unset', '-C', '--chdir'],
      xargs: ['-I', '-n', '-L', '-P', '-d', '-a', '-E'],
      nice: ['-n', '--adjustment'],
      watch: ['-n', '--interval'],
      time: ['-f', '--format', '-o', '--output'],
      stdbuf: ['-i', '-o', '-e'],
      flock: ['-w', '--timeout', '-E', '--conflict-exit-code'],
      npx: ['-p', '--package', '--cache', '--registry'],
    }
    if (exe === 'env' && option(args, '-S', '--split-string'))
      return shell(option(args, '-S', '--split-string')!, depth + 1)
    if (['flock', 'npx'].includes(exe) && option(args, '-c', '--command'))
      return shell(option(args, '-c', '--command')!, depth + 1)
    let at = 0
    while (at < args.length) {
      const word = args[at]!
      if (word === '--') {
        at++
        break
      }
      if (exe === 'env' && /^[a-zA-Z_]\w*=/.test(word)) {
        at++
        continue
      }
      if (!word.startsWith('-')) break
      at += (paired[exe] ?? []).includes(word) ? 2 : 1
    }
    if (exe === 'timeout' || exe === 'flock') at++
    return exe === 'watch'
      ? shell(args.slice(at).join(' '), depth + 1)
      : argv(args.slice(at), depth + 1)
  }
  if (exe === 'cmd')
    return shell(
      args.slice(args.findIndex((word) => /^\/c$/i.test(word)) + 1).join(' '),
      depth + 1,
    )
  if (['su', 'script'].includes(exe)) {
    const at = args.findIndex((word) => /^-(?:[a-z]*c|command)$/i.test(word))
    return at >= 0
      ? shell(args.slice(at + 1, at + 2).join(' '), depth + 1)
      : false
  }
  if (exe === 'git')
    return args.some(
      (word) =>
        word.includes('=!') &&
        shell(word.slice(word.indexOf('=!') + 2), depth + 1),
    )
  if (exe === 'gh') return gh(args)
  if (
    [
      'curl',
      'invoke-restmethod',
      'irm',
      'invoke-webrequest',
      'iwr',
      'fetch',
    ].includes(exe)
  ) {
    const url =
      args.find((w) =>
        /^https:\/\/(?:api\.)?github\.com(?::443)?\//i.test(w),
      ) ?? ''
    const body = option(
      args,
      '-d',
      '--data',
      '--data-raw',
      '--data-binary',
      '--json',
      '-Body',
    )
    return githubWrite(
      url,
      option(args, '-X', '--request', '-Method') ??
        (body === undefined ? 'GET' : 'POST'),
      body,
      unreadable(body) ||
        (args.some((word) => word === '-Body') && body === undefined),
    )
  }
  if (['node', 'python', 'python3'].includes(exe))
    return script(option(args, '-e', '--eval', '-c') ?? '')
  if (exe.startsWith('$') && args.some((w) => /^(pr|issue|api)$/.test(w)))
    return true
  const commandIndex = words.findIndex(
    (w) => base(w) === 'gh' || SHELLS.has(base(w)),
  )
  return commandIndex > 0 && argv(words.slice(commandIndex), depth + 1)
}
/** Active substitutions are executable; strings in single quotes remain inert. */
function substitutions(source: string): string[] {
  const out: string[] = []
  let quote = ''
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    if (c === '\\') {
      i++
      continue
    }
    if (c === "'" && quote !== '"') {
      quote = quote === "'" ? '' : "'"
      continue
    }
    if (c === '"' && quote !== "'") {
      quote = quote === '"' ? '' : '"'
      continue
    }
    if (quote === "'") continue
    if (c === '\x60') {
      let j = i + 1
      while (j < source.length && source[j] !== '\x60') {
        if (source[j] === '\\') j++
        j++
      }
      out.push(source.slice(i + 1, j))
      i = j
      continue
    }
    if (c === '$' && source[i + 1] === '(') {
      let j = i + 2,
        level = 1,
        q = ''
      for (; j < source.length; j++) {
        const x = source[j]!
        if (x === '\\') {
          j++
          continue
        }
        if (q) {
          if (x === q) q = ''
          continue
        }
        if (x === "'" || x === '"') {
          q = x
          continue
        }
        if (x === '(') level++
        if (x === ')') {
          level--
          if (level === 0) break
        }
      }
      out.push(source.slice(i + 2, j))
      i = j
    }
  }
  return out
}
/** shell-quote supplies operators, quoted words, comments and variable boundaries. */
function shell(source: string, depth = 0): boolean {
  if (depth > 12) return false
  source = source.replace(/\\\r?\n/g, '')
  const lines = source.split('\n'),
    kept: string[] = [],
    bodies: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]!,
      match = header.match(/(?<![<\w])<<-?(?!<)\s*['"]?([a-zA-Z_]\w*)['"]?/)
    if (
      !match ||
      !lines.slice(i + 1).some((line) => line.trim() === match[1])
    ) {
      kept.push(header)
      continue
    }
    kept.push(header.replace(match[0], ''))
    const body: string[] = []
    while (++i < lines.length && lines[i]!.trim() !== match[1])
      body.push(lines[i]!)
    if (/\b(?:bash|sh|zsh|pwsh|powershell|ssh|wsl)\b/.test(header))
      bodies.push(body.join('\n'))
  }
  if (bodies.some((b) => shell(b, depth + 1))) return true
  source = kept.join('\n')
  if (substitutions(source).some((s) => shell(s, depth + 1))) return true
  let q = '',
    normal = ''
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    if (c === '\\') {
      normal += c + (source[++i] ?? '')
      continue
    }
    if (c === "'" || c === '"') {
      if (!q) q = c
      else if (q === c) q = ''
    }
    normal += c === '\n' && !q ? ';' : c
  }
  try {
    const entries = parse(normal, (key) => '$' + key),
      parts: string[][] = [[]]
    for (const entry of entries) {
      if (typeof entry === 'string') parts[parts.length - 1]!.push(entry)
      else if ('op' in entry && entry.op !== 'glob') parts.push([])
    }
    // Only actual pipeline operators count, never text inside echo or documentation.
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (
        typeof entry !== 'string' &&
        entry &&
        'op' in entry &&
        entry.op === '|'
      ) {
        const following = entries
          .slice(i + 1)
          .filter((word): word is string => typeof word === 'string')
        if (
          following.some(
            (word) =>
              SHELLS.has(base(word)) || ['ssh', 'wsl'].includes(base(word)),
          )
        ) {
          let beginning = i - 1
          while (beginning >= 0 && typeof entries[beginning] === 'string')
            beginning--
          const preceding = entries
            .slice(beginning + 1, i)
            .filter((word): word is string => typeof word === 'string')
          if (
            ['echo', 'printf'].includes(base(preceding[0] ?? '')) &&
            shell(preceding.slice(1).join(' '), depth + 1)
          )
            return true
          if (
            base(preceding[0] ?? '') === 'cat' &&
            preceding.slice(1).some((file) => inspectFile(file, depth + 1))
          )
            return true
        }
      }
    }
    return parts.some((part) => argv(part, depth))
  } catch {
    return /\bgh\s+(?:pr|api|issue)\b/.test(source)
  }
}
function script(code: string, pageUrl = ''): boolean {
  if (/^https:\/\/github\.com(?:\/|$)/i.test(pageUrl)) {
    if (/\.(?:click|submit)\s*\(/.test(code)) return true
    code = code.replace(
      /(['"])(\/[^'"]+)\1/g,
      (_all, delimiter, path) =>
        delimiter + new URL(path, pageUrl).href + delimiter,
    )
  }
  const url = code.match(/https:\/\/(?:api\.)?github\.com\/[^'"\s)]+/)?.[0]
  if (!url && !/github\.com/.test(code)) return false
  if (/\.(?:click|submit)\s*\(/.test(code)) return true
  if (!/\b(fetch|requests\.(?:post|patch|put)|urlopen)\b/.test(code))
    return false
  const method =
    code.match(/(?:method\s*[:=]\s*['"]|requests\.)(post|patch|put)/i)?.[1] ??
    'GET'
  return githubWrite(
    url ?? 'https://api.github.com/graphql',
    method,
    { draft: /\bdraft['"]?\s*:\s*true\b/.test(code), query: code, body: code },
    !url,
  )
}
let inspectionCwd = process.cwd()
let missingScripts: string[] = []
function inspectFile(file: string, depth: number): boolean {
  try {
    const path = resolve(inspectionCwd, file)
    if (statSync(path).size > 1_000_000) {
      missingScripts.push(path)
      return false
    }
    return shell(readFileSync(path, 'utf8'), depth)
  } catch {
    missingScripts.push(file)
    return false
  }
}
export function scriptReadNotes(input: Args): string[] {
  reviewableCall('shell_run', input)
  return [...missingScripts]
}
export function reviewableCall(name: string, input: Args): boolean {
  inspectionCwd = String(input['cwd'] ?? process.cwd())
  missingScripts = []
  name = name.replace(/^mcp__agent__/, '')
  if (['shell_run', 'Bash', 'PowerShell', 'exec_command'].includes(name))
    return shell(
      String(input['command'] ?? input['cmd'] ?? '').replace(
        name === 'PowerShell' || input['shell'] === 'powershell'
          ? /\x60\r?\n/g
          : /$^/g,
        '',
      ),
    )
  if (name === 'device_tool')
    return reviewableCall(String(input['tool'] ?? ''), object(input['args']))
  if (name === 'browser_fetch') {
    if (input['from'] && !input['_resolvedReplay']) return true
    return githubWrite(
      String(input['url'] ?? ''),
      String(input['method'] ?? 'GET'),
      input['body'],
      input['_unknownBody'] === true,
    )
  }
  if (['browser_act', 'browser_click', 'browser_press_key'].includes(name)) {
    if (!/^https:\/\/github\.com(?:\/|$)/i.test(String(input['pageUrl'] ?? '')))
      return false
    if (name === 'browser_click' || name === 'browser_press_key') return true
    if (input['action'] === 'type' && input['submit'] === true)
      return readyComment(input['text'])
    return (
      /click|press|select|check/.test(String(input['action'])) &&
      (!input['name'] ||
        /ready\s+for\s+review|request\s+review|create\s+pull\s+request|\bmerge\b|auto-?merge/i.test(
          String(input['name'] ?? ''),
        ))
    )
  }
  if (name === 'browser_eval' || name === 'run_code')
    return script(
      String(input['js'] ?? input['code'] ?? ''),
      String(input['pageUrl'] ?? ''),
    )
  if (name === 'webapp_run' || name === 'webapp_test')
    return (
      /github/i.test(String(input['app'])) &&
      /merge|mark_ready|(?:create|open|ready|request|merge).*(?:pull|pr|review)|(?:pull|pr).*(?:create|open|ready|merge)/i.test(
        String(input['tool']),
      )
    )
  if (name === 'apps_run') {
    const slug = String(input['slug'] ?? '').toUpperCase(),
      args = object(input['arguments'])
    if (!slug.startsWith('GITHUB_')) return false
    if (
      /REQUEST.*REVIEW|MARK.*READY.*REVIEW|(?:PULL_REQUEST|PR).*MERGE|MERGE.*(?:PULL_REQUEST|PR)|AUTO_MERGE/.test(
        slug,
      )
    )
      return true
    if (/^GITHUB_CREATE_(?:A_)?PULL_REQUEST$/.test(slug))
      return ![true, 'true'].includes(args['draft'] as boolean | string)
    if (/(?:UPDATE|EDIT).*PULL_REQUEST/.test(slug))
      return args['draft'] === false
    if (/CREATE.*(?:COMMENT|REVIEW)/.test(slug))
      return readyComment(args['body'])
    if (/GRAPHQL/.test(slug)) return graph(args['query'])
  }
  return false
}

/** Approvals are observed for audit, but do not require the reviewability grant. */
export function reviewApproval(name: string, input: Args): boolean {
  if (name === 'apps_run')
    return (
      /^GITHUB_.*CREATE.*REVIEW/.test(String(input['slug'])) &&
      String(object(input['arguments'])['event']).toUpperCase() === 'APPROVE'
    )
  if (['shell_run', 'Bash', 'PowerShell'].includes(name)) {
    try {
      const words = parse(String(input['command'] ?? ''), (key) => '$' + key)
      const ghAt = words.findIndex(
        (w) => typeof w === 'string' && base(w) === 'gh',
      )
      return (
        ghAt >= 0 &&
        words[ghAt + 1] === 'pr' &&
        words[ghAt + 2] === 'review' &&
        words.includes('--approve')
      )
    } catch {
      return false
    }
  }
  return false
}

/** Snapshot a readable direct comment body into argv, so execution uses the bytes we checked. */
export function inlineCommentFile(
  name: string,
  input: Args,
  cwd?: string,
): Args {
  if (
    name !== 'shell_run' ||
    !['bash', 'sh'].includes(
      String(
        input['shell'] ??
          (process.platform === 'win32' ? 'powershell' : 'bash'),
      ),
    )
  )
    return input
  try {
    const entries = parse(String(input['command'] ?? ''), (key) => '$' + key)
    if (!entries.every((e) => typeof e === 'string')) return input
    const words = entries as string[],
      ghAt = words.findIndex((w) => base(w) === 'gh')
    if (
      ghAt !== 0 ||
      !['pr', 'issue'].includes(words[ghAt + 1] ?? '') ||
      words[ghAt + 2] !== 'comment'
    )
      return input
    const at = words.findIndex((w) => /^(?:--body-file(?:=|$)|-F)/.test(w))
    const file = option(words, '--body-file', '-F')
    if (at < 0 || !file || file === '-' || unreadable(file)) return input
    const path = resolve(String(input['cwd'] ?? cwd ?? homedir()), file)
    if (statSync(path).size > 1_000_000) return input
    const body = readFileSync(path, 'utf8')
    if (body.includes('{{vault:')) return input
    const count = words[at] === '--body-file' || words[at] === '-F' ? 2 : 1
    if (Buffer.byteLength(body) > 100_000) {
      const directory = join(tmpdir(), 'agent-pr-gate-bodies')
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const target = join(
        directory,
        createHash('sha256').update(body).digest('hex') + '.md',
      )
      writeFileSync(target, body, { mode: 0o600 })
      words.splice(at, count, '--body-file', target)
      return {
        ...input,
        command: quote(words),
        _prGateBodyHash: createHash('sha256').update(body).digest('hex'),
      }
    }
    words.splice(at, count, '--body', body)
    return { ...input, command: quote(words) }
  } catch {
    return input
  }
}

/** Native shells re-read their body file: bind its content into the attestation key. */
export function bodyFileSignature(input: Args): string {
  try {
    const entries = parse(
      String(input['command'] ?? input['cmd'] ?? ''),
      (key) => '$' + key,
    )
    const words = entries.filter(
      (word): word is string => typeof word === 'string',
    )
    const file = option(words, '--body-file', '-F', '--input')
    if (!file || file === '-') return ''
    const path = resolve(String(input['cwd'] ?? process.cwd()), file)
    if (statSync(path).size > 1_000_000) return 'oversize'
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return 'unreadable'
  }
}
