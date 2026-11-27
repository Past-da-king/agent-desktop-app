import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Tool, ToolContext } from '@agent/core'
import { OutboundClaims } from '../src/main/runtime/outbound-claims'

vi.mock('../src/main/devices/service', () => ({ getDevicesService: () => null }))
import { withOutboundClaims } from '../src/main/runtime/outbound-dispatch'
import { isComposioSend, outboundTarget } from '../src/main/runtime/outbound-targets'

const body = (json: unknown): string => 'POST https://slack.com/api/x\n200 OK\n\nBody (application/json):\n' + JSON.stringify(json)

describe('outbound target table', () => {
  it('guards every Slack send method and leaves reads alone', () => {
    for (const method of ['chat.postMessage', 'chat.scheduleMessage', 'files.completeUploadExternal', 'files.upload']) {
      expect(outboundTarget('browser_fetch', { url: 'https://slack.com/api/' + method, method: 'POST', body: '{}' })).not.toBeNull()
    }
    expect(outboundTarget('browser_fetch', { url: 'https://slack.com/api/chat.postMessage', method: 'GET' })).toBeNull()
    expect(outboundTarget('browser_fetch', { url: 'https://slack.com/api/conversations.history', method: 'POST' })).toBeNull()
    expect(outboundTarget('browser_fetch', { url: 'https://evil.example/api/chat.postMessage', method: 'POST' })).toBeNull()
  })
  it('guards Composio send slugs only', () => {
    for (const slug of ['GMAIL_SEND_EMAIL', 'GMAIL_REPLY_TO_THREAD', 'GMAIL_SEND_DRAFT', 'GMAIL_FORWARD_MESSAGE', 'OUTLOOK_SEND_EMAIL', 'OUTLOOK_OUTLOOK_SEND_EMAIL', 'OUTLOOK_REPLY_EMAIL', 'SLACK_SEND_MESSAGE', 'SLACK_CHAT_POST_MESSAGE', 'MICROSOFT_TEAMS_TEAMS_POST_CHAT_MESSAGE', 'LINKEDIN_CREATE_LINKED_IN_POST']) {
      expect(isComposioSend(slug), slug).toBe(true)
    }
    for (const slug of ['GMAIL_FETCH_EMAILS', 'GMAIL_CREATE_EMAIL_DRAFT', 'OUTLOOK_LIST_MESSAGES', 'SLACK_FETCH_CONVERSATION_HISTORY', 'FACEBOOK_GET_POST', 'GOOGLECALENDAR_CREATE_EVENT']) {
      expect(isComposioSend(slug), slug).toBe(false)
    }
  })
  it('guards the Slack files learned app send', () => {
    expect(outboundTarget('webapp_run', { app: 'Slack files', tool: 'send_file', args: { channel: 'C1' } })).not.toBeNull()
    expect(outboundTarget('webapp_test', { app: 'slack files', tool: 'send_file', args: {} })).not.toBeNull()
    expect(outboundTarget('webapp_run', { app: 'Reddit account', tool: 'my_posts', args: {} })).toBeNull()
  })
  it('reads receipts, definite failures and unknowns', () => {
    const post = outboundTarget('browser_fetch', { url: 'https://slack.com/api/chat.postMessage', method: 'POST' })!
    expect(post.outcome(body({ ok: true, ts: '1.2' }))).toEqual({ state: 'sent', result: '1.2' })
    expect(post.outcome(body({ ok: false, error: 'channel_not_found' }))).toEqual({ state: 'failed' })
    expect(post.outcome('Failed: socket hang up')).toEqual({ state: 'unknown' })
    const files = outboundTarget('browser_fetch', { url: 'https://slack.com/api/files.completeUploadExternal', method: 'POST' })!
    expect(files.outcome(body({ ok: true, files: [{ id: 'F1' }, { id: 'F2' }] }))).toEqual({ state: 'sent', result: 'F1,F2' })
    const mail = outboundTarget('apps_run', { slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'a' } })!
    expect(mail.outcome(JSON.stringify({ successful: true, data: { id: 'm1' } }))).toEqual({ state: 'sent', result: 'm1' })
    expect(mail.outcome(JSON.stringify({ successful: false, error: 'bad' }))).toEqual({ state: 'failed' })
    expect(mail.outcome('That app call failed: timeout')).toEqual({ state: 'unknown' })
    const learned = outboundTarget('webapp_run', { app: 'Slack files', tool: 'send_file', args: {} })!
    expect(learned.outcome('{"ok":true,"permalink":"https://x.slack.com/archives/C1/p1"}')).toEqual({ state: 'sent', result: 'https://x.slack.com/archives/C1/p1' })
  })
})

describe('claim wrapper', () => {
  const ctx = { requestId: 'req-1', agentLabel: 'main' } as ToolContext
  const fake = (name: string, answer: () => string): Tool => ({ spec: { name, description: '', schema: { type: 'object', properties: {} } }, run: async () => answer() })

  it('holds when no authority answers, never sending', async () => {
    let runs = 0
    const [tool] = withOutboundClaims([fake('apps_run', () => { runs++; return '{}' })], () => null)
    expect(await tool!.run({ slug: 'GMAIL_SEND_EMAIL', arguments: {} }, ctx)).toMatch(/^Send held/)
    const [down] = withOutboundClaims([fake('apps_run', () => { runs++; return '{}' })], () => ({ outboundCall: async () => { throw new Error('down') } }))
    expect(await down!.run({ slug: 'GMAIL_SEND_EMAIL', arguments: {} }, ctx)).toMatch(/^Send held/)
    expect(runs).toBe(0)
  })

  it('sends once per request and content, retries a definite failure, holds unknown, and keeps no token on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outbound-wrap-'))
    const claims = new OutboundClaims(join(dir, 'claims.sqlite'))
    const authority = { outboundCall: async (method: string, args: unknown[]) => method === 'outbound.claim' ? claims.claim(args[0] as string, 'node-a') : claims.finish(args[0] as string, 'node-a', args[1] as never) }
    let sends = 0
    let reply = JSON.stringify({ ok: true, permalink: 'https://x.slack.com/archives/C1/p1' })
    const [tool] = withOutboundClaims([fake('webapp_run', () => { sends++; return reply })], () => authority)
    const secret = 'xoxp-1234567890-SECRET-TOKEN-VALUE'
    const input = { app: 'Slack files', tool: 'send_file', args: { token: secret, channel: 'C1', paths: ['/tmp/a.pdf'] } }
    try {
      await tool!.run(input, ctx)
      expect(await tool!.run(input, ctx)).toBe('already_sent: https://x.slack.com/archives/C1/p1')
      expect(sends).toBe(1)
      const other = { ...input, args: { ...input.args, channel: 'C2' } }
      reply = '{"ok":false,"error":"not_in_channel"}'
      await tool!.run(other, ctx)
      reply = 'Failed: the page closed'
      await tool!.run(other, ctx)
      expect(sends).toBe(3)
      expect(await tool!.run(other, ctx)).toMatch(/outcome is unknown/)
      expect(sends).toBe(3)
      const files = readdirSync(dir)
      for (const file of files) expect(readFileSync(join(dir, file)).includes(secret), file).toBe(false)
    } finally {
      claims.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not claim again for a tool run on behalf of another device', async () => {
    let sends = 0
    const [tool] = withOutboundClaims([fake('apps_run', () => { sends++; return '{"successful":true}' })], () => null)
    await tool!.run({ slug: 'GMAIL_SEND_EMAIL', arguments: {} }, { ...ctx, owner: 'device' })
    expect(sends).toBe(1)
  })
})
