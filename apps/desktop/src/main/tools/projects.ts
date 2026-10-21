/**
 * Projects as tools, so the one main agent can work across them (Ayanda, 21 Oct 2026). In the main thread it lists
 * projects and what each chat is doing, starts a chat in a project with a brief, and sends a message into one; a
 * project chat can write back to the main thread with message_main. A message between them shows in the receiving
 * chat labelled with who sent it, and runs that chat's turn like a message from the person.
 */
import { MAIN_CHAT, schema, str, type ProjectRow, type RunState, type Tool, type ToolContext } from '@agent/core'

import type { DataStore } from '../runtime/data'
import { chatOf, chatTitle, newProjectChatId, parseMeta } from '../runtime/chat-lines'

/** Who a message between chats came from, as the receiving chat shows it. */
export interface ChatVia {
  from: 'main' | 'project'
  /** The main agent's name, or the project's name. */
  name: string
  /** The sending chat. */
  chat: string
  /** The sending chat's title (a project chat). */
  title?: string
}

export interface ProjectToolDeps {
  store: DataStore
  /** Puts a message from another chat into `chat` and runs its turn (runner.receive). Does not wait for the turn. */
  post(chat: string, text: string, via: ChatVia): Promise<void>
  /** Whether a chat is running and what waits on the person in it. */
  state(chat: string): RunState
  agentName(): string
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function clip(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 3)}...`
}

/** A project by id or by name, ignoring case; a hidden one is found too. */
export function findProject(projects: ProjectRow[], ref: string): ProjectRow | null {
  const wanted = ref.trim().toLowerCase()
  if (wanted === '') return null
  return projects.find((p) => p.id.toLowerCase() === wanted) ?? projects.find((p) => p.name.toLowerCase() === wanted) ?? projects.find((p) => p.name.toLowerCase().includes(wanted)) ?? null
}

/** The project a chat belongs to. */
export function projectOfChat(projects: ProjectRow[], chat: string): ProjectRow | null {
  return chat === MAIN_CHAT ? null : (projects.find((p) => p.chats.includes(chat)) ?? null)
}

export function projectTools(deps: ProjectToolDeps): Tool[] {
  return [projectsList(deps), projectChatStart(deps), projectChatSend(deps), messageMain(deps)]
}

function projectsList(deps: ProjectToolDeps): Tool {
  return {
    spec: {
      name: 'projects_list',
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
      }),
    },
    run: async (input, ctx) => {
      const projects = await deps.store.list('project')
      const project = findProject(projects, text(input['project']))
      if (project === null) return `No project called "${text(input['project'])}". projects_list shows them.`
      const brief = text(input['brief'])
      if (brief === '') return 'Pass the brief.'
      const chat = newProjectChatId()
      await deps.store.upsert('project', { id: project.id, chats: [...project.chats, chat] })
      await deps.post(chat, brief, viaOf(ctx, projects, deps))
      return `Started a chat in ${project.name} (chat ${chat}). It is working on it and will write back with what it finds; projects_list shows how it is going.`
    },
  }
}

function projectChatSend(deps: ProjectToolDeps): Tool {
  return {
    spec: {
      name: 'project_chat_send',
      description:
        "Send a message into one of a project's chats (an agent already working there): it reads it as its next message and carries on. Find the chat id with projects_list.",
      schema: schema(['chat', 'message'], {
        chat: str('The chat id from projects_list'),
        message: str('What to tell it'),
      }),
    },
    run: async (input, ctx) => {
      const projects = await deps.store.list('project')
      const chat = text(input['chat'])
      const project = projectOfChat(projects, chat)
      if (project === null) return `No project chat ${chat}. projects_list shows the chats.`
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

/** The label a message from another chat carries for the model reading it. */
export function viaLabel(via: ChatVia): string {
  if (via.from === 'main') return `[From ${via.name}, the main agent]`
  return `[From project ${via.name}${via.title === undefined || via.title === '' ? '' : `, chat "${via.title}"`}]`
}

/** The sender recorded on a row, or null for the person. */
export function viaOfRow(meta: string): ChatVia | null {
  const value = parseMeta(meta)['via']
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if ((v['from'] !== 'main' && v['from'] !== 'project') || typeof v['name'] !== 'string') return null
  return { from: v['from'], name: v['name'], chat: typeof v['chat'] === 'string' ? v['chat'] : '', ...(typeof v['title'] === 'string' ? { title: v['title'] } : {}) }
}
