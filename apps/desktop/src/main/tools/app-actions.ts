/**
 * One way for the agent to do anything the window can do (rule of 22 Oct 2026: "anything I can do on the UI, the
 * agent needs to be able to do, somewhere or somehow"). Every button, switch, menu, dialog and form in the window
 * reaches the main process through one IPC channel (preload/index.ts). `app_action` calls the same handler by its
 * method name (`devices.offer`, `workers.restart`, `browser.go`...), and `app_actions` lists them.
 *
 * Each method has ONE line in APP_ACTION_POLICY:
 *  - free:  the agent calls it straight away (it changes nothing outside this app, or only what the person asked for).
 *  - ask:   the person sees an approval card with the exact call first (deleting, signing in or out, anything that
 *           carries a key or password: those values are hidden on the card and in the answer).
 *  - tool:  a dedicated tool does it better (settings_set keeps its own guards).
 *  - no:    only the person can do it (answering the agent's own approvals, the microphone, the window's own plumbing),
 *           with the reason.
 * test/app-actions.test.ts fails when the preload calls a channel that has no line here.
 */
import { schema, str, type JsonObject, type Tool } from '@agent/core'

import { RPC_CHANNELS } from '../../shared/rpc-methods'
import { WORKER_CHANNELS } from '../../shared/workers-channels'

export interface AppActionRule {
  kind: 'free' | 'ask' | 'tool' | 'no'
  /** What it does, as the person would say it (the button or place in the window). */
  about: string
  /** The arguments, in order. */
  args?: string
  /** For kind 'no': why only the person can. */
  why?: string
  /** For kind 'tool': the tool to use instead. */
  tool?: string
  /** Positions of arguments that are secrets: hidden on the approval card and in the answer. */
  secretArgs?: number[]
  /** The first argument must be one of these (data.upsert: only rows the window's forms edit). */
  firstArgIn?: readonly string[]
}

/**
 * The rows the window's forms create, change and delete. Chat items, turns, devices, device commands and turn leases
 * are the app's own bookkeeping: writing them by hand could forge an approval or a device, so they have their own
 * tools and buttons (devices.*, chat.*).
 */
export const EDITABLE_ENTITIES = ['memory', 'goal', 'task', 'trigger', 'project'] as const

/** Dotted method name (as in the window's `agent.<area>.<method>`) to its IPC channel. */
export const APP_ACTION_CHANNELS: Readonly<Record<string, string>> = {
  ...RPC_CHANNELS,
  ...Object.fromEntries(Object.entries(WORKER_CHANNELS).map(([key, channel]) => [`workers.${key}`, channel])),
}

const free = (about: string, args?: string): AppActionRule => ({ kind: 'free', about, ...(args === undefined ? {} : { args }) })
const ask = (about: string, args?: string, secretArgs?: number[]): AppActionRule => ({
  kind: 'ask',
  about,
  ...(args === undefined ? {} : { args }),
  ...(secretArgs === undefined ? {} : { secretArgs }),
})
const no = (about: string, why: string): AppActionRule => ({ kind: 'no', about, why })
const tool = (about: string, name: string): AppActionRule => ({ kind: 'tool', about, tool: name })

const WINDOW_PLUMBING = 'the window uses it to draw itself; it does nothing on its own'
const PERSON_ANSWERS = "it is the person's own answer to the agent; the agent never answers itself"
const MICROPHONE = "it needs the person's microphone in the window"

export const APP_ACTION_POLICY: Readonly<Record<string, AppActionRule>> = {
  // Settings
  'settings.get': free('Read all settings (Settings)'),
  'settings.save': tool('Change settings (Settings)', 'settings_set'),
  'settings.providers': free('The AI providers the app knows (Settings > AI)'),
  'settings.setApiKey': ask('Save the AI key (Settings > AI > key)', 'key', [0]),
  'settings.checkKey': free('Check the AI key works (Settings > AI > Check)'),
  'settings.listModels': free('List the models the AI key can use (Settings > AI)'),
  'settings.checkCli': free('Check the command-line AI is installed and signed in (Settings > AI)'),
  'settings.cliLogin': ask('Sign in to the command-line AI (Settings > AI > Sign in)'),
  'settings.reset': ask('Reset the app: forget everything (Settings > Reset)'),
  'settings.accounts.add': ask('Add an AI account (Settings > AI > Add account)', '{ kind, name, provider, model, ... }'),
  'settings.accounts.update': ask('Change an AI account (Settings > AI > account)', 'accountId, { name?, model?, ... }'),
  'settings.accounts.remove': ask('Remove an AI account (Settings > AI > account > Remove)', 'accountId'),
  'settings.accounts.setKey': ask("Save an AI account's key (Settings > AI > account > key)", 'accountId, key', [1]),
  'settings.accounts.check': free('Check an AI account works (Settings > AI > account > Check)', 'accountId'),
  'settings.accounts.listModels': free("List an AI account's models", 'accountId'),
  'settings.accounts.signIn': ask('Sign in an AI account (Settings > AI > account > Sign in)', 'accountId'),
  'settings.accounts.chatBrain': free('Which AI answers in a chat', 'chatId'),
  // Sync account
  'account.signIn': ask('Sign in to sync (Settings > Account)', '{ email, password, ... }', [0]),
  'account.signOut': ask('Sign out of sync (Settings > Account > Sign out)'),
  'account.firstSync': ask('Run the first sync after signing in (Settings > Account)'),
  'account.syncNow': free('Sync now (Settings > Account > Sync now)'),
  'account.status': free('Sync status (Settings > Account)'),
  // Rows: tasks, goals, routines, memories, projects, chats...
  'data.list': free('List rows of a kind: task, goal, routine, memory, project, chat, profile... (every list view)', 'entity'),
  'data.get': free('Read one row', 'entity, id'),
  'data.upsert': { ...free('Create or change a row (every edit form: task, goal, trigger = routine, project, memory)', 'entity, row'), firstArgIn: EDITABLE_ENTITIES },
  'data.remove': { ...ask('Delete a row (every Delete button: task, goal, trigger = routine, project, memory)', 'entity, id'), firstArgIn: EDITABLE_ENTITIES },
  // Chat
  'chat.send': free('Send a message into a chat (main, a project chat, a quick chat)', 'text, attachments[], chatId'),
  'chat.stop': free('Stop a chat that is working (Stop button)', 'chatId'),
  'chat.state': free('Is a chat working, and what is it waiting on', 'chatId'),
  'chat.states': free('Every chat that is working now'),
  'chat.branch': free('Start a new chat from a message (Branch)', 'itemId'),
  'chat.answer': no('Answer a question card', PERSON_ANSWERS),
  'chat.decide': no('Approve or decline an approval card', PERSON_ANSWERS),
  'chat.tap': no('Tap a button on a card', PERSON_ANSWERS),
  // Routines
  'routines.runNow': free('Run a routine now (Routines > Run now)', 'routineId'),
  // Browser panel
  'browser.setBounds': no('Where the browser panel sits', WINDOW_PLUMBING),
  'browser.state': free('The browser panel: tabs, address, who is driving'),
  'browser.back': free('Browser panel: Back'),
  'browser.reload': free('Browser panel: Reload'),
  'browser.selectTab': free('Browser panel: pick a tab', 'tabId'),
  'browser.closeTab': free('Browser panel: close a tab', 'tabId'),
  'browser.takeOver': free('Browser panel: Take over (the person drives)'),
  'browser.giveBack': free('Browser panel: Give back (the agent drives)'),
  'browser.openInSystem': free("Browser panel: open the page in the computer's own browser"),
  'browser.setView': free('Browser panel: desktop, phone or fit view', 'mode'),
  'browser.setExpanded': free('Browser panel: expand or shrink', 'on'),
  'browser.frame': free('Browser panel: a picture of the page (data URL)'),
  'browser.go': free('Browser panel: go to an address', 'address'),
  'browser.newTab': free('Browser panel: new tab'),
  'browser.attach': no('Join a tab to the panel', WINDOW_PLUMBING),
  'browser.devtools': free('Browser panel: open developer tools'),
  'browser.setMuted': free('Browser panel: mute or unmute', 'on'),
  'browser.people': free('Browser panel: the signed-in browser profiles'),
  'browser.usePerson': free('Browser panel: switch browser profile', 'profileId'),
  'browser.signOut': ask('Browser panel: sign a browser profile out (clears its cookies)', 'profileId'),
  // Helpers
  'helpers.stop': free('Stop a helper (its card > Stop)', 'helperId'),
  'helpers.stopAll': free('Stop every helper'),
  'helpers.cards': free('The helper and project-agent cards in the side panel'),
  // Connected apps
  'apps.status': free('Connected apps and accounts (Connections)'),
  'apps.setKey': ask('Save the connected-apps key (Connections > key)', 'key', [0]),
  'apps.catalog': free('Apps that can be connected (Connections > Add)'),
  'apps.search': free('Search apps to connect', 'query'),
  'apps.connect': free('Connect an app: opens its sign-in for the person (Connections > Connect)', 'appSlug'),
  'apps.disconnect': ask('Disconnect an account (Connections > account > Disconnect)', 'accountId'),
  'apps.setRules': ask("Change what the agent may do in an account (Connections > account > rules)", 'accountId, { read, write }'),
  'apps.learned': free('The web apps the agent taught itself'),
  'apps.removeLearned': ask('Remove a learned web app', 'appId'),
  'apps.setTrusted': ask("Trust a learned web app (its changing tools stop asking)", 'appId, trusted'),
  // Profiles
  'profiles.list': free('Profiles (Profiles)'),
  'profiles.create': free('Create a profile (Profiles > New)', '{ name, color, ... }'),
  'profiles.update': free('Rename or recolour a profile', 'profileId, { name?, color?, ... }'),
  'profiles.remove': ask('Delete a profile', 'profileId'),
  'profiles.setMember': ask('Put an account in a profile or take it out (changes which accounts its agents may use)', 'profileId, accountId, member'),
  // Window
  'window.minimize': free('Minimise the window'),
  'window.toggleMaximize': free('Maximise or restore the window'),
  'window.close': ask('Close the window'),
  'window.isMaximized': free('Is the window maximised'),
  'window.show': free(
    'Put a view on screen as tapping it does: a chat in full at its newest message, cursor in the box ({ view: "chat", id: chatId, "" for the main chat }), a helper\'s own view ({ view: "helper", id: helperId }), a page ({ view: "settings" }, { view: "project", id }) or Back ({ view: "back" })',
    '{ view, id }',
  ),
  // Files
  'files.pick': tool('Pick files with the system picker', 'files_pick'),
  'files.pickFolder': no('Pick a folder with the system picker', 'the picker is for the person; the agent passes a folder path straight to what needs it'),
  'files.register': no('Note files dropped on the window', WINDOW_PLUMBING),
  'files.thumbnail': free('A small picture of a file', 'path'),
  'files.savePasted': no('Save something pasted into the chat box', 'it takes the bytes the person pasted; the agent writes files with its file tools'),
  'files.clipboardFiles': free('Files on the clipboard'),
  'system.info': free('This computer: system, memory, disk'),
  'environment.scan': free('What is installed on this computer (Settings > Environment)', 'refresh'),
  'shell.openExternal': free("Open a link in the computer's browser", 'url'),
  'shell.reveal': free('Show a file in its folder', 'path'),
  // Voice
  'voice.setKey': ask('Save the voice key (Settings > Voice)', 'key', [0]),
  'voice.check': free('Check voice works (Settings > Voice > Check)'),
  'voice.transcribe': no('Turn recorded speech into text', MICROPHONE),
  'voice.speak': tool('Speak text aloud', 'voice_note'),
  'voice.noteAudio': no('Play a voice note in the chat', 'the window fetches the sound to play it; the agent makes notes with voice_note'),
  'voice.liveToken': no('A one-use token for a live call', 'the window spends it the moment a call opens'),
  'voice.callSave': no('Save a finished call into the chat', 'the window saves it when a call ends'),
  'voice.callTargets': no('List who a live call can hand work to', 'the call screen reads it while a call is open; the agent already knows its chats and helpers'),
  'voice.callHandoff': no('Hand work from a live call to an agent', 'the voice on a call does it; the agent itself delegates with its own tools'),
  'voice.callStart': no('Start a voice call', MICROPHONE),
  'voice.callAudio': no('Stream call audio', MICROPHONE),
  'voice.callMute': free('Mute or unmute the call', 'muted'),
  'voice.callEnd': free('End the call'),
  // Hotkeys and dictation
  'hotkeys.status': free('Hotkeys and whether each works (Settings > Hotkeys)'),
  'hotkeys.pause': free('Pause or resume the hotkeys', 'paused'),
  'dictation.audio': no('Stream dictation audio', MICROPHONE),
  'dictation.micState': no('Report whether the microphone opened', MICROPHONE),
  'dictation.stop': no('Stop dictating', MICROPHONE),
  'dictation.ready': no('The dictation pill is ready', WINDOW_PLUMBING),
  'dictation.toggle': no('Start or stop dictating', MICROPHONE),
  'dictation.cancel': no('Cancel dictating', MICROPHONE),
  'dictation.retry': no('Try the last dictation again', MICROPHONE),
  // About
  'app.info': free('This app: version, folders (Settings > About)'),
  'app.openLogsFolder': free('Open the logs folder (Settings > About)'),
  'app.openLicences': free('Open the licences (Settings > About)'),
  // Memory
  'memory.newChat': free('New chat: save this one to memory and start fresh', '{ chat, from }?'),
  'memory.retrySave': free('Try saving a chat to memory again', 'dividerId'),
  'memory.pickImport': no('Pick a memory file to import', 'the picker is for the person; the agent passes the path to memory.previewImport'),
  'memory.previewImport': free('Preview importing memories from a file (Memory > Import)', 'path, includeAll'),
  'memory.runImport': ask('Import memories from a file (Memory > Import)', 'path, includeAll'),
  'memory.searchChats': free('Search past chats', 'query, limit'),
  'memory.runDaily': free('Run the daily memory upkeep now (Memory > Run now)'),
  'memory.upkeep': free('The last memory upkeep (Memory)'),
  'memory.undoChange': free('Undo one upkeep change', 'changeId'),
  'memory.history': free("A memory page's versions", 'memoryId'),
  'memory.restoreVersion': free('Restore a memory page to a version', 'memoryId, version'),
  'memory.previewTidy': free('Preview tidying memory from a file (Memory > Tidy)', 'path, includeAll'),
  'memory.startTidy': ask('Tidy memory (rewrites many pages)', 'path, includeAll'),
  'memory.stopTidy': free('Stop tidying memory'),
  'memory.tidyState': free('How the memory tidy is going'),
  'memory.undoTidy': ask('Undo the memory tidy'),
  // Devices
  'devices.status': free('Devices: on or off, addresses, firewall (Settings > Devices)'),
  'devices.setEnabled': free('Switch Devices on or off', 'on'),
  'devices.setExtraUrls': free('Extra addresses for this computer', 'urls[]'),
  'devices.setNetwork': ask('Devices network: none, Tailscale and the like (Settings > Devices > Network)', '{ mode, authKey? }', [0]),
  'devices.offer': free('Add a device: make a pairing link and short code'),
  'devices.cancelOffer': free('Cancel the pairing offer'),
  'devices.list': free('Linked devices'),
  'devices.setRoles': free("Set a device's roles", 'deviceId, roles[]'),
  'devices.move': free('Move a device up or down the answer order', "deviceId, 'up'|'down'"),
  'devices.revoke': free('Take a device out', 'deviceId'),
  'devices.forget': free("Delete a taken-out device's row", 'deviceId'),
  'devices.join': free("Join another node's devices from its pairing link (Settings > Devices > Join with a link)", 'link, takeSettings'),
  'devices.setShareGroup': free('What other devices may use here', 'group, on'),
  'devices.allowFirewall': free('Let other devices through Windows Firewall (ONE Windows prompt the person must accept; tell them first)'),
  // Workers
  'workers.list': free('Background workers (Workers)'),
  'workers.events': free("Workers' events", 'workerId?, limit?'),
  'workers.logs': free("A worker's log", 'workerId, limit?'),
  'workers.start': free('Start a worker', 'workerId'),
  'workers.stop': free('Stop a worker', 'workerId'),
  'workers.restart': free('Restart a worker', 'workerId'),
  'workers.remove': ask('Delete a worker', 'workerId'),
  'workers.setSecret': ask("Set a worker's key (Workers > worker > keys)", 'workerId, name, value', [2]),
  'workers.openFolder': free("Open a worker's folder", 'workerId'),
  // The Vault (Settings > Vault): names only; values go in through vault_save and out only through vault_reveal.
  'vault.list': free('What is in the Vault, without values (Settings > Vault)'),
  'vault.save': tool('Add or change a vault item (Settings > Vault)', 'vault_save'),
  'vault.remove': ask('Delete a vault item (Settings > Vault > Delete)', 'itemId'),
  'vault.reveal': tool('See a vault value (Settings > Vault > Show)', 'vault_reveal'),
  'vault.copy': no('Copy a vault value (Settings > Vault > Copy)', "it puts a secret on the person's clipboard; use a placeholder or vault_fill"),
  'vault.audit': free('Who showed or copied what (Settings > Vault > History)', 'limit?'),
  'vault.prefs': free('When the Vault asks (Settings > Vault)'),
  'vault.setPrefs': ask('Change when the Vault asks (Settings > Vault switches)', 'patch'),
  'vault.importAos': free('Import the A.O.S credential vault (Settings > Vault > Import from A.O.S)', 'folder?'),
}

/** Calls the app's own IPC handlers (main/devices/registry.ts keeps them all). */
export interface AppActionInvoker {
  has(channel: string): boolean
  invoke(channel: string, args: unknown[]): Promise<unknown>
}

/** The stand-in event a handler gets when the agent calls it: no window, like a call from another device. */
export const AGENT_EVENT = Object.freeze({ sender: null, agent: true })

/** An invoker over a handler registry (desktop and headless both keep one). */
export function registryInvoker(registry: { get(channel: string): ((event: unknown, ...args: unknown[]) => unknown) | null }): AppActionInvoker {
  return {
    has: (channel) => registry.get(channel) !== null,
    invoke: async (channel, args) => {
      const handler = registry.get(channel)
      if (handler === null) throw new Error('not available')
      return handler(AGENT_EVENT, ...args)
    },
  }
}

export interface AppActionDeps {
  invoker: () => AppActionInvoker | null
}

const MAX_ANSWER = 8000
const HIDDEN = '[hidden]'

function hideSecrets(args: unknown[], rule: AppActionRule): unknown[] {
  if (rule.secretArgs === undefined) return args
  return args.map((value, i) => (rule.secretArgs?.includes(i) === true ? HIDDEN : value))
}

/** Every string in a secret argument, so the answer never carries it back. */
function secretStrings(args: unknown[], rule: AppActionRule): string[] {
  const out: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string' && value.length >= 4) out.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(walk)
  }
  for (const i of rule.secretArgs ?? []) walk(args[i])
  return out
}

function show(value: unknown): string {
  if (value === undefined || value === null) return 'Done.'
  const text = JSON.stringify(
    value,
    (_key, item: unknown) => (item instanceof Uint8Array ? `[${item.length} bytes]` : item),
    2,
  )
  return text.length > MAX_ANSWER ? `${text.slice(0, MAX_ANSWER)}\n... (cut, ${text.length} characters in all)` : text
}

function areaOf(method: string): string {
  return method.split('.')[0] ?? method
}

function listText(area: string): string {
  const wanted = area.trim().toLowerCase()
  const methods = Object.keys(APP_ACTION_POLICY).filter((method) => wanted === '' || areaOf(method) === wanted)
  if (methods.length === 0) return `No area "${area}". Areas: ${[...new Set(Object.keys(APP_ACTION_POLICY).map(areaOf))].join(', ')}.`
  const lines = methods.map((method) => {
    const rule = APP_ACTION_POLICY[method] as AppActionRule
    const how = rule.kind === 'free' ? '' : rule.kind === 'ask' ? ' [asks the person first]' : rule.kind === 'tool' ? ` [use the ${rule.tool} tool]` : ` [person only: ${rule.why}]`
    return `- ${method}(${rule.args ?? ''}): ${rule.about}${how}`
  })
  return [`App actions${wanted === '' ? '' : ` in ${wanted}`} (call with app_action { method, args: [...] }):`, ...lines].join('\n')
}

function listTool(): Tool {
  return {
    spec: {
      name: 'app_actions',
      description:
        "List what app_action can do: every button, switch, menu and form in this app's window, by method name with its arguments (settings, account, data, chat, routines, browser, helpers, apps, profiles, window, files, voice, hotkeys, app, memory, devices, workers). area: only that part.",
      schema: schema([], { area: str('Only this area, e.g. devices') }),
    },
    run: async (input) => listText(typeof input['area'] === 'string' ? input['area'] : ''),
  }
}

function actionTool(deps: AppActionDeps): Tool {
  return {
    spec: {
      name: 'app_action',
      description:
        "Do anything the person can do in this app's window, by its method name (see app_actions): e.g. devices.offer, devices.join ['agent://pair?...'], workers.restart ['w_ab12'], browser.go ['https://...'], data.upsert ['routine', {...}], helpers.stop ['h_1']. args are the method's arguments in order. Deleting, signing in or out, and anything carrying a key asks the person first; answering your own approval cards and the microphone are the person's only.",
      schema: schema(['method'], { method: str('Method name, e.g. devices.offer'), args: { type: 'array', description: 'Arguments in order', items: {} } as JsonObject }),
    },
    run: async (input, ctx) => {
      const method = typeof input['method'] === 'string' ? input['method'].trim().replace(/^agent\./, '') : ''
      const rule = APP_ACTION_POLICY[method]
      const channel = APP_ACTION_CHANNELS[method]
      if (rule === undefined || channel === undefined) return `There is no app action "${method}". app_actions lists them.`
      if (rule.kind === 'no') return `${method} is not for the agent: ${rule.why}.`
      if (rule.kind === 'tool') return `Use the ${rule.tool} tool for that (${rule.about}).`
      const args = Array.isArray(input['args']) ? (input['args'] as unknown[]) : input['args'] === undefined ? [] : [input['args']]
      if (rule.firstArgIn !== undefined && !rule.firstArgIn.includes(String(args[0]))) return `${method} works on ${rule.firstArgIn.join(', ')} only; "${String(args[0])}" has its own tools.`
      const invoker = deps.invoker()
      if (invoker === null || !invoker.has(channel)) return `${method} is not available here (this app has no ${areaOf(method)} part running).`
      if (rule.kind === 'ask') {
        const shown = hideSecrets(args, rule)
        const yes = await ctx.approve(`${rule.about}`, `app_action ${method}(${shown.map((arg) => JSON.stringify(arg)).join(', ')})`)
        if (!yes) return `The person said no; ${method} was not done.`
      }
      let answer: string
      try {
        answer = show(await invoker.invoke(channel, args))
      } catch (error) {
        answer = `${method} failed: ${error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error)}`
      }
      for (const secret of secretStrings(args, rule)) answer = answer.split(secret).join(HIDDEN)
      return answer
    },
  }
}

/** app_actions and app_action. */
export function appActionTools(deps: AppActionDeps): Tool[] {
  return [listTool(), actionTool(deps)]
}
