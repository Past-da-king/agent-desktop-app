/**
 * Mini-apps for agents (docs/plans/mini-apps.md): miniapp_guide, miniapp_create, miniapp_update, miniapp_get,
 * miniapp_list, miniapp_open, miniapp_pin, miniapp_unpin, miniapp_undo, miniapp_check, miniapp_delete.
 *
 * An agent makes one when he asks for a dashboard, a tracker or a view of his data; it is saved as data (no app update),
 * refused if it draws in colours, fonts or radii of its own or reaches for the network, and looked at in light and
 * dark at 1440 and 390 wide before he is shown it. Deleting asks him first.
 */
import { MAIN_CHAT, bool, int, schema, str, strList, type JsonObject, type MiniAppCheck, type MiniAppRow, type Tool } from '@agent/core'

import type { DataStore } from '../runtime/data'
import type { DeviceCommands } from '../devices/commands'
import { latestOrigin } from '../devices/origin'
import { agentWriter } from '../memory/history'
import { MINIAPP_ICON_NAMES } from '../../shared/miniapps'
import { MiniAppStore, type MiniAppChange } from '../miniapps/store'

/** What only the desktop window can do: show an app, and look at it offscreen. Absent on the headless node. */
export interface MiniAppUi {
  open(app: MiniAppRow): Promise<void>
  check(app: MiniAppRow): Promise<MiniAppCheck>
}

export interface MiniAppToolDeps {
  store: DataStore
  knownTools?: () => ReadonlySet<string>
  ui?: () => MiniAppUi | null
  /**
   * The person's other devices (Devices on): miniapp_open opens the app on the device he wrote from (his phone), as
   * open_url does with a link. Absent: only this window.
   */
  devices?: { selfId: () => string; commands: () => DeviceCommands | null }
}

/** The link a chat card opens a mini-app with, on whichever device he taps it (the phone handles agent://miniapp/<id>). */
export function miniAppLink(app: { id: string; name: string }): string {
  return `[Open ${app.name.replace(/[[\]]/g, '')}](agent://miniapp/${app.id})`
}

export const MINIAPP_GUIDE = `# Making a mini-app

A mini-app is a small page the user opens from Apps (or the sidebar, when pinned): a dashboard, a tracker, a view of his data. It runs sandboxed: no network, no browser storage, nothing of the app except the agent bridge. It looks exactly like the app because it is drawn ONLY with the app's design tokens and kit, in light and dark and every accent.

## Files
index.html (required) plus any app.js, app.css, data.json, icon.svg (flat names, text only, 1 MB in all). The app's tokens.css, ui.css and the bridge are added to <head> for you: do not link them. Link your own files relatively (<script src="app.js"></script>, <link rel="stylesheet" href="app.css">). Inline <script> and <style> are fine.

## Look (enforced: the save is refused otherwise)
- Colours only as var(--token): --bg --on-bg --primary --on-primary --pc --on-pc --sc --on-sc --tert --tc --on-tc --err --ec --on-ec --ok --okc --on-ok --sv --on-sv --s-lowest --s-low --s-mid --s-high --s-highest --outline --outline-v; charts --chart-1..6. Tints: color-mix(in srgb, var(--primary) 16%, transparent). Never #hex, rgb(), hsl() or named colours, in CSS, inline styles, JS or SVG (fill/stroke = currentColor or a var).
- Font only var(--font) (or inherit; monospace for figures). Radii only var(--r-sm|md|lg|xl), 999px (pill), 50% or 0.
- Use the kit first: .head .h1 .h2 .h3 .eyebrow .muted .small .num .stack .row .row.between .grid .grid.two .card .card.mid .card.tonal .card.line .stat .btn .btn.fill .btn.line .btn.text .btn.sm .chip .chip.on .pill(.ok .warn .pri .err) .tabs>button(.on) .list>li (.grow) .table (.scroll-x around wide ones) .empty .progress>span .check (checkbox) .input .select .textarea .divider .dot(.ok .warn .err .mute) .bar-chart>span .hide-narrow. The body already has the sheet background and padding.
- It must work at 1440 and at 390 wide (phone): no horizontal scroll, wrap rows, stack columns, wide tables in .scroll-x.

## Data: only through the bridge
- await agent.call(tool, args): runs one of the app's own tools as the user's agent would; JSON results come back parsed. Only tools listed in permissions. Reads run; anything that changes something (task_update, memory_save...) asks the user on an approval card the first time unless he allowed it.
- Useful reads: task_list {format: "json", include_done: true} (goals and tasks as data), routine_list, memory_search, memory_get, calendar_events {from, to} (every connected calendar in one list; each event: id, title, start, end, where, joinUrl, organiser {name, email, self}, response accepted|tentative|declined|needsAction|none, calendar, account = the calendar account's email; declined ones are listed, filter them if the view should not show them), worker_events, recordings_list, apps_run with a granted slug ("apps_run:GOOGLECALENDAR_EVENTS_LIST" or "apps_run:*"), webapp_run ("webapp_run:<app>/<tool>").
- Never granted: web_fetch, shell, code, files_write, browser, vault, settings, devices, helpers, other mini-apps.
- agent.subscribe(topic, fn) while open: data.task, data.goal (need task_list), data.trigger (routine_list), data.memory, calendar.changed (calendar_events), worker.<id> (worker_events); list them in subscribe. agent.onRefresh(fn) fires every refresh_minutes while open.
- agent.ready(): call it once the first data is on the page (after the first agent.call answered and you drew it, or drew the error or .empty). The look check takes its screenshots at that moment; without it the check waits for your calls to be answered and the page to go still, at most 15 s.
- agent.store.get/set/remove/keys: the app's own small store (synced). agent.theme.get()/onChange(fn) if you draw on a canvas. agent.ask(text) hands a line to the user's agent.
- Handle errors: every agent.call can reject (he said no, not allowed); show it in the page, never a blank screen. Show .empty when there is nothing.

## Icon
One of: ${MINIAPP_ICON_NAMES.join(', ')}. Or a small <svg viewBox="0 0 24 24"> of path/circle/rect/line shapes with stroke="currentColor" fill="none" (no other colours).

## Steps
1. miniapp_create with name, description, icon, files, permissions, subscribe. Fix every finding it reports and save again.
2. It is looked at in light and dark at 1440 and 390 wide and the four screenshots come back with the result: look at each; fix what is wrong with miniapp_update (patches for small changes).
3. miniapp_open shows it to him; miniapp_pin puts it on the sidebar ONLY when he asked for that (most apps stay on the Apps page).
4. To change one later: miniapp_get, then miniapp_update with a reason. miniapp_undo goes back a version.`

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function list(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
}

function filesOf(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [name, body] of Object.entries(value as Record<string, unknown>)) if (typeof body === 'string') out[name] = body
  return out
}

function patchesOf(value: unknown): Array<{ file: string; old: string; new: string }> | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({ file: text(item['file']), old: text(item['old']), new: text(item['new']) }))
}

function line(app: MiniAppRow): string {
  const where = app.pinned > 0 ? `pinned #${app.pinned}` : 'Apps page'
  const look = app.check.version === app.version ? (app.check.ok ? 'checked' : `check found ${app.check.issues.length} issue(s)`) : 'not checked yet'
  return `${app.name} (${app.id}): ${app.description || 'no description'}. v${app.version}, ${where}, ${look}. Permissions: ${app.permissions.join(', ') || 'none'}.`
}

function checkText(check: MiniAppCheck): string {
  // [[image:...]] hands each screenshot to the model to look at (core loop.ts IMAGE_MARKER); the paths are for files_read.
  const shots = check.shots.length > 0 ? `\nScreenshots (look at each; files_read opens them again):\n${check.shots.map((s) => `- ${s}\n[[image:${s}]]`).join('\n')}` : ''
  const notes = (check.notes ?? []).length > 0 ? `\nNote:\n${(check.notes ?? []).map((n) => `- ${n}`).join('\n')}` : ''
  return check.ok
    ? `Looked at in light and dark at 1440 and 390: no problems found.${notes}${shots}`
    : `Looked at in light and dark at 1440 and 390, and found:\n${check.issues.map((i) => `- ${i}`).join('\n')}${notes}${shots}\nFix these with miniapp_update before showing it to him.`
}

const FILES_SCHEMA: JsonObject = { type: 'object', description: 'Files by name: {"index.html": "...", "app.js": "...", "app.css": "..."}. On update, a file set to "" is removed.', additionalProperties: { type: 'string' } }
const PATCHES_SCHEMA: JsonObject = {
  type: 'array',
  description: 'Exact-text edits: [{file, old, new}], each old found exactly once',
  items: { type: 'object', properties: { file: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }, required: ['file', 'old', 'new'] },
}

export function miniAppTools(deps: MiniAppToolDeps): Tool[] {
  const apps = new MiniAppStore({ store: deps.store, ...(deps.knownTools === undefined ? {} : { knownTools: deps.knownTools }) })
  const ui = (): MiniAppUi | null => deps.ui?.() ?? null

  /** Saves, then looks at it in both themes at both widths when this computer can. */
  const checked = async (app: MiniAppRow): Promise<string> => {
    const host = ui()
    if (host === null) return 'Not looked at yet: the desktop app checks it in light and dark at 1440 and 390 when it next sees it.'
    try {
      const result = await host.check(app)
      await apps.setCheck(app.id, result)
      return checkText(result)
    } catch (error) {
      return `The check could not run: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  const ready = async (app: MiniAppRow): Promise<string | null> => {
    if (ui() === null) return null
    if (app.check.version === app.version && app.check.ok) return null
    const result = await checked(app)
    const fresh = await apps.find(app.id)
    return fresh !== null && fresh.check.version === fresh.version && fresh.check.ok ? null : `Not shown: it has to pass the look check first.\n${result}`
  }

  const find = async (input: JsonObject): Promise<MiniAppRow | string> => {
    const ref = text(input['app']).trim()
    if (ref === '') return 'Which app? Pass its id or name in app.'
    return (await apps.find(ref)) ?? `No app "${ref}". miniapp_list shows them.`
  }

  return [
    {
      spec: { name: 'miniapp_guide', description: 'How to make a mini-app (a small dashboard, tracker or view the user opens from Apps): files, the design tokens and kit it must use, the agent bridge for data, permissions, icons. Read it before miniapp_create.', schema: schema([], {}) },
      run: async () => MINIAPP_GUIDE,
    },
    {
      spec: {
        name: 'miniapp_create',
        description: 'Make a mini-app the user asked for (a dashboard, a tracker, a view of his data) and save it; it appears on his Apps page. Read miniapp_guide first. Refused, with every finding listed, if it uses colours, fonts or radii outside the app tokens, reaches for the network, or calls tools outside its permissions. After saving it is looked at in light and dark at 1440 and 390 and the screenshots are listed.',
        schema: schema(['name', 'files'], {
          name: str('Short name he will see, e.g. "Week calendar"'),
          description: str('One line: what it shows'),
          icon: str(`An icon name (${MINIAPP_ICON_NAMES.slice(0, 12).join(', ')}...) or a small <svg> in currentColor`),
          files: FILES_SCHEMA,
          permissions: strList('Tools it may call: "task_list", "calendar_events", "apps_run:SLUG", "webapp_run:app/tool"'),
          subscribe: strList('Topics it listens to while open: data.task, data.goal, data.trigger, data.memory, calendar.changed, worker.<id>'),
          refresh_minutes: int('While open, refresh every this many minutes (0 = only on open)'),
        }),
      },
      run: async (input, ctx) => {
        const made = await apps.create(
          {
            name: text(input['name']),
            description: text(input['description']),
            icon: text(input['icon']) || 'apps',
            files: filesOf(input['files']) ?? {},
            permissions: list(input['permissions']) ?? [],
            subscribe: list(input['subscribe']) ?? [],
            refreshMinutes: typeof input['refresh_minutes'] === 'number' ? Math.round(input['refresh_minutes']) : 0,
          },
          { by: agentWriter(ctx.agentLabel), profile: ctx.profile ?? '' },
        )
        if (!made.ok) return made.why
        return `Saved "${made.app.name}" (${made.app.id}) on the Apps page.\n${await checked(made.app)}`
      },
    },
    {
      spec: {
        name: 'miniapp_update',
        description: 'Change a mini-app when he asks (look, data, layout): whole files and/or exact-text patches, plus name, description, icon, permissions, subscribe or refresh_minutes. Same checks as create; the version it replaces is kept (miniapp_undo goes back). Say why in reason.',
        schema: schema(['app', 'reason'], {
          app: str('Its id or name'),
          reason: str('What he asked for, in a few words'),
          files: FILES_SCHEMA,
          patches: PATCHES_SCHEMA,
          name: str('New name'),
          description: str('New description'),
          icon: str('New icon'),
          permissions: strList('The whole new permission list'),
          subscribe: strList('The whole new topic list'),
          refresh_minutes: int('New refresh interval while open'),
        }),
      },
      run: async (input, ctx) => {
        const found = await find(input)
        if (typeof found === 'string') return found
        const change: MiniAppChange = {}
        const files = filesOf(input['files'])
        if (files !== undefined) change.files = files
        const patches = patchesOf(input['patches'])
        if (patches !== undefined) change.patches = patches
        if (typeof input['name'] === 'string' && input['name'].trim() !== '') change.name = input['name']
        if (typeof input['description'] === 'string') change.description = input['description']
        if (typeof input['icon'] === 'string' && input['icon'].trim() !== '') change.icon = input['icon']
        const permissions = list(input['permissions'])
        if (permissions !== undefined) change.permissions = permissions
        const subscribe = list(input['subscribe'])
        if (subscribe !== undefined) change.subscribe = subscribe
        if (typeof input['refresh_minutes'] === 'number') change.refreshMinutes = Math.round(input['refresh_minutes'])
        const done = await apps.update(found.id, change, { by: agentWriter(ctx.agentLabel), reason: text(input['reason']).trim() })
        if (!done.ok) return done.why
        if (done.note !== undefined) return done.note
        return `Saved "${done.app.name}" as version ${done.app.version} (version ${done.app.version - 1} is kept).\n${await checked(done.app)}`
      },
    },
    {
      spec: { name: 'miniapp_list', description: 'The mini-apps saved: name, id, what it shows, pinned or on the Apps page, version, whether it passed its look check, permissions.', schema: schema([], {}) },
      run: async () => {
        const all = await apps.list()
        return all.length === 0 ? 'No mini-apps yet.' : all.map(line).join('\n')
      },
    },
    {
      spec: {
        name: 'miniapp_get',
        description: "A mini-app's manifest and files (all, or one by file), and its kept versions, to change it.",
        schema: schema(['app'], { app: str('Its id or name'), file: str('Only this file') }),
      },
      run: async (input) => {
        const found = await find(input)
        if (typeof found === 'string') return found
        const file = text(input['file']).trim()
        if (file !== '') return found.files[file] ?? `It has no ${file} (files: ${Object.keys(found.files).join(', ')}).`
        return JSON.stringify({
          id: found.id,
          name: found.name,
          description: found.description,
          icon: found.icon,
          permissions: found.permissions,
          subscribe: found.subscribe,
          refresh_minutes: found.refreshMinutes,
          version: found.version,
          pinned: found.pinned,
          kept_versions: found.history.map((v) => ({ n: v.n, at: new Date(v.at).toISOString(), by: v.by, reason: v.reason })),
          check: found.check,
          files: found.files,
        })
      },
    },
    {
      spec: {
        name: 'miniapp_open',
        description:
          'Show a mini-app to the user on the device he is using right now: his phone when he wrote from it (it opens there, and you put the card line it gives you in your reply), else this app window. It must have passed its look check.',
        schema: schema(['app'], { app: str('Its id or name') }),
      },
      run: async (input, ctx) => {
        const found = await find(input)
        if (typeof found === 'string') return found
        // He wrote from another device (his phone): open it there, and give him a card in the chat that opens it again.
        const devices = deps.devices
        const chat = ctx.chat ?? MAIN_CHAT
        const origin = devices === undefined ? null : await latestOrigin(deps.store, chat)
        const commands = devices?.commands() ?? null
        if (devices !== undefined && origin !== null && origin.deviceId !== devices.selfId() && commands !== null) {
          const blocked = await ready(found)
          if (blocked !== null) return blocked
          const card = `Put this line in your reply, on its own line, so he has a card that opens it: ${miniAppLink(found)}`
          const outcome = await commands.send(origin.deviceId, { kind: 'open_url', url: `agent://miniapp/${found.id}` }, chat, `The user's ${origin.name}`, ctx.owner ?? '')
          if (outcome.status === 'done') return `Opened "${found.name}" on the user's ${origin.name}. ${card}`
          return `Could not open "${found.name}" on the user's ${origin.name} by itself${outcome.note === '' ? '' : ` (${outcome.note})`}. ${card}`
        }
        const host = ui()
        if (host === null) return `"${found.name}" is on his Apps page; this device has no window to open it in.`
        const blocked = await ready(found)
        if (blocked !== null) return blocked
        await host.open(found)
        return `Opened "${found.name}".`
      },
    },
    {
      spec: {
        name: 'miniapp_pin',
        description: 'Pin a mini-app to the sidebar (only when he asked), or move a pinned one: position 1 is the top. Most apps stay on the Apps page.',
        schema: schema(['app'], { app: str('Its id or name'), position: int('Its place among the pinned apps, 1 = first (default: last, or where it is)') }),
      },
      run: async (input) => {
        const found = await find(input)
        if (typeof found === 'string') return found
        const blocked = await ready(found)
        if (blocked !== null) return blocked
        const done = await apps.pin(found.id, typeof input['position'] === 'number' ? input['position'] : undefined)
        return done.ok ? `"${done.app.name}" is pinned to the sidebar at #${done.app.pinned}.` : done.why
      },
    },
    {
      spec: { name: 'miniapp_unpin', description: 'Take a mini-app off the sidebar; it stays on the Apps page.', schema: schema(['app'], { app: str('Its id or name') }) },
      run: async (input) => {
        const found = await find(input)
        if (typeof found === 'string') return found
        const done = await apps.unpin(found.id)
        return done.ok ? `"${done.app.name}" is off the sidebar (still on the Apps page).` : done.why
      },
    },
    {
      spec: {
        name: 'miniapp_undo',
        description: 'Undo the last change to a mini-app (or go back to a kept version). The undo is itself a new version.',
        schema: schema(['app'], { app: str('Its id or name'), version: int('Go back to this kept version (default: the one before)') }),
      },
      run: async (input, ctx) => {
        const found = await find(input)
        if (typeof found === 'string') return found
        const done = await apps.undo(found.id, { by: agentWriter(ctx.agentLabel) }, typeof input['version'] === 'number' ? input['version'] : undefined)
        if (!done.ok) return done.why
        return `${done.note ?? 'Done.'}\n${await checked(done.app)}`
      },
    },
    {
      spec: {
        name: 'miniapp_check',
        description: 'Look at a mini-app again in light and dark at 1440 and 390 wide: errors it throws, calls it was refused, sideways scrolling, an empty page; and the four screenshots.',
        schema: schema(['app'], { app: str('Its id or name') }),
      },
      run: async (input) => {
        const found = await find(input)
        if (typeof found === 'string') return found
        return checked(found)
      },
    },
    {
      spec: {
        name: 'miniapp_delete',
        description: 'Delete a mini-app (asks the user first). It leaves the sidebar and the Apps page on every device.',
        schema: schema(['app'], { app: str('Its id or name'), confirm: bool('Ignored; the user is always asked') }),
      },
      run: async (input, ctx) => {
        const found = await find(input)
        if (typeof found === 'string') return found
        const yes = await ctx.approve(`Delete the mini-app "${found.name}"`, `${found.description}\nIt leaves the Apps page${found.pinned > 0 ? ' and the sidebar' : ''} on every device. Its ${found.history.length} kept versions go too.`)
        if (!yes) return 'Not deleted: he said no.'
        const done = await apps.remove(found.id)
        return done.ok ? `Deleted "${found.name}".` : done.why
      },
    },
  ]
}
