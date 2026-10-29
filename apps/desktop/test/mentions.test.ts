/**
 * @-mentions (29 Oct 2026): '@Project words' typed in a chat goes to that project's current chat as his own message,
 * and the chat it was typed in keeps one "Sent to ..." line that opens it. Through the real IPC handler and store.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MAIN_CHAT, type Attachment, type ChatItem, type ProjectRow, type RunState } from '@agent/core'

import { AccountService } from '../src/main/account'
import { Store } from '../src/main/db'
import { registerIpc, type ChatRunner, type IpcMainLike } from '../src/main/ipc'
import { Secrets, type SafeStorageLike } from '../src/main/secrets'
import { SettingsStore } from '../src/main/settings'
import { CHANNELS } from '../src/shared/channels'
import { DEVICE_CHANNELS } from '../src/shared/device-channels'
import { RPC_ALLOWED, RPC_CHANNELS } from '../src/shared/rpc-methods'
import { insertMention, mentionAtCaret, mentionNoticeOf, mentionProjects, parseMention, rankMentions, type MentionProject } from '../src/shared/mentions'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const storage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain, 'utf8'),
  decryptString: (encrypted) => encrypted.toString('utf8'),
}

let dir = ''
let store: Store
let handlers: Map<string, Handler>
let sends: Array<{ text: string; chat: string; origin: unknown }>
let running: Set<string>
let dispose: (() => void) | null = null

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (handler === undefined) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(handler({}, ...args))
}

async function project(name: string, chats: string[] = [], extra: Partial<ProjectRow> = {}): Promise<ProjectRow> {
  return store.upsert('project', { name, description: '', icon: { glyph: 'bolt', color: 'teal' }, path: '', profile: '', hidden: false, chats, ...extra })
}

async function rows(chat: string): Promise<ChatItem[]> {
  const all = await store.list('chat_item')
  return all.filter((row) => {
    const meta = JSON.parse(row.meta) as Record<string, unknown>
    return (typeof meta['chat'] === 'string' ? meta['chat'] : MAIN_CHAT) === chat
  })
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-mentions-'))
  store = new Store(join(dir, 'agent.db'))
  const settings = new SettingsStore(join(dir, 'settings.json'), { hostname: () => 'test-machine' })
  const secrets = new Secrets(join(dir, 'secrets'), storage)
  const account = new AccountService(store, settings, secrets, { autoStart: false })
  handlers = new Map()
  sends = []
  running = new Set()
  const ipcMain: IpcMainLike = { handle: (channel, listener) => void handlers.set(channel, listener) }
  const chat: ChatRunner = {
    send: async (text: string, _attachments?: Attachment[], target?: string, origin?: unknown) => void sends.push({ text, chat: target ?? MAIN_CHAT, origin }),
    stop: () => undefined,
    state: (target?: string): RunState => ({ running: running.has(target ?? MAIN_CHAT), waiting: [] }),
    answer: async () => undefined,
    decide: async () => undefined,
    tap: async () => undefined,
  }
  dispose = registerIpc({
    store,
    settings,
    secrets,
    account,
    chat,
    ipcMain,
    windows: { minimize: () => undefined, toggleMaximize: () => undefined, close: () => undefined, isMaximized: () => false },
  })
})

afterEach(() => {
  dispose?.()
  dispose = null
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const list = (names: Array<string | [string, string[]]>): MentionProject[] =>
  names.map((entry, index) => {
    const [name, aliases] = typeof entry === 'string' ? [entry, []] : entry
    return { id: `p${index}`, name, aliases, glyph: 'bolt', color: 'teal', image: '', railAt: 0 }
  })

describe('the picker', () => {
  const projects = list(['Acme', 'Agent Desktop App', ['Nova Print', ['Nova']], 'Blue Ridge Platform', 'Acorn Notes'])

  it('ranks by name start, word start, initials and letters in order', () => {
    expect(rankMentions('ac', projects).map((p) => p.name)).toEqual(['Acme', 'Acorn Notes'])
    expect(rankMentions('desk', projects)[0]?.name).toBe('Agent Desktop App')
    expect(rankMentions('ada', projects)[0]?.name).toBe('Agent Desktop App')
    expect(rankMentions('blridge', projects)[0]?.name).toBe('Blue Ridge Platform')
    expect(rankMentions('nova', projects)[0]?.name).toBe('Nova Print')
    expect(rankMentions('zzz', projects)).toEqual([])
    expect(rankMentions('', projects)).toHaveLength(5)
  })

  it("finds the '@' word at the caret, never inside an email address", () => {
    expect(mentionAtCaret('@imp', 4)).toEqual({ start: 0, query: 'imp' })
    expect(mentionAtCaret('ask @agent desk', 15)).toEqual({ start: 4, query: 'agent desk' })
    expect(mentionAtCaret('me@mail.com', 11)).toBeNull()
    expect(mentionAtCaret('no mention', 10)).toBeNull()
  })

  it('writes the picked name in for the typed word', () => {
    expect(insertMention('@imp', 4, 'Acme')).toEqual({ text: '@Acme ', caret: 6 })
    expect(insertMention('@imp fix it', 4, 'Acme')).toEqual({ text: '@Acme fix it', caret: 6 })
  })

  it('leaves hidden projects out', () => {
    const shown = mentionProjects([
      { id: 'a', name: 'Shown', icon: { glyph: 'bolt', color: 'teal' }, hidden: false },
      { id: 'b', name: 'Hidden', icon: { glyph: 'bolt', color: 'teal' }, hidden: true },
    ])
    expect(shown.map((p) => p.name)).toEqual(['Shown'])
  })
})

describe('reading a mention out of a message', () => {
  const projects = list(['Acme', 'Agent Desktop App', ['Nova Print', ['Nova']], 'Ac'])

  it('takes the longest exact name or other name, any case, and strips it', () => {
    expect(parseMention('@Acme fix the follow-ups', projects)).toMatchObject({ project: { name: 'Acme' }, rest: 'fix the follow-ups' })
    expect(parseMention('@agent desktop app, check the build', projects)).toMatchObject({ project: { name: 'Agent Desktop App' }, rest: 'check the build' })
    expect(parseMention('post a video @Nova today', projects)).toMatchObject({ project: { name: 'Nova Print' }, rest: 'post a video today' })
    expect(parseMention('@Ac go', projects)).toMatchObject({ project: { name: 'Ac' } })
  })

  it('is no mention for no project, a word that only starts like one, an email, or two projects', () => {
    expect(parseMention('@Nobody hi', projects)).toBeNull()
    expect(parseMention('@Acmex hi', projects)).toBeNull()
    expect(parseMention('mail me@Acme.com', projects)).toBeNull()
    expect(parseMention('@Acme and @Nova Print both', projects)).toBeNull()
  })
})

describe('sending a mention', () => {
  it('goes to the chat at work in that project, his own words, with the sender origin', async () => {
    await project('Acme', ['pcold0000000001', 'pcbusy000000001'])
    running.add('pcbusy000000001')
    await invoke(CHANNELS.chat.send, '@Acme fix the follow-ups', [])
    await settle()
    expect(sends).toEqual([{ text: 'fix the follow-ups', chat: 'pcbusy000000001', origin: undefined }])
    const main = await rows(MAIN_CHAT)
    expect(main).toHaveLength(1)
    expect(main[0]?.kind).toBe('notice')
    expect(main[0]?.text).toBe('Sent to Acme')
    expect(mentionNoticeOf(JSON.parse(main[0]?.meta ?? '{}') as Record<string, unknown>)).toMatchObject({ name: 'Acme', chat: 'pcbusy000000001', fresh: false })
  })

  it('else goes to the chat he used last', async () => {
    await project('Acme', ['pcaaaa000000001', 'pcbbbb000000001'])
    await store.upsert('chat_item', { kind: 'user', text: 'older', meta: JSON.stringify({ chat: 'pcbbbb000000001' }) })
    await settle()
    await store.upsert('chat_item', { kind: 'agent', text: 'newer', meta: JSON.stringify({ chat: 'pcaaaa000000001' }) })
    await invoke(CHANNELS.chat.send, '@acme status?', [])
    await settle()
    expect(sends.map((s) => s.chat)).toEqual(['pcaaaa000000001'])
  })

  it('makes a new chat in a project that has none', async () => {
    const made = await project('Nova Print')
    await invoke(CHANNELS.chat.send, '@Nova Print post today', [])
    await settle()
    const after = await store.get('project', made.id)
    expect(after?.chats).toHaveLength(1)
    const fresh = after?.chats[0] ?? ''
    expect(sends).toEqual([{ text: 'post today', chat: fresh, origin: undefined }])
    const notice = (await rows(MAIN_CHAT))[0]
    expect(mentionNoticeOf(JSON.parse(notice?.meta ?? '{}') as Record<string, unknown>)).toMatchObject({ chat: fresh, fresh: true })
  })

  it('leaves everything else where it was typed', async () => {
    await project('Acme', ['pcimp0000000001'])
    await invoke(CHANNELS.chat.send, 'no mention here', [])
    await invoke(CHANNELS.chat.send, '@Nobody hi', [])
    await invoke(CHANNELS.chat.send, '@Acme more', [], 'pcimp0000000001')
    await settle()
    expect(sends.map((s) => `${s.chat}:${s.text}`)).toEqual(['main:no mention here', 'main:@Nobody hi', 'pcimp0000000001:@Acme more'])
    expect(await rows(MAIN_CHAT)).toHaveLength(0)
  })

  it('works from a linked phone: the picker list is allowed over the wire and says "same" when nothing changed', async () => {
    expect(RPC_ALLOWED.has('chat.mentions')).toBe(true)
    expect(RPC_CHANNELS['chat.mentions']).toBe(DEVICE_CHANNELS.mentions)
    await project('Acme', [], { aliases: ['Ac'] })
    await project('Secret', [], { hidden: true })
    const first = (await invoke(DEVICE_CHANNELS.mentions)) as { stamp: string; projects: MentionProject[] }
    expect(first.projects.map((p) => p.name)).toEqual(['Acme'])
    expect(first.projects[0]).toMatchObject({ aliases: ['Ac'], glyph: 'bolt', color: 'teal' })
    expect(await invoke(DEVICE_CHANNELS.mentions, first.stamp)).toEqual({ stamp: first.stamp, same: true })
    await project('Nova Print')
    const changed = (await invoke(DEVICE_CHANNELS.mentions, first.stamp)) as { stamp: string; projects?: MentionProject[] }
    expect(changed.stamp).not.toBe(first.stamp)
    expect(changed.projects?.map((p) => p.name)).toEqual(['Acme', 'Nova Print'])
  })
})
