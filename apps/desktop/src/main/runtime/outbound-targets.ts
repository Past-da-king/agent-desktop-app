import type { JsonObject } from '@agent/core'

/**
 * Which tool calls send a message or a file to a person, so the claim wrapper guards them. One table: a tool is
 * guarded when its row says the input is a send. Everything else runs untouched.
 */
export interface OutboundTarget {
  /** What the send is aimed at, for the claim key (never a token: only the method, slug or app and tool). */
  target: string
  /** The content that must match for two calls to be the same send. */
  content: unknown
  /** Reads the provider's answer: the receipt to return on a retry, a definite failure, or unknown. */
  outcome(result: string): SendOutcome
}

export type SendOutcome = { state: 'sent'; result: string } | { state: 'failed' } | { state: 'unknown' }

const SLACK_SEND = /^https:\/\/slack\.com\/api\/(chat\.postMessage|chat\.scheduleMessage|files\.completeUploadExternal|files\.upload)(?:\?|$)/i

/** Composio toolkits that reach people, and the action words that send. Reads (GET, LIST, FETCH...) never match. */
const MESSAGE_TOOLKITS = /^(?:GMAIL|OUTLOOK|MICROSOFTOUTLOOK|MICROSOFT_OUTLOOK|SLACK|SLACKBOT|MICROSOFT_TEAMS|TEAMS|WHATSAPP|TELEGRAM|DISCORD|DISCORDBOT|LINKEDIN|TWITTER|FACEBOOK|INSTAGRAM|REDDIT)_/
const SEND_WORD = /_(?:SEND|REPLY|FORWARD|POST|PUBLISH|SCHEDULE|CREATE_POST|CREATE_COMMENT|COMMENT)(?:_|$)/
const READ_WORD = /_(?:GET|LIST|FETCH|SEARCH|FIND|READ|RETRIEVE)(?:_|$)/

/** Learned-app tools that send (app name, tool name), lower case. */
const LEARNED_SENDS: ReadonlyArray<readonly [string, string]> = [['slack files', 'send_file']]

export function isComposioSend(slug: string): boolean {
  const up = slug.toUpperCase()
  return MESSAGE_TOOLKITS.test(up) && SEND_WORD.test(up) && !READ_WORD.test(up)
}

/** The guarded send this call stands for, or null when it is not a send. */
export function outboundTarget(tool: string, input: JsonObject): OutboundTarget | null {
  if (tool === 'browser_fetch') {
    const url = typeof input['url'] === 'string' ? input['url'] : ''
    const method = SLACK_SEND.exec(url)?.[1]
    if (method === undefined || String(input['method'] ?? 'GET').toUpperCase() !== 'POST') return null
    return { target: 'slack:' + method.toLowerCase(), content: input['body'] ?? '', outcome: (result) => slackOutcome(method.toLowerCase(), httpBody(result)) }
  }
  if (tool === 'apps_run') {
    const slug = String(input['slug'] ?? '')
    if (!isComposioSend(slug)) return null
    return { target: 'composio:' + slug.toUpperCase() + ':' + String(input['account'] ?? ''), content: input['arguments'] ?? {}, outcome: composioOutcome }
  }
  if (tool === 'webapp_run' || tool === 'webapp_test') {
    const app = String(input['app'] ?? '').trim().toLowerCase()
    const name = String(input['tool'] ?? '').trim().toLowerCase()
    if (!LEARNED_SENDS.some(([a, t]) => a === app && t === name)) return null
    return { target: 'learned:' + app + ':' + name, content: input['args'] ?? {}, outcome: learnedOutcome }
  }
  return null
}

/** The response body browser_fetch prints after its "Body (...):" line. */
function httpBody(result: string): string {
  return result.match(/\nBody(?: \([^\n]*\))?:\n([\s\S]*)$/)?.[1]?.trim() ?? ''
}

function parse(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

function slackOutcome(method: string, body: string): SendOutcome {
  const json = parse(body)
  if (json === null) return { state: 'unknown' }
  // Slack answers ok:false only when it did not accept the call: a definite failure that may be retried.
  if (json['ok'] === false) return { state: 'failed' }
  if (json['ok'] !== true) return { state: 'unknown' }
  if (method === 'chat.postmessage' && typeof json['ts'] === 'string' && /^\d+\.\d+$/.test(json['ts'])) return { state: 'sent', result: json['ts'] }
  if (method === 'chat.schedulemessage' && typeof json['scheduled_message_id'] === 'string') return { state: 'sent', result: json['scheduled_message_id'] }
  const files = Array.isArray(json['files']) ? json['files'] : json['file'] !== undefined ? [json['file']] : []
  const ids = files.map((file) => typeof file === 'object' && file !== null ? (file as Record<string, unknown>)['id'] : undefined).filter((id): id is string => typeof id === 'string')
  return ids.length > 0 ? { state: 'sent', result: ids.join(',') } : { state: 'unknown' }
}

function composioOutcome(result: string): SendOutcome {
  const json = parse(result.trim())
  if (json === null) return { state: 'unknown' }
  if (json['successful'] === false || json['successfull'] === false) return { state: 'failed' }
  if (json['successful'] !== true && json['successfull'] !== true) return { state: 'unknown' }
  const data = typeof json['data'] === 'object' && json['data'] !== null ? json['data'] as Record<string, unknown> : {}
  const inner = typeof data['response_data'] === 'object' && data['response_data'] !== null ? data['response_data'] as Record<string, unknown> : data
  const id = ['id', 'ts', 'messageId', 'message_id', 'threadId'].map((k) => inner[k] ?? data[k]).find((v) => typeof v === 'string' && v !== '')
  return { state: 'sent', result: typeof id === 'string' ? id : 'sent' }
}

function learnedOutcome(result: string): SendOutcome {
  // The learned app answers with a JSON object, sometimes after a short label line: read the first object.
  const start = result.indexOf('{')
  const json = start < 0 ? null : parse(result.slice(start, result.lastIndexOf('}') + 1))
  if (json === null) return { state: 'unknown' }
  if (json['ok'] === false) return { state: 'failed' }
  const permalink = json['permalink']
  if (typeof permalink === 'string' && /^https:\/\/[^/]+\.slack\.com\//.test(permalink)) return { state: 'sent', result: permalink }
  const file = json['file_id'] ?? json['fileId'] ?? json['ts']
  return json['ok'] === true ? { state: 'sent', result: typeof file === 'string' ? file : 'sent' } : { state: 'unknown' }
}
