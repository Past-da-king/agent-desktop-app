/**
 * The one JSON object in a model's reply, read the way models actually write it: inside a code fence or a
 * sentence, after a <think> block, with real line breaks inside strings (a numbered how-to), a trailing comma,
 * or cut off at the end because the reply ran out of room. Only what was cut off is lost: the entries written
 * before the cut are kept.
 */

/** The reply's JSON object, or null when there is none to be had. */
export function replyObject(reply: string): Record<string, unknown> | null {
  const text = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '')
  const start = text.indexOf('{')
  if (start < 0) return null
  const end = text.lastIndexOf('}')
  const whole = text.slice(start)
  const ended = end > start ? text.slice(start, end + 1) : whole
  // As written first; then repaired from the first brace on, which keeps a cut-off tail, before the shorter cut.
  for (const attempt of [ended, repairJson(whole), repairJson(ended)]) {
    try {
      const value: unknown = JSON.parse(attempt)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
    } catch {
      // Try the next way of reading it.
    }
  }
  return null
}

/**
 * Makes almost-JSON parse: control characters inside strings are escaped, trailing commas go, and a reply cut
 * short is closed (an unfinished string ends, a dangling key or comma is dropped, open brackets close).
 */
export function repairJson(raw: string): string {
  let out = ''
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const ch of raw) {
    if (inString) {
      if (escaped) {
        escaped = false
        out += ch
      } else if (ch === '\\') {
        escaped = true
        out += ch
      } else if (ch === '"') {
        inString = false
        out += ch
      } else if (ch === '\n') out += '\\n'
      else if (ch === '\r') out += ''
      else if (ch === '\t') out += '\\t'
      else if (ch < ' ') out += ' '
      else out += ch
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']')
    else if (ch === '}' || ch === ']') {
      if (stack.length === 0) break
      stack.pop()
      out = out.replace(/,\s*$/, '')
      out += ch
      if (stack.length === 0) break
      continue
    }
    out += ch
  }
  if (inString) {
    if (escaped) out = out.slice(0, -1)
    out += '"'
  }
  if (stack.length > 0) {
    // Cut off: drop a half-written "key": or a dangling comma, then close what is open.
    out = out.replace(/,\s*"(?:[^"\\]|\\.)*"\s*:?\s*$/, '').replace(/[,:]\s*$/, '')
    while (stack.length > 0) out += stack.pop()
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}
