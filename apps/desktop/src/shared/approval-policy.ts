/**
 * Who may answer a card: the person, or the main agent on his behalf ("Agent acts for me on approvals", 23 Nov 2026).
 *
 * The lane is decided HERE, by code, from what the app itself stamped on the card: who asked (the run, never a name
 * the agent chose) and the real tool call behind it (the tool name the loop dispatched and its arguments). The words
 * an agent writes on the card (summary, details, question) are never what puts a card in the agent's lane; for a
 * tool that asks in its own words (request_approval, ask_user) they can only move a card TO the person.
 *
 *   ALWAYS HIM   text sent to people (Slack, mail, WhatsApp, SMS, posts, comments, a file or link sent to someone),
 *                money, his own hands (passkey, phone tap, card, sign-ins, 2FA), secrets, and anything unknown.
 *   AGENT LANE   deploys, migrations, settings, deletes inside a task he set, sign-ups, helper and project questions.
 *   NEVER MAIN'S the main agent's own cards (asker main), a connected device's, or one with no stamped origin.
 *
 * Pure: no electron, no store. The same function runs in the main process, the headless node and the tests.
 */

export type Asker = 'main' | 'helper' | 'project' | 'routine' | 'device' | 'unknown'
export type Lane = 'him' | 'agent'

/** The tool call behind a card, as the app stamped it. */
export interface CardOrigin {
  tool: string
  input: Record<string, unknown>
}

export interface CardFacts {
  kind: 'approval' | 'question'
  asker: Asker
  origin?: CardOrigin | undefined
  /** What the agent wrote on the card. Only ever used to send a card to the person, never to hand one to the agent. */
  summary: string
  details?: string
  options?: string[]
}

export interface Verdict {
  lane: Lane
  /** A short code: outbound, money, hands, secret, destructive-outside, own-card, unknown, or an agent-lane kind. */
  rule: string
  /** One line for the Answered for you list and for refusals. */
  why: string
}

/** Askers whose cards the main agent may answer: work he set (helpers, project chats, routines). */
export const TASK_ASKERS: readonly Asker[] = ['helper', 'project', 'routine']

const HIM = (rule: string, why: string): Verdict => ({ lane: 'him', rule, why })
const AGENT = (rule: string, why: string): Verdict => ({ lane: 'agent', rule, why })

// ---- vocabulary ----------------------------------------------------------------------------------------------

/** Writing to people. */
const SEND_WORDS = /\b(send|sends|sending|sent|post|posts|posting|publish|reply|replies|replying|comment|comments|message|messages|messaging|dm|dms|e-?mail|e-?mails|mail|whatsapp|sms|text message|texts|tweet|tweets|share|shares|sharing|invite|invites|forward|broadcast|announce|slack|telegram|discord|linkedin|instagram|facebook|tiktok)\b/i
/** Costing money. */
const MONEY_WORDS = /\b(pay|paid|payment|payments|purchase|purchases|buy|buying|bought|checkout|subscribe|subscription|billing|invoice|credits|top[- ]?up|refund|charge|charged|credit card|debit card|bank card|company card|cvv|iban|eft|bank transfer|wire transfer|upgrade (?:the |your )?(?:plan|subscription))\b|\bUS\$|\bR\s?\d|\$\s?\d/i
/** His own hands: only he can do these. */
const HANDS_WORDS = /(passkey|2fa|two[- ]factor|one[- ]time|verification code|\botp\b|captcha|sign[- ]?in|log[- ]?in|\bpassword|on my phone|your phone|phone tap|step[- ]?up|biometric|fingerprint|card number|needs you in the browser|your turn|done, carry on)/i
/** Secrets and keys: a person's call. */
const SECRET_WORDS = /\b(api[- ]?key|secret|secrets|token|credentials?|private key|env(?:ironment)? var(?:iable)?s?|\.env|connection string)\b/i
/** What an agent-lane card is about, for a tool that asks in its own words. */
const SAFE_WORDS = /\b(deploy|deployment|redeploy|release|migrat(?:e|ion|ions)|merge|install|uninstall|delete|remove|recycle|drop|clean(?:up)?|tidy|rename|move|restart|stop|start|create|set up|setting|settings|configure|enable|disable|switch|turn (?:on|off)|proceed|continue|go ahead|rebuild|run|build|commit|push|prune|wipe|reset|account|register|folder|file|database|container|branch|project)\b/i

/** A message in a messaging app's name: any write there is text to a person. */
const MESSAGING_TOOLKITS = new Set([
  'GMAIL', 'OUTLOOK', 'SLACK', 'SLACKBOT', 'WHATSAPP', 'TELEGRAM', 'DISCORD', 'TWITTER', 'X', 'LINKEDIN', 'FACEBOOK', 'INSTAGRAM', 'YOUTUBE', 'TIKTOK', 'REDDIT',
  'MICROSOFT_TEAMS', 'MICROSOFTTEAMS', 'TEAMS', 'TWILIO', 'SENDGRID', 'MAILCHIMP', 'MAILGUN', 'RESEND', 'INTERCOM', 'ZENDESK', 'FRESHDESK', 'HUBSPOT', 'SALESFORCE', 'MAILERLITE',
  'BREVO', 'POSTMARK', 'CLICKSEND', 'SIGNAL', 'THREADS', 'MASTODON', 'BLUESKY', 'PINTEREST', 'MEDIUM', 'WORDPRESS', 'CALENDLY', 'ZOOM',
])
const SEND_ACTION = /(SEND|POST|REPLY|REPLIES|COMMENT|PUBLISH|SHARE|FORWARD|INVITE|MESSAGE|MSG|SMS|DM|NOTIFY|BROADCAST|TWEET|CAMPAIGN|UPLOAD_MEDIA|UPLOAD_VIDEO|MENTION|REPOST|RETWEET|CHAT|TEXT)/
const MONEY_ACTION = /(PAY|PAYMENT|CHARGE|PURCHASE|ORDER|CHECKOUT|SUBSCRIBE|SUBSCRIPTION|REFUND|TRANSFER|PAYOUT|BUY|TOPUP|TOP_UP|BILLING|CREDIT)/
const CLEANUP_ACTION = /(DELETE|REMOVE|TRASH|ARCHIVE|PURGE|DESTROY|DROP|CLEAR|RECYCLE|UNSUBSCRIBE|LABEL|MARK_|MOVE_TO)/
const SAFE_ACTION = /(DELETE|REMOVE|TRASH|ARCHIVE|PURGE|RECYCLE|CREATE|UPDATE|ADD|EDIT|MOVE|RENAME|UPLOAD|COPY|DEPLOY|MERGE|CLOSE|ASSIGN|SET|SYNC|IMPORT|RESTORE|LABEL|MARK|PATCH|PUSH|CANCEL|REDEPLOY|PROMOTE|ROLLBACK)/

/** Messaging and publishing hosts: any write to them is text going out. */
const SEND_HOSTS = /(slack\.com|hooks\.slack|api\.telegram\.org|discord(?:app)?\.com|api\.twilio\.com|graph\.facebook\.com|graph\.instagram\.com|api\.twitter\.com|api\.x\.com|twitter\.com|x\.com|api\.linkedin\.com|linkedin\.com|graph\.microsoft\.com|outlook\.office|gmail\.googleapis\.com|api\.sendgrid|api\.mailgun|api\.resend|api\.postmarkapp|whatsapp|wa\.me|api\.reddit|oauth\.reddit|reddit\.com|tiktok|youtube\.com|zernio|bsky|mastodon|threads\.net|teams\.microsoft)/i
const SEND_PATH = /(chat\.|conversations\.|\/messages?\b|\/send|\/post\b|\/posts\b|\/comment|\/reply|\/replies|\/publish|\/share|\/tweet|\/ugcPosts|\/statuses|\/sendMail|\/invite|\/dm\b|\/chats\b)/i

/** A command that sends. */
const SEND_COMMAND = /\b(sendmail|mailx?|mutt|ssmtp|msmtp|swaks)\b|chat\.postMessage|hooks\.slack\.com|api\.telegram\.org|discord(?:app)?\.com\/api|api\.twilio\.com|graph\.facebook\.com|api\.twitter\.com|api\.x\.com|api\.linkedin\.com|\bgh\s+(?:pr|issue)\s+(?:comment|review)\b|\bgh\s+api\b[^\n]*(?:comments|messages|reviews)|wa\.me|api\.sendgrid|api\.mailgun|api\.resend\.com|\/sendMail|chat\.update/i
/** A network write: could be anything going out, so it is his. */
const NET_WRITE = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|requests\.(?:post|put|patch))\b[^\n]*(?:-X\s*(?:POST|PUT|PATCH)|--request\s*(?:POST|PUT|PATCH)|\s-d\s|--data|--json|\s-F\s|--form|-Method\s*(?:Post|Put|Patch)|-Body\b)/i
const MONEY_COMMAND = /\b(stripe|paypal|paystack|payfast|yoco|wise\.com)\b|\/charges\b|\/payments\b/i
const DESTRUCTIVE = /\b(rm\s+-[a-z]*[rf]|rm\s+--recursive|rmdir\s+\/s|del\s+\/[sq]|Remove-Item\b[^\n]*-Recurse|rd\s+\/s|format\s+[a-z]:|mkfs|diskpart|dd\s+if=|git\s+push\b[^\n]*(?:--force|\s-f\b)|git\s+reset\s+--hard|drop\s+(?:database|schema)|truncate\s+table)/i

// ---- helpers -------------------------------------------------------------------------------------------------

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function allText(facts: CardFacts): string {
  return [facts.summary, facts.details ?? '', ...(facts.options ?? [])].join('\n')
}

function httpMethod(input: Record<string, unknown>): string {
  return (str(input['method']) || 'GET').toUpperCase()
}

/** A place no task owns: root, a home folder itself, a drive, a system folder, everything. */
export function isBroadPath(raw: string): boolean {
  const path = raw.trim().replace(/^["']|["']$/g, '')
  if (path === '') return true
  const flat = path.replace(/\\/g, '/').replace(/\/+$/, '')
  if (flat === '' || flat === '~' || flat === '*' || flat === '/*' || flat === '.' || flat === '..') return true
  if (/^\$HOME$|^%USERPROFILE%$|^\$\{HOME\}$|^[a-z]:$/i.test(flat)) return true
  if (/^(?:\/(?:etc|usr|var|bin|sbin|boot|root|opt|lib|lib64|sys|proc|dev)|[a-z]:\/(?:windows|program files(?: \(x86\))?|programdata))(?:\/|$)/i.test(flat)) return true
  if (/^(?:\/home|\/mnt\/[a-z]|[a-z]:\/users)\/[^/]+(?:\/\*)?$/i.test(flat)) return true
  return false
}

/** Whether a destructive command names a place no task owns. */
export function aimsOutside(command: string): boolean {
  const words = command.split(/\s+/).filter((word) => word !== '')
  return words.slice(1).some((word) => !word.startsWith('-') && !/^\/[sq]$/i.test(word) && /[/\\~*$%:]|^\.\.?$/.test(word) && isBroadPath(word))
}

/** Text on a card in a tool's own words, screened for what only the person may do. Returns a verdict to him, or null. */
function screen(text: string): Verdict | null {
  if (SEND_WORDS.test(text)) return HIM('outbound', 'It sends or posts something to a person.')
  if (MONEY_WORDS.test(text)) return HIM('money', 'It spends or concerns money.')
  if (HANDS_WORDS.test(text)) return HIM('hands', 'It needs his own hands (a sign-in, passkey, code, phone or card).')
  if (SECRET_WORDS.test(text)) return HIM('secret', 'It handles a secret or a key.')
  return null
}

function commandVerdict(command: string): Verdict {
  if (SEND_COMMAND.test(command)) return HIM('outbound', 'The command sends a message or post.')
  if (NET_WRITE.test(command)) return HIM('outbound', 'The command writes to a web address, which may send something out.')
  if (MONEY_COMMAND.test(command)) return HIM('money', 'The command touches a payment service.')
  if (DESTRUCTIVE.test(command) && aimsOutside(command)) return HIM('destructive-outside', 'A destructive command aimed outside any task folder.')
  return AGENT('command', 'A command on this computer inside a task he set.')
}

function pathVerdict(path: string, deleting: boolean): Verdict {
  if (deleting && isBroadPath(path)) return HIM('destructive-outside', 'A delete outside any task folder.')
  if (/(?:^|[\\/])(?:windows|system32|program files|etc|usr|boot)(?:[\\/]|$)/i.test(path)) return HIM('destructive-outside', 'A change to a system folder.')
  return AGENT('file', 'A file change inside a task he set.')
}

function appsRun(input: Record<string, unknown>): Verdict {
  const slug = str(input['slug']).toUpperCase()
  if (slug === '') return HIM('unknown', 'No action named.')
  const parts = slug.split('_')
  const toolkit = parts[0] ?? ''
  const kit2 = parts.slice(0, 2).join('_')
  const action = parts.slice(1).join('_')
  if (SEND_ACTION.test(action)) return HIM('outbound', 'The action sends or posts to a person.')
  if (MONEY_ACTION.test(action)) return HIM('money', 'The action concerns payment.')
  // A write in anyone's inbox or feed in the person's name is his, whatever the action is called.
  if (MESSAGING_TOOLKITS.has(toolkit) || MESSAGING_TOOLKITS.has(kit2)) {
    if (CLEANUP_ACTION.test(action)) return AGENT('cleanup', 'Tidying inside a mailbox or feed, nothing goes out.')
    return HIM('outbound', 'A write in a messaging or social account.')
  }
  if (SAFE_ACTION.test(action)) return AGENT(CLEANUP_ACTION.test(action) ? 'delete' : 'app-change', 'A change in a connected app inside a task he set.')
  return HIM('unknown', 'An action the app does not recognise.')
}

function webappRun(input: Record<string, unknown>): Verdict {
  const words = `${str(input['tool'])} ${str(input['description'])}`
  if (input['sends'] === true) return HIM('outbound', 'The saved tool sends something out.')
  if (SEND_WORDS.test(words)) return HIM('outbound', 'The saved tool sends or posts.')
  if (MONEY_WORDS.test(words)) return HIM('money', 'The saved tool concerns money.')
  if (HANDS_WORDS.test(words)) return HIM('hands', 'The saved tool needs his own hands.')
  if (SECRET_WORDS.test(words)) return HIM('secret', 'The saved tool handles a secret.')
  if (/\b(delete|remove|deploy|release|destroy|purge|trash|archive|restore|rename|move|update|create|add|sync|import)\b/i.test(words)) return AGENT('app-change', 'A saved site tool that changes things inside a task he set.')
  return HIM('unknown', 'A saved tool the app cannot tell is safe.')
}

function browserFetch(input: Record<string, unknown>): Verdict {
  const where = `${str(input['url'])} ${str(input['path'])}`
  const m = httpMethod(input)
  if (m === 'GET' || m === 'HEAD') return AGENT('read', 'A read.')
  if (SEND_HOSTS.test(where) || SEND_PATH.test(where)) return HIM('outbound', 'A write to a messaging or publishing address.')
  return HIM('outbound', 'A write to a web address; the app cannot show it is not a send.')
}

function settingsVerdict(input: Record<string, unknown>): Verdict {
  const values = typeof input['values'] === 'object' && input['values'] !== null ? (input['values'] as Record<string, unknown>) : {}
  const keys = Object.keys(values)
  if (keys.length === 0) return HIM('unknown', 'No setting named.')
  if (keys.includes('actsForMe')) return HIM('own-setting', 'Only he turns this on or off.')
  // How much the agent may do on this computer, or what a screen share shows, is the person's own boundary.
  if (keys.some((key) => ['shell', 'grantedFolders', 'agentRealInput', 'inputLockIdleSeconds', 'hideChatFromCapture', 'hideGuidesFromCapture', 'syncUrl', 'baseUrl', 'allowHttp'].includes(key))) {
    return HIM('own-setting', 'A boundary only he moves.')
  }
  return AGENT('setting', 'A change to an app setting.')
}

function appAction(input: Record<string, unknown>): Verdict {
  const method = str(input['method'])
  if (method === '') return HIM('unknown', 'No app action named.')
  if (/(signIn|signin|login|passkey|pair|offer|join|otp|totp|vault|secret|token|password|devices\.|workers\.secret)/i.test(method)) return HIM('hands', 'A sign-in, pairing or secret step.')
  if (/^(settings|accounts|ai)\./i.test(method)) return AGENT('setting', 'A settings change.')
  if (/^(helpers|projects|routines|workers|memory|data|apps|chat|profiles|files|window|browser|miniapps?)\./i.test(method)) return AGENT('app-change', 'An app action.')
  return HIM('unknown', 'An app action the app does not recognise.')
}

const SAFE_TOOLS_AGENT: Record<string, string> = {
  miniapp_delete: 'delete', miniapp_create: 'app-change', miniapp_update: 'app-change', webapp_remove: 'delete', webapp_save: 'app-change',
  worker_create: 'worker', worker_update: 'worker', worker_delete: 'delete', worker_control: 'worker',
  routine_create: 'app-change', routine_delete: 'delete', profile_create: 'app-change', project_create: 'app-change',
}

// ---- the verdict ---------------------------------------------------------------------------------------------

/** The one decision: whose card is this. Unknown is always the person's. */
export function classifyCard(facts: CardFacts): Verdict {
  if (!TASK_ASKERS.includes(facts.asker)) {
    return HIM('own-card', facts.asker === 'main' ? "It is the main agent's own card, so he decides." : 'It did not come from a task he set.')
  }
  const origin = facts.origin
  if (origin === undefined || origin.tool === '') return HIM('unknown', 'The app has no record of what this card is for.')
  const { tool, input } = origin

  switch (tool) {
    case 'apps_run':
      return appsRun(input)
    case 'webapp_run':
    case 'webapp_test':
      return webappRun(input)
    case 'browser_fetch':
    case 'web_fetch':
      return browserFetch(input)
    case 'send_file': {
      // Sent to one of his own linked devices: his. Anything addressed to someone else is a send.
      const to = [str(input['to']), str(input['recipient']), str(input['email']), str(input['channel']), str(input['url'])].join('')
      if (to !== '') return HIM('outbound', 'A file or link addressed to someone.')
      return AGENT('own-device', 'A file to one of his own devices.')
    }
    case 'open_url':
      return AGENT('own-device', 'A link opened on his own device.')
    case 'shell_run':
    case 'run_code':
    case 'Bash':
    case 'PowerShell':
      return commandVerdict(str(input['command']) || str(input['code']) || str(input['script']))
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'files_write':
    case 'files_move':
      return pathVerdict(str(input['file_path']) || str(input['path']) || str(input['notebook_path']) || str(input['to']), false)
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'LS':
    case 'files_read':
    case 'files_list':
    case 'files_find':
      return AGENT('read', 'A read.')
    case 'files_delete':
      return pathVerdict(str(input['path']), true)
    case 'settings_set':
      return settingsVerdict(input)
    case 'app_action':
      return appAction(input)
    case 'request_approval':
    case 'ask_user': {
      const text = allText(facts)
      const out = screen(text)
      if (out !== null) return out
      // A question for a decision he does not need to make: the agent that has the memory answers it.
      if (tool === 'ask_user') return AGENT('question', 'A helper or project question the main agent can answer from what it knows.')
      if (SAFE_WORDS.test(text)) return AGENT('approval', 'An approval for work inside a task he set.')
      return HIM('unknown', 'The app cannot tell what this approves.')
    }
    case 'vault_reveal':
    case 'vault_passkey':
    case 'vault_login':
    case 'vault_fill':
    case 'worker_secret_set':
      return HIM('hands', 'A secret or a passkey.')
    case 'browser_upload':
      return HIM('outbound', 'A file leaves this computer for a web page.')
    case 'app_update':
    case 'device_remove':
    case 'device_join':
      return HIM('own-setting', 'It changes the app or his devices.')
    default: {
      const known = SAFE_TOOLS_AGENT[tool]
      if (known !== undefined) return AGENT(known, 'A change inside a task he set.')
      return HIM('unknown', `The app does not know the tool ${tool}.`)
    }
  }
}
