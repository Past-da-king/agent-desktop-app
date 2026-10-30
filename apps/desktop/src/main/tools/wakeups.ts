/**
 * wake_me, wake_withdraw, wake_list: every agent, helper, routine and desk (desktop app and headless node) can make
 * the person's devices ring until he answers (shared/wakeups.ts, main/wakeups/service.ts). There is deliberately no
 * tool that answers, snoozes or silences a wake: only his hands do that, on a ringing device or in Settings.
 *
 * Generic: what is worth waking him for is the agent's judgement (the description below), and which people, chats
 * or calendars matter comes from memory, desk briefs and routines, never from code.
 */
import { enumOf, int, schema, str, type JsonObject, type Tool } from '@agent/core'

import { DEVICE_CHOICES, isSeverity, logLine, SEVERITIES, type WakeDevices } from '../../shared/wakeups'
import type { WakeupService } from '../wakeups/service'

const SOURCE: JsonObject = {
  type: 'object',
  description: 'Where it came from: kind (meeting, slack, mail, routine, agent...), ref (its id, e.g. the event or message id) and link (the join link or thread link the Open button opens)',
  properties: {
    kind: { type: 'string', description: 'meeting, slack, mail, routine, agent, ...' },
    ref: { type: 'string', description: 'Its id at the source' },
    link: { type: 'string', description: 'https link the Open button opens' },
  },
}

export const WAKE_ME_DESCRIPTION =
  "Make the user's devices RING until he answers: a loud looping alarm and a full-screen screen in the severity colour on his phone (through Do Not Disturb) and computer, saying exactly what_to_do. It never stops by itself; only he can answer (I'm on it / Snooze / Open), and an answer on one device stops all of them. Use it only when something needs him NOW: a person he works for explicitly needs him right now, a meeting is about to start or has started without him, a live outage, a deadline about to be missed. FYI, newsletters, routine updates and anything that can wait for him to read later NEVER wake him (send a normal notification instead). severity: critical (red: every device at once, also in quiet hours; real emergencies only), urgent (amber: where he is, every device after 60 s without an answer), heads_up (green: where he is, silent in his quiet hours). devices: auto (where he is, the default), here (this computer), all. at: ISO time to ring later (e.g. a meeting's start minus 5 min), or in_minutes; leave both out to ring now. dedupe_key: the same key within 10 minutes merges into the wake already there (no double ring) and moves a booked one: use the source's id plus what it is for, e.g. '<event id>|5'. A computer that is paused, idle or locked holds back while his phone rings; it rings anyway if no phone is linked or none confirms within 30 s. Every wake is listed in his Wake-ups log with who fired it and why."

export function wakeTools(wakeups: () => WakeupService | null, now: () => number = Date.now): Tool[] {
  const service = (): WakeupService => {
    const found = wakeups()
    if (found === null) throw new Error('Wake-ups are not running in this app.')
    return found
  }
  return [
    {
      spec: {
        name: 'wake_me',
        description: WAKE_ME_DESCRIPTION,
        schema: schema(['severity', 'title', 'what_to_do'], {
          severity: enumOf('critical, urgent or heads_up', ...SEVERITIES),
          title: str('Short, what it is: "Standup with the product team starts now"'),
          what_to_do: str('Exactly what he must do, in plain words: "Join the standup on Teams; Thabo is presenting your numbers"'),
          source: SOURCE,
          devices: enumOf('auto (where he is, default), here (this computer), all', ...DEVICE_CHOICES),
          dedupe_key: str("Merges repeats within 10 minutes and moves a booked wake: e.g. '<event id>|15'"),
          at: str('ISO date-time to ring at (local time unless it has an offset); leave out to ring now'),
          in_minutes: int('Ring this many minutes from now, instead of at'),
        }),
      },
      run: async (input, ctx) => {
        const severity = input['severity']
        if (!isSeverity(severity)) return 'severity must be critical, urgent or heads_up.'
        const devicesRaw = typeof input['devices'] === 'string' ? input['devices'] : 'auto'
        const devices: WakeDevices = (DEVICE_CHOICES as readonly string[]).includes(devicesRaw) ? (devicesRaw as WakeDevices) : 'auto'
        let at: number | null = null
        if (typeof input['at'] === 'string' && input['at'].trim() !== '') {
          at = Date.parse(input['at'].trim())
          if (!Number.isFinite(at)) return `at "${input['at']}" is not a date-time; use ISO like 2026-10-29T14:55.`
        } else if (typeof input['in_minutes'] === 'number' && Number.isFinite(input['in_minutes']) && input['in_minutes'] > 0) {
          at = now() + Math.round(input['in_minutes'] * 60_000)
        }
        const raw = input['source']
        const src = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
        const link = typeof src['link'] === 'string' && /^https?:\/\//i.test(src['link'].trim()) ? src['link'].trim().slice(0, 1000) : ''
        const result = await service().fire(
          {
            severity,
            title: typeof input['title'] === 'string' ? input['title'] : '',
            whatToDo: typeof input['what_to_do'] === 'string' ? input['what_to_do'] : '',
            source: {
              kind: typeof src['kind'] === 'string' && src['kind'].trim() !== '' ? src['kind'].trim().slice(0, 40) : typeof raw === 'string' ? raw.slice(0, 40) : 'agent',
              ref: typeof src['ref'] === 'string' ? src['ref'].slice(0, 300) : '',
              link,
            },
            devices,
            dedupeKey: typeof input['dedupe_key'] === 'string' ? input['dedupe_key'].trim().slice(0, 300) : '',
            at,
          },
          ctx.agentLabel ?? 'agent',
        )
        if (result.ok) await ctx.activity(`Wake-up: ${typeof input['title'] === 'string' ? input['title'].slice(0, 100) : ''}`, { tool: 'wake_me', line: true })
        return result.message
      },
    },
    {
      spec: {
        name: 'wake_withdraw',
        description:
          "Take back a wake-up that has not rung yet (by its id or its dedupe_key), e.g. the meeting it was booked for was cancelled or he already joined. A wake that is already ringing cannot be silenced by an agent: it keeps ringing until he answers, and its screen then says 'Cancelled: <title>'.",
        schema: schema(['id'], { id: str('The wake id (or its first 8 characters) or its dedupe_key') }),
      },
      run: async (input) => {
        const id = typeof input['id'] === 'string' ? input['id'] : ''
        if (id.trim() === '') return 'Pass the wake id or dedupe_key.'
        return service().withdraw(id)
      },
    },
    {
      spec: {
        name: 'wake_list',
        description: 'The Wake-ups log: recent and booked wake-ups, newest first, with state (rings at, ringing, snoozed, answered, withdrawn), who fired each and why. Read it before booking so you do not book twice.',
        schema: schema([], { limit: int('How many, default 20') }),
      },
      run: async (input) => {
        const limit = typeof input['limit'] === 'number' ? input['limit'] : 20
        const views = await service().list(limit)
        if (views.length === 0) return 'No wake-ups yet.'
        return views.map((v) => `#${v.id.slice(0, 8)} ${logLine(v, clock, service().selfId())}${v.dedupeKey === '' ? '' : ` [key ${v.dedupeKey}]`}`).join('\n')
      },
    },
  ]
}

function clock(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
