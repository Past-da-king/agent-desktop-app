/**
 * Projects as tools, so the one main agent can work across them (21 Oct 2026). In the main thread it lists
 * projects and what each chat is doing, starts a chat in a project with a brief, and sends a message into one; a
 * project chat can write back to the main thread with message_main. A message between them shows in the receiving
 * chat labelled with who sent it, and runs that chat's turn like a message from the person.
 */
import { mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { MAIN_CHAT, PROFILE_COLORS, bool, findProjects, parseAliases, pickMatch, schema, str, NO_PICK, type AgentProfileInfo, type AiAccount, type AiPicks, type JsonObject, type ProfileColor, type ProjectRow, type RunState, type Tool, type ToolContext } from '@agent/core'

import { isIconImage } from '../../shared/project-icon'
import type { DataStore } from '../runtime/data'
import { chatOf, chatTitle, newProjectChatId, parseMeta } from '../runtime/chat-lines'

import { viaFromMeta, type ChatVia } from '../../shared/sender'

/** Who a message came from (shared/sender.ts): every sender that is not the person writes it on the row. */
export { viaLabel, type ChatVia } from '../../shared/sender'

export interface ProjectToolDeps {
  store: DataStore
  /** Puts a message from another chat into `chat` and runs its turn (runner.receive). Does not wait for the turn. */
  post(chat: string, text: string, via: ChatVia): Promise<void>
  /** Whether a chat is running and what waits on the person in it. */
  state(chat: string): RunState
  agentName(): string
  /** The person's profiles, so a project can name the one its helpers use. */
  profiles?(): AgentProfileInfo[]
  /** A picture file on this computer as a small square icon (shared/project-icon.ts), or null when it is not one. */
  imageIcon?(path: string): Promise<string | null>
  /** The AI accounts the person set up, so a project can be given one by name. */
  accounts?(): AiAccount[]
  /** Puts a project's page on screen in the app window (project_open). Without it there is no project_open. */
  open?(projectId: string): void
  /** The main agent handed work to a project chat: show that project's agent as a helper row in the main chat. */
  agents?: { delegated(chat: string, project: ProjectRow, brief: string): Promise<void> }
  /** Devices (s12): where a new project chat runs (a linked server, or here), decided before its first message. */
  place?(chat: string, project: ProjectRow, brief: string, device?: string): Promise<unknown>
}

/** An account by name or id; 'main' / 'same as main' / '' means the main agent's. */
function accountByName(deps: ProjectToolDeps, raw: string): AiAccount | 'main' | null {
  const wanted = raw.trim().toLowerCase()
  if (wanted === '' || wanted === 'main' || wanted === 'same as main' || wanted === 'default') return 'main'
  const all = deps.accounts?.() ?? []
  return all.find((account) => account.id === raw.trim()) ?? all.find((account) => account.label.toLowerCase() === wanted) ?? all.find((account) => account.label.toLowerCase().includes(wanted)) ?? null
}

function accountNames(deps: ProjectToolDeps): string {
  const names = (deps.accounts?.() ?? []).map((account) => account.label)
  return names.length === 0 ? 'none yet' : names.join(', ')
}

/** The picture the agent named for a project's icon: '' for none asked, or an error line for the agent. */
async function pictureFor(deps: ProjectToolDeps, raw: string): Promise<{ image: string } | { error: string } | null> {
  if (raw === '') return null
  if (raw.toLowerCase() === 'none') return { image: '' }
  const path = folderPath(raw)
  const image = deps.imageIcon === undefined ? null : await deps.imageIcon(path).catch(() => null)
  if (image === null || !isIconImage(image)) return { error: `${path} is not a picture this app can use (a PNG, JPG, WebP or ICO file). Find the right file with files_find and call again.` }
  return { image }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function clip(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 3)}...`
}

/**
 * A project by id or by name, ignoring case; a hidden one is found too. Failing those, the one clear winner of the
 * forgiving matcher ("lender select" for Acme Lender Selector), never a guess between two close ones.
 */
export function findProject(projects: ProjectRow[], ref: string): ProjectRow | null {
  const wanted = ref.trim().toLowerCase()
  if (wanted === '') return null
  return (
    projects.find((p) => p.id.toLowerCase() === wanted) ??
    projects.find((p) => p.name.toLowerCase() === wanted) ??
    projects.find((p) => p.name.toLowerCase().includes(wanted)) ??
    pickMatch(findProjects(ref, projects)).winner?.item ??
    null
  )
}

/** The project a chat belongs to. */
export function projectOfChat(projects: ProjectRow[], chat: string): ProjectRow | null {
  return chat === MAIN_CHAT ? null : (projects.find((p) => p.chats.includes(chat)) ?? null)
}

export function projectTools(given: ProjectToolDeps): Tool[] {
  // Work the main agent hands to a project chat also shows in the main chat as that project's agent (runtime/project-agents.ts).
  const agents = given.agents
  const deps: ProjectToolDeps =
    agents === undefined
      ? given
      : {
          ...given,
          post: async (chat, text, via) => {
            await given.post(chat, text, via)
            if (via.from !== 'main' || chat === MAIN_CHAT) return
            const project = projectOfChat(await given.store.list('project'), chat)
            if (project !== null) await agents.delegated(chat, project, text)
          },
        }
  const tools = [projectsList(deps), projectCreate(deps), projectUpdate(deps), projectChatStart(deps), projectChatSend(deps), messageMain(deps)]
  const open = deps.open
  if (open !== undefined) tools.push(projectOpen(deps, open))
  return tools
}

/**
 * "Show me the lender select": puts that project's page on screen (22 Oct 2026). Same matcher as the
 * palette's search. One clear winner opens; two close ones come back for the agent to ask; none says so.
 */
function projectOpen(deps: ProjectToolDeps, open: (projectId: string) => void): Tool {
  return {
    spec: {
      name: 'project_open',
      description:
        'Put one of the user\'s projects on screen: its page opens in the app. Pass what the user called it, as they said it ("the lender select", "strategic website"); it forgives filler words, cut-off words, typos and dictation slips, and also matches the project\'s other names, description and folder. If two projects are close it opens neither and returns both, so ask which one.',
      schema: schema(['project'], { project: str('The project as the user said it, or its id') }),
    },
    run: async (input) => {
      const said = text(input['project'])
      if (said === '') return 'Pass the project, as the user said it.'
      const projects = await deps.store.list('project')
      if (projects.length === 0) return 'The user has no projects yet.'
      const byId = projects.find((p) => p.id === said)
      const exact = byId ?? projects.find((p) => p.name.toLowerCase() === said.toLowerCase())
      const picked = exact !== undefined ? { winner: { item: exact, score: 1 }, close: [] } : pickMatch(findProjects(said, projects))
      const winner = picked.winner?.item
      if (winner !== undefined) {
        open(winner.id)
        return `Opened ${winner.name}${winner.hidden ? ' (a hidden project)' : ''} on screen.`
      }
      if (picked.close.length > 0) {
        const names = picked.close.map((hit) => `${hit.item.name} (id ${hit.item.id})`)
        return `Nothing opened: "${said}" is close to ${names.length} projects: ${names.join('; ')}. Ask the user which one (ask_user with their names as buttons), then call project_open with its id.`
      }
      return `No project matches "${said}". The projects are: ${projects.map((p) => p.name).join(', ')}. If one of these is what they meant, call again with its name; otherwise tell the user there is none by that name.`
    },
  }
}

function projectsList(deps: ProjectToolDeps): Tool {
  return {
    spec: {
      name: 'project_list',
      description:
        "The user's projects: each one's description, folder and profile, and its chats (agents) with what each is doing now and its last message. Use it before starting or messaging a project chat, and for \"how are my projects going?\".",
      schema: schema([], { project: str('Only this project (name or id). Leave out for all.') }),
    },
    run: async (input) => {
      const projects = await deps.store.list('project')
      const only = text(input['project'])
      const shown = only === '' ? projects : [findProject(projects, only)].filter((p): p is ProjectRow => p !== null)
      if (shown.length === 0) return only === '' ? 'No projects yet. The user makes them in the rail (Projects, +).' : `No project called "${only}".`
      const rows = await deps.store.list('chat_item')
      return shown
        .map((project) => {
          const lines = [`${project.name} (id ${project.id})${project.hidden ? ' [hidden]' : ''}${project.description === '' ? '' : `: ${clip(project.description, 200)}`}`]
          if (project.path !== '') lines.push(`  folder: ${project.path}`)
          if ((project.aliases ?? []).length > 0) lines.push(`  also called: ${(project.aliases ?? []).join(', ')}`)
          if (project.chats.length === 0) lines.push('  no chats yet')
          for (const chat of project.chats) {
            const own = rows.filter((row) => chatOf(row) === chat)
            const state = deps.state(chat)
            const status = state.waiting.length > 0 ? 'waiting for the user' : state.running ? 'working' : 'idle'
            const last = [...own].reverse().find((row) => (row.kind === 'agent' || row.kind === 'user') && row.text.trim() !== '')
            lines.push(`  - chat ${chat}: "${chatTitle(own)}", ${status}${last === undefined ? '' : `; last: ${clip(last.text, 160)}`}`)
          }
          return lines.join('\n')
        })
        .join('\n')
    },
  }
}

function projectChatStart(deps: ProjectToolDeps): Tool {
  return {
    spec: {
      name: 'project_chat_start',
      description:
        "Start a new chat (an agent) in one of the user's projects and give it a brief; it starts working at once, in the project's folder and with its profile, and the user sees it under the project. Write the brief as you would for a helper: the goal, the context, what to bring back. It can write back to you with message_main.",
      schema: schema(['project', 'brief'], {
        project: str('The project, by name or id'),
        brief: str('What this chat should do, complete and self-contained'),
        device: str("Optional: where it runs. Leave it out (best): it stays on this computer when the project has a folder here, else a linked server may run it. 'here', or a linked device by name."),
      }),
    },
    run: async (input, ctx) => {
      const projects = await deps.store.list('project')
      const project = findProject(projects, text(input['project']))
      if (project === null) return `No project called "${text(input['project'])}". project_list shows them.`
      const brief = text(input['brief'])
      if (brief === '') return 'Pass the brief.'
      const chat = newProjectChatId()
      await deps.store.upsert('project', { id: project.id, chats: [...project.chats, chat] })
      const device = text(input['device'])
      await deps.place?.(chat, project, brief, device === '' ? undefined : device)
      await deps.post(chat, brief, viaOf(ctx, projects, deps))
      return `Started a chat in ${project.name} (chat ${chat}). It is working on it and will write back with what it finds; project_list shows how it is going.`
    },
  }
}

function projectChatSend(deps: ProjectToolDeps): Tool {
  return {
    spec: {
      name: 'project_chat_send',
      description:
        "Send a message into one of a project's chats (an agent already working there): it reads it as its next message and carries on. Find the chat id with project_list.",
      schema: schema(['chat', 'message'], {
        chat: str('The chat id from projects_list'),
        message: str('What to tell it'),
      }),
    },
    run: async (input, ctx) => {
      const projects = await deps.store.list('project')
      const chat = text(input['chat'])
      const project = projectOfChat(projects, chat)
      if (project === null) return `No project chat ${chat}. project_list shows the chats.`
      const message = text(input['message'])
      if (message === '') return 'Pass the message.'
      await deps.post(chat, message, viaOf(ctx, projects, deps))
      return `Sent to the chat in ${project.name}.`
    },
  }
}

function messageMain(deps: ProjectToolDeps): Tool {
  return {
    spec: {
      name: 'message_main',
      description:
        "From a project chat: write to the main agent in the user's main thread (a result it asked for, something that needs another project, a question for the user that does not belong here). It shows there labelled with this project, and the main agent acts on it.",
      schema: schema(['message'], { message: str('What to tell the main agent, complete and self-contained') }),
    },
    run: async (input, ctx) => {
      const chat = ctx.chat ?? MAIN_CHAT
      const projects = await deps.store.list('project')
      const project = projectOfChat(projects, chat)
      if (project === null) return 'You are in the main thread already; just answer the user.'
      const message = text(input['message'])
      if (message === '') return 'Pass the message.'
      const rows = (await deps.store.list('chat_item')).filter((row) => chatOf(row) === chat)
      await deps.post(MAIN_CHAT, message, { from: 'project', name: project.name, chat, title: chatTitle(rows) })
      return 'Sent to the main agent.'
    },
  }
}

/** Who is sending: the main agent from the main thread, else the project the sending chat belongs to. */
function viaOf(ctx: ToolContext, projects: ProjectRow[], deps: ProjectToolDeps): ChatVia {
  const chat = ctx.chat ?? MAIN_CHAT
  const project = projectOfChat(projects, chat)
  if (project === null) return { from: 'main', name: deps.agentName().trim() || 'Your agent', chat }
  return { from: 'project', name: project.name, chat }
}

/** The sender recorded on a row, or null for the person. */
export function viaOfRow(meta: string): ChatVia | null {
  return viaFromMeta(parseMeta(meta))
}

// ---- making and changing projects ---------------------------------------------------------------------------

const GLYPHS = new Set(['folder', 'building', 'code', 'term', 'globe', 'doc', 'mail', 'cal', 'chat', 'tasks', 'heart', 'bolt', 'shield', 'key', 'palette', 'monitor', 'phone', 'person', 'server', 'shot', 'clock'])

/** A glyph from the app's icon set, or one emoji; anything else falls back to a folder. */
export function iconGlyph(raw: string): string {
  const wanted = raw.trim()
  if (GLYPHS.has(wanted.toLowerCase())) return wanted.toLowerCase()
  if (wanted !== '' && [...wanted].length <= 4 && /\p{Extended_Pictographic}/u.test(wanted) && !/[A-Za-z0-9]/.test(wanted)) return wanted
  return 'folder'
}

function colorOf(raw: string, taken: ProjectRow[]): ProfileColor {
  const wanted = raw.trim().toLowerCase()
  if ((PROFILE_COLORS as readonly string[]).includes(wanted)) return wanted as ProfileColor
  return PROFILE_COLORS.find((c) => c !== 'graphite' && !taken.some((p) => p.icon.color === c)) ?? 'iris'
}

/** "~/x", "Desktop/x" or an absolute path, as an absolute path on this computer. */
export function folderPath(raw: string): string {
  const clean = raw.trim().replace(/^["']|["']$/g, '')
  if (clean === '') return ''
  if (clean === '~' || clean.startsWith('~/') || clean.startsWith('~\\')) return join(homedir(), clean.slice(1))
  return isAbsolute(clean) ? resolve(clean) : join(homedir(), clean)
}

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function profileByName(deps: ProjectToolDeps, raw: string): AgentProfileInfo | null | 'general' {
  const wanted = raw.trim().toLowerCase()
  if (wanted === '' || wanted === 'general') return 'general'
  const all = deps.profiles?.() ?? []
  return all.find((p) => p.id.toLowerCase() === wanted) ?? all.find((p) => p.name.toLowerCase() === wanted) ?? null
}

function profileNames(deps: ProjectToolDeps): string {
  const names = (deps.profiles?.() ?? []).filter((p) => !p.general).map((p) => p.name)
  return names.length === 0 ? 'none yet' : names.join(', ')
}

function projectCreate(deps: ProjectToolDeps): Tool {
  return {
    spec: {
      name: 'project_create',
      description:
        "Make a project when the user asks for one (\"create a project in this folder, call it X, it's for Y\"). Find the folder on this computer first with your file tools (files_find, files_list) and pass its full path; a folder that does not exist yet needs create_folder true. The user sees a card with the name, icon, folder, profile and description and taps Create, Change or No; nothing is made until they tap Create. The project then shows in the rail.",
      schema: schema(['name'], {
        name: str('Short project name'),
        path: str('The full path of its folder on this computer (found with your file tools). Leave out for none.'),
        description: str('One or two lines: what it is for'),
        aliases: str('Other names the user calls it, comma separated (e.g. "Rumbler" for RMBLR), so search and project_open find it'),
        profile: str("The profile whose accounts and logins its helpers use, by name. Leave out for General."),
        icon: str('An icon: one of folder, building, code, term, globe, doc, mail, cal, chat, tasks, heart, bolt, shield, key, palette, monitor, phone, person, server, shot; or one emoji'),
        icon_image: str("A picture to use as its icon instead: the full path of an image file on this computer (PNG, JPG, WebP or ICO), e.g. the website's logo or favicon in the project folder. Only when the user asks for their own picture."),
        color: str(`Tile colour: ${PROFILE_COLORS.join(', ')}`),
        create_folder: bool('True to make the folder when it does not exist yet'),
      }),
    },
    run: async (input, ctx) => {
      const name = text(input['name']).replace(/\s+/g, ' ').slice(0, 60)
      if (name === '') return 'Give the project a name.'
      const projects = await deps.store.list('project')
      const same = projects.find((p) => p.name.toLowerCase() === name.toLowerCase())
      if (same !== undefined) return `There is already a project called ${same.name} (id ${same.id}). Use project_update to change it.`
      const path = folderPath(text(input['path']))
      const exists = path === '' || (await isFolder(path))
      const makeFolder = input['create_folder'] === true
      if (!exists && !makeFolder) return `There is no folder at ${path}. Find the right one with files_find or files_list and call again with its full path, or pass create_folder true to make it.`
      const profile = profileByName(deps, text(input['profile']))
      if (profile === null) return `No profile called "${text(input['profile'])}". The user's profiles: ${profileNames(deps)}. Leave profile out for General.`
      const description = text(input['description']).slice(0, 600)
      const picture = await pictureFor(deps, text(input['icon_image']))
      if (picture !== null && 'error' in picture) return picture.error
      const icon = { glyph: iconGlyph(text(input['icon'])), color: colorOf(text(input['color']), projects), ...(picture !== null && picture.image !== '' ? { image: picture.image } : {}) }
      const profileName = profile === 'general' ? 'General' : profile.name
      const card: JsonObject = { kind: 'project', name, description, path, folderNew: !exists, profile: profileName, icon }
      const answer = await ctx.ask(`Make the project ${name}?`, ['Create', 'Change'], card)
      if (answer === null) return 'Nobody could confirm the project, so nothing was made. Ask again when the user is here.'
      if (answer === 'No') return 'The user said no. No project was made.'
      if (answer === 'Change') return 'The user wants something changed before it is made. Ask what (name, folder, profile, icon or description), then call project_create again with it.'
      if (answer !== 'Create') return `The user answered "${clip(answer, 300)}" instead of Create. Adjust the project to that and call project_create again.`
      if (!exists) await mkdir(path, { recursive: true })
      const made = await deps.store.upsert('project', { name, description, aliases: parseAliases(text(input['aliases'])), icon, path, profile: profile === 'general' ? '' : profile.id, hidden: false, chats: [] })
      return `Made the project ${name} (id ${made.id})${path === '' ? '' : ` in ${path}`}. It is in the rail. Start work in it with project_chat_start.`
    },
  }
}

function projectUpdate(deps: ProjectToolDeps): Tool {
  return {
    spec: {
      name: 'project_update',
      description: 'Change a project the user asked you to change: rename it, move it to another folder, change its profile, icon, colour, description or other names, or hide it from the rail and show it again. Pass only what changes.',
      schema: schema(['project'], {
        project: str('The project, by name or id'),
        name: str('New name'),
        path: str('New folder: its full path on this computer, or "none"'),
        description: str('New description'),
        aliases: str('Its other names, the full list, comma separated (replaces the list; "" clears it)'),
        profile: str('New profile by name, or "General"'),
        icon: str('New icon (a glyph name or one emoji)'),
        icon_image: str('Use a picture as its icon: the full path of an image file on this computer (PNG, JPG, WebP or ICO); "none" goes back to the glyph'),
        color: str('New tile colour'),
        hidden: bool('True hides it from the rail, false shows it again'),
        main_ai: str('Which AI account the agent in its chats thinks with, by name (the user\'s accounts in Settings), or "main" for the same as the main thread'),
        main_model: str('The model for that agent, or "" for the account\'s default'),
        helpers_ai: str('Which AI account its helpers think with, by name, or "main" for the same as the main thread'),
        helpers_model: str('The model for its helpers, or "" for the account\'s default'),
      }),
    },
    run: async (input) => {
      const projects = await deps.store.list('project')
      const project = findProject(projects, text(input['project']))
      if (project === null) return `No project called "${text(input['project'])}". project_list shows them.`
      const patch: Partial<ProjectRow> & { id: string } = { id: project.id }
      const changed: string[] = []
      const name = text(input['name']).replace(/\s+/g, ' ').slice(0, 60)
      if (name !== '' && name !== project.name) {
        patch.name = name
        changed.push(`named ${name}`)
      }
      if (typeof input['path'] === 'string') {
        const raw = text(input['path'])
        const path = raw.toLowerCase() === 'none' ? '' : folderPath(raw)
        if (path !== '' && !(await isFolder(path))) return `There is no folder at ${path}. Find it with files_find or files_list and call again.`
        patch.path = path
        changed.push(path === '' ? 'no folder' : `folder ${path}`)
      }
      if (typeof input['description'] === 'string') {
        patch.description = text(input['description']).slice(0, 600)
        changed.push('description')
      }
      if (typeof input['aliases'] === 'string') {
        patch.aliases = parseAliases(input['aliases'])
        changed.push(patch.aliases.length === 0 ? 'no other names' : `other names ${patch.aliases.join(', ')}`)
      }
      if (typeof input['profile'] === 'string') {
        const profile = profileByName(deps, text(input['profile']))
        if (profile === null) return `No profile called "${text(input['profile'])}". The user's profiles: ${profileNames(deps)}.`
        patch.profile = profile === 'general' ? '' : profile.id
        changed.push(`profile ${profile === 'general' ? 'General' : profile.name}`)
      }
      const picture = await pictureFor(deps, text(input['icon_image']))
      if (picture !== null && 'error' in picture) return picture.error
      if (typeof input['icon'] === 'string' || typeof input['color'] === 'string' || picture !== null) {
        const image = picture !== null ? picture.image : typeof input['icon'] === 'string' ? '' : (project.icon.image ?? '')
        patch.icon = {
          glyph: typeof input['icon'] === 'string' ? iconGlyph(text(input['icon'])) : project.icon.glyph,
          color: typeof input['color'] === 'string' ? colorOf(text(input['color']), projects) : project.icon.color,
          ...(image === '' ? {} : { image }),
        }
        changed.push(picture !== null ? (picture.image === '' ? 'icon back to its glyph' : 'its own picture as the icon') : 'icon')
      }
      if (typeof input['hidden'] === 'boolean' && input['hidden'] !== project.hidden) {
        patch.hidden = input['hidden']
        changed.push(input['hidden'] ? 'hidden from the rail' : 'back on the rail')
      }
      if (['main_ai', 'main_model', 'helpers_ai', 'helpers_model'].some((key) => typeof input[key] === 'string')) {
        const ai: AiPicks = { main: { ...(project.ai?.main ?? NO_PICK) }, helpers: { ...(project.ai?.helpers ?? NO_PICK) } }
        for (const slot of ['main', 'helpers'] as const) {
          const named = input[`${slot}_ai`]
          if (typeof named === 'string') {
            const account = accountByName(deps, named)
            if (account === null) return `No AI account called "${text(named)}". The user's accounts: ${accountNames(deps)}.`
            ai[slot] = { account: account === 'main' ? '' : account.id, model: ai[slot].model }
            changed.push(`${slot === 'main' ? 'its agent' : 'its helpers'} think with ${account === 'main' ? "the main thread's AI" : account.label}`)
          }
          const model = input[`${slot}_model`]
          if (typeof model === 'string') {
            ai[slot] = { account: ai[slot].account, model: model.trim().slice(0, 120) }
            changed.push(`${slot === 'main' ? 'its agent' : 'its helpers'} on ${model.trim() === '' ? 'the default model' : model.trim()}`)
          }
        }
        patch.ai = ai
      }
      if (changed.length === 0) return 'Nothing to change.'
      await deps.store.upsert('project', patch)
      return `${project.name}: ${changed.join(', ')}.`
    },
  }
}
