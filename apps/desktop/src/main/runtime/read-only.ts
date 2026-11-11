/**
 * Which tool calls may be cut off for a new message from the person. Re-exported by toolset.ts, the tool registry.
 */
// ---- Which tool calls may be cut off for a new message from the person ----------------------------------------
//
// His messages are never queued behind a running step (26 Oct 2026). A call that only READS (or waits) is aborted the
// moment a message arrives; anything that changes something (a send, a deploy, a push, a payment, a write, a memory
// or data change, an apps_run) is left to finish and its result is handed over with the message. The list is the
// one place that says which is which. A tool that is not on it is treated as changing something: the safe side.

/** Tools that only read or wait, whatever their input. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'now',
  // Waiting on his answer: the message he typed may be that answer. The card stays open and answerable.
  'ask_user',
  'memory_search',
  'memory_get',
  'memory_history',
  'chats_search',
  'chat_read',
  'task_list',
  'routine_list',
  'project_list',
  'helpers_status',
  'web_fetch',
  'files_list',
  'files_read',
  'files_find',
  'browser_open',
  'browser_read',
  'browser_snapshot',
  'browser_look',
  'screen_windows',
  'screen_read',
  'browser_wait_for',
  'browser_scroll',
  'browser_network',
  'browser_network_get',
  'browser_console',
  'browser_inspect',
  'browser_storage',
  'apps_connected',
  'apps_find_tools',
  'webapp_list',
  'webapp_guide',
  'worker_guide',
  'worker_list',
  'worker_logs',
  'worker_events',
  'devices_list',
  'devices_status',
  'settings_get',
  'vault_list',
  'app_actions',
  'recordings_list',
  'recordings_get',
  'calendar_events',
  'git_status_report',
  'git_autocommit_log',
  'miniapp_guide',
  'miniapp_list',
  'miniapp_get',
  // A plan engine's own tools (Claude Code, Codex) that only read.
  'Read',
  'Glob',
  'Grep',
  'LS',
  'WebSearch',
  'WebFetch',
])

/** Commands that only read or wait, as the first word of each part of a command line. */
const READ_COMMANDS: ReadonlySet<string> = new Set([
  'sleep', 'start-sleep', 'timeout', 'ls', 'dir', 'cat', 'type', 'head', 'tail', 'grep', 'rg', 'egrep', 'fgrep', 'wc',
  'echo', 'printf', 'pwd', 'whoami', 'date', 'which', 'where', 'where.exe', 'stat', 'du', 'df', 'ps', 'tasklist',
  'get-childitem', 'get-content', 'get-process', 'get-item', 'get-date', 'get-filehash', 'get-location', 'select-string',
  'test-path', 'resolve-path', 'measure-object', 'select-object', 'sort-object', 'format-table', 'format-list',
  'write-output', 'out-string', 'uname', 'hostname', 'env', 'printenv', 'sort', 'uniq', 'cut', 'tr', 'jq', 'tree',
  'file', 'md5sum', 'sha1sum', 'sha256sum', 'nproc', 'free', 'uptime', 'id', 'ping', 'nslookup', 'dig', 'true',
  'false', 'basename', 'dirname', 'realpath', 'readlink', 'column', 'less', 'more', 'diff', 'cmp', 'nl', 'tac', 'rev',
  'seq', 'test', '[', 'find', 'sed', 'git', 'curl', 'wget',
])

/** git subcommands that only read. */
const GIT_READS: ReadonlySet<string> = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'grep', 'reflog', 'ls-remote', 'cat-file', 'show-ref', 'merge-base'])

/** Does this command line only read (every part a reading command, no writing redirection, no hidden subshell)? */
export function readOnlyCommand(command: string): boolean {
  let line = command.trim()
  if (line === '') return false
  // Throwing output away is not writing.
  line = line.replace(/\d?>\s*&\s*\d/g, ' ').replace(/\d?>\s*(\/dev\/null|\$null|nul)\b/gi, ' ')
  if (/[>`]|\$\(|<\(|\btee\b/.test(line)) return false
  const parts = line.split(/&&|\|\||[;|\n]/).map((part) => part.trim()).filter((part) => part !== '')
  if (parts.length === 0) return false
  return parts.every((part) => {
    const words = part.split(/\s+/)
    const first = (words[0] ?? '').toLowerCase().replace(/^["']|["']$/g, '')
    if (!READ_COMMANDS.has(first)) return false
    const rest = words.slice(1)
    if (first === 'find') return !rest.some((word) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(word))
    if (first === 'sed') return !rest.some((word) => /^-[a-z]*i/.test(word) || word === '--in-place')
    if (first === 'git') {
      const sub = rest.find((word) => !word.startsWith('-')) ?? ''
      return GIT_READS.has(sub)
    }
    if (first === 'curl' || first === 'wget') return !rest.some((word) => /^(-X|--request|-d|--data.*|-F|--form|-T|--upload-file|-o|--output|-O|--remote-name|--post-data|--post-file)$/.test(word))
    return true
  })
}

/**
 * May this call be cut off for a new message from the person? Yes only for calls that read or wait. A plan engine's
 * names arrive with the app's prefix (mcp__agent__memory_search) or as its own (Bash, Read).
 */
export function isInterruptible(name: string, input: Record<string, unknown> = {}): boolean {
  const bare = name.startsWith('mcp__agent__') ? name.slice('mcp__agent__'.length) : name
  if (READ_ONLY_TOOLS.has(bare)) return true
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  switch (bare) {
    case 'shell_run':
    case 'Bash':
    case 'PowerShell':
      return readOnlyCommand(text(input['command']))
    case 'browser_fetch': {
      const method = text(input['method']).toUpperCase()
      return (method === '' || method === 'GET' || method === 'HEAD') && input['body'] === undefined && input['from'] === undefined
    }
    case 'prompt_rules': {
      const action = text(input['action'])
      return action === 'list' || action === 'history'
    }
    case 'run_script_result':
      return input['stop'] !== true
    case 'device_tool': {
      const args = input['args']
      return isInterruptible(text(input['tool']), typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {})
    }
    default:
      return false
  }
}
