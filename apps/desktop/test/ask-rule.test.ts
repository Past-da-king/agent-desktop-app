/**
 * Ordinary work runs without a card (23 Oct 2026: "stop asking me all them permissions").
 * Only what deletes or cannot be undone, costs money, goes live / DNS or touches secrets asks first; asking for
 * every change is the person's opt-in. Every case here went red on the old defaults.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_ACCOUNT_RULES, type ToolContext } from '@agent/core'

import { needsYes } from '../src/main/ask-rule'
import { LearnedStore, type LearnedApp, type LearnedTool } from '../src/main/apps/store'
import { secretFile } from '../src/main/tools/browser'
import { APP_ACTION_POLICY } from '../src/main/tools/app-actions'
import { callLearned, learnedAsks, webAppTools, type PageRunner } from '../src/main/tools/webapps'
import { testContext } from './support'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-ask-rule-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const tool = (name: string, description: string, extra: Partial<LearnedTool> = {}): LearnedTool => ({ name, description, params: {}, required: [], js: 'return 1', readOnly: false, ...extra })
const app = (tools: LearnedTool[], extra: Partial<LearnedApp> = {}): LearnedApp => ({ id: 'whatsapp', name: 'WhatsApp', startUrl: 'https://web.whatsapp.com', about: '', tools, trusted: false, updatedAt: 0, ...extra })

function counting(): { ctx: ToolContext; asked: string[] } {
  const asked: string[] = []
  const ctx = testContext({
    approve: async (summary: string) => {
      asked.push(summary)
      return true
    },
  } as Partial<ToolContext>)
  return { ctx, asked }
}

const runner: PageRunner = { ensure: async () => undefined, run: async () => ({ ok: true, v: 'done' }), evaluate: async () => null }

describe('the rule', () => {
  it('ordinary sending, posting and editing do not need a yes', () => {
    for (const text of ['send_message Send a text message to a chat', 'send_media Send a photo, video or document', 'reddit submit_post Post to a subreddit', 'reply_comment Reply to a comment', 'GMAIL_SEND_EMAIL', 'SLACK_SEND_MESSAGE', 'edit_post Edit a post']) {
      expect(needsYes(text), text).toBe(false)
    }
  })
  it('deleting, paying, going live, DNS and secrets do', () => {
    for (const text of ['delete_post Delete a post', 'GMAIL_MOVE_TO_TRASH', 'GITHUB_DELETE_A_REPOSITORY', 'checkout Pay for the cart', 'place_order Place an order', 'VERCEL_CREATE_DEPLOYMENT', 'CLOUDFLARE_UPDATE_DNS_RECORD', 'set_env_var Set an environment variable', 'GITHUB_CREATE_OR_UPDATE_REPO_SECRET', 'cancel_subscription Cancel the plan', "get_onedrive_access grants access to that user's OneDrive", 'assign_license Give a user a licence']) {
      expect(needsYes(text), text).toBe(true)
    }
  })
  it('a new connected account lets ordinary changes run (it used to ask for every change)', () => {
    expect(DEFAULT_ACCOUNT_RULES).toEqual({ read: 'allow', change: 'allow' })
  })
})

describe('learned apps', () => {
  it('WhatsApp send_message and send_media (with a file) run without a card', async () => {
    const send = tool('send_media', 'Send a photo, video, document, audio file or voice note to a chat.', { params: { file: { type: 'file' } } })
    const { ctx, asked } = counting()
    expect(learnedAsks(app([send]), send)).toBe(false)
    expect(await callLearned(app([send]), tool('send_message', 'Send a text message to a chat'), {}, ctx, runner)).toBe('done')
    expect(asked).toEqual([])
  })
  it('a tool that deletes, or one saved with asks_first, still asks; a trusted app never does', async () => {
    const del = tool('delete_message', 'Delete a message for everyone')
    const flagged = tool('archive_all', 'Archive every chat', { asksFirst: true })
    expect(learnedAsks(app([del]), del)).toBe(true)
    expect(learnedAsks(app([flagged]), flagged)).toBe(true)
    expect(learnedAsks(app([del], { trusted: true }), del)).toBe(false)
    const { ctx, asked } = counting()
    await callLearned(app([del]), del, {}, ctx, runner)
    expect(asked).toHaveLength(1)
  })
  it('"Ask before every change" is the opt-in, and it is kept when the tools are saved again', () => {
    const send = tool('send_message', 'Send a text message')
    expect(learnedAsks(app([send], { askFirst: true }), send)).toBe(true)
    const store = new LearnedStore(join(dir, 'learned.json'))
    store.save(app([send]))
    store.setAskFirst('whatsapp', true)
    store.save(app([send]))
    expect(new LearnedStore(join(dir, 'learned.json')).find('whatsapp')?.askFirst).toBe(true)
    store.setAskFirst('whatsapp', false)
    expect(store.find('whatsapp')?.askFirst).toBeUndefined()
  })
  it('saving tools needs no card', async () => {
    const store = new LearnedStore(join(dir, 'learned.json'))
    const save = webAppTools(store, runner).find((t) => t.spec.name === 'webapp_save')!
    const { ctx, asked } = counting()
    const out = await save.run({ name: 'Example', start_url: 'https://example.com', tools: [{ name: 'post_note', description: 'Post a note', js: 'return 1', read_only: false }] }, ctx)
    expect(out).toContain('Saved Example')
    expect(asked).toEqual([])
  })
})

describe('the app itself', () => {
  it('trusting a learned app, or taking it back, raises no card', () => {
    expect(APP_ACTION_POLICY['apps.setTrusted']?.kind).toBe('free')
    expect(APP_ACTION_POLICY['apps.setAskFirst']?.kind).toBe('free')
  })
  it('uploading an ordinary file asks nothing; a key or secrets file still asks', () => {
    expect(secretFile('C:/Users/me/Downloads/Lokshin_Life_S2_Ep6.mp4')).toBe(false)
    expect(secretFile('C:\\Users\\me\\Documents\\invoice-payment.pdf')).toBe(false)
    for (const path of ['/home/me/.env', 'C:/keys/id_ed25519', 'C:/x/server.pem', 'C:/x/passwords.kdbx', 'C:/x/api-key.txt']) expect(secretFile(path), path).toBe(true)
  })
})
