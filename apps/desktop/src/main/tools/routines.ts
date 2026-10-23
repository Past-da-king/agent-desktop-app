/**
 * Routine tools, ported from reference/phone/tools/AgentTools.kt.
 *
 * A routine is a prompt the agent runs later by itself. The desktop v1 kinds are `at` (once),
 * `daily` (a time of day) and `interval` (every N minutes); the phone's email and notification
 * triggers are not part of this app.
 *
 * Creating, changing and deleting a routine raise no approval card (rule of 23 Oct 2026). Every run that holds
 * these tools is the person's own agent: the main agent or a chat he is talking to, a helper one of them started,
 * or a routine he already has (a scheduler routine that makes one `at` routine per meeting raised a card per meeting).
 * A routine is the app's own bookkeeping, not his data, and it cannot act around him: whatever it does when it
 * runs (send, pay, delete his things, touch a secret) asks there, in that run, as any other call does. The routine
 * shows on the Routines page, and in the chat as an activity line, as soon as it is made.
 */
import {
  bool,
  describeEventFilter,
  enumOf,
  int,
  parseEventFilter,
  schema,
  str,
  type Tool,
  type TriggerRow,
} from '@agent/core'

import { isBuiltinRoutine } from '../memory/routine'
import type { DataStore } from '../runtime/data'
import { parseWhen } from './tasks'

const KINDS: Array<TriggerRow['kind']> = ['at', 'daily', 'interval', 'event']
export const DEFAULT_GATHER_SECONDS = 20
const MIN_INTERVAL_MINUTES = 15

export function routineTools(store: DataStore, now: () => Date = () => new Date()): Tool[] {
  return [routineCreate(store, now), routineList(store), routineUpdate(store, now), routineDelete(store)]
}

function routineCreate(store: DataStore, now: () => Date): Tool {
  return {
    spec: {
      name: 'routine_create',
      description:
        "Create a routine: a prompt you will run later by yourself. kind 'at' = once at a time (spec an ISO date-time like 2026-10-06T07:30); 'daily' = every day (spec HH:mm); 'interval' = every N minutes (spec minutes, at least 15); 'event' = whenever a worker emits a matching event (spec a JSON filter like {\"worker\":\"w_ab12\",\"event\":\"message.*\"}; worker_list names the workers). An event routine runs in its own standing helper, its desk, which remembers earlier runs, works in `profile`, hands the work out to helpers and reports to the main agent. Suggest routines before creating one.",
      schema: schema(
        ['name', 'kind', 'spec', 'prompt'],
        {
          name: str('Short name, e.g. Morning brief'),
          kind: enumOf('When it runs', ...KINDS),
          spec: str("ISO for 'at', HH:mm for 'daily', minutes for 'interval', a JSON filter for 'event': worker and/or source, event (* as a wildcard), match {field: text}"),
          prompt: str('What you will do each time, written as an instruction to yourself. For an event routine: the standing brief of its desk (what matters, who owns what, what to hand out)'),
          gather_seconds: int('event only: gather matching events for this many seconds into one run (default 20)'),
          profile: str('event only: the profile its desk works in, by name. Leave out for General'),
          device: str('Optional, not for event routines: which linked device runs it, by name. Leave out for the best one (a linked server when it can run it).'),
        },
      ),
    },
    run: async (input, ctx) => {
      const name = text(input['name']).trim()
      const kind = kindOf(input['kind'])
      const prompt = text(input['prompt']).trim()
      if (name === '') return 'A routine needs a name.'
      if (prompt === '') return 'A routine needs a prompt: what you will do each time.'
      if (kind === null) return 'Not created: kind must be at, daily, interval or event.'

      const spec = text(input['spec']).trim()
      const problem = specProblem(kind, spec, now().getTime())
      if (problem !== null) return `Not created: ${problem}`
      const gather = gatherOf(input['gather_seconds'])
      const profile = kind === 'event' ? text(input['profile']).trim() : ''
      const device = kind === 'event' ? '' : text(input['device']).trim()

      const row = await store.upsert('trigger', {
        name,
        kind,
        spec,
        prompt,
        enabled: true,
        lastRunAt: null,
        lastResult: '',
        ...(kind === 'event' ? { gatherSeconds: gather, profile, deskId: '' } : {}),
        ...(device === '' ? {} : { device }),
      })
      await ctx.activity(`New routine: ${name}`, { tool: 'routine_create' })
      return `Routine #${row.id} created: runs ${plainSchedule(kind, spec)}.${
        kind === 'event' ? ` Events are gathered for ${gather} seconds, and one standing helper${profile === '' ? '' : ` in ${profile}`} handles every run.` : ''
      }`
    },
  }
}

function routineList(store: DataStore): Tool {
  return {
    spec: {
      name: 'routine_list',
      description: 'List the routines and when each one runs. Use it before suggesting changes.',
      schema: schema([], {}),
    },
    run: async () => {
      const rows = await store.list('trigger')
      if (rows.length === 0) return 'No routines.'
      return rows
        .map((row) => {
          const paused = row.enabled ? '' : ' (paused)'
          const builtin = isBuiltinRoutine(row) ? ' (the app runs this memory pass itself; its prompt only describes it, so change its name, time or on/off)' : ''
          const last =
            row.lastRunAt === null
              ? ''
              : ` | last ${new Date(row.lastRunAt).toISOString().slice(0, 16).replace('T', ' ')}: ${
                  row.lastResult === '' ? 'no result' : row.lastResult
                }`
          return `#${row.id} ${row.name} [${row.kind} ${row.spec}]${paused}${builtin}: ${clip(row.prompt, 100)}${last}`
        })
        .join('\n')
    },
  }
}

function routineUpdate(store: DataStore, now: () => Date): Tool {
  return {
    spec: {
      name: 'routine_update',
      description:
        "Change when a routine runs or switch it on or off, by id. spec uses the routine's own kind (HH:mm for daily). Built-in routines such as End of day can change only these two things.",
      schema: schema(['id'], {
        id: str('Routine id'),
        spec: str("New time or interval, in the routine's kind"),
        enabled: bool('true to switch it on, false to switch it off'),
      }),
    },
    run: async (input, ctx) => {
      const id = text(input['id']).trim()
      const row = await store.get('trigger', id)
      if (row === null) return `No routine #${id}.`
      const spec = text(input['spec']).trim()
      const enabled = typeof input['enabled'] === 'boolean' ? input['enabled'] : null
      if (spec === '' && enabled === null) return 'Nothing to change: pass spec, enabled or both.'
      if (spec !== '') {
        const problem = specProblem(row.kind, spec, now().getTime())
        if (problem !== null) return `Not changed: ${problem}`
      }
      const said = [spec === '' ? '' : `runs ${plainSchedule(row.kind, spec)}`, enabled === null ? '' : enabled ? 'switched on' : 'switched off']
        .filter((part) => part !== '')
        .join(' and ')
      await store.upsert('trigger', { id: row.id, ...(spec === '' ? {} : { spec }), ...(enabled === null ? {} : { enabled }) })
      await ctx.activity(`Changed routine: ${row.name}`, { tool: 'routine_update' })
      return `Routine #${row.id} now ${said}.`
    },
  }
}

function routineDelete(store: DataStore): Tool {
  return {
    spec: {
      name: 'routine_delete',
      description: 'Delete a routine by id. It stops running immediately.',
      schema: schema(['id'], { id: str('Routine id') }),
    },
    run: async (input, ctx) => {
      const id = text(input['id']).trim()
      const row = await store.get('trigger', id)
      if (row === null) return `No routine #${id}.`
      await store.remove('trigger', row.id)
      await ctx.activity(`Removed routine: ${row.name}`, { tool: 'routine_delete' })
      return 'Deleted.'
    },
  }
}

/** Null when the spec fits its kind; otherwise a line the model can pass on. */
export function specProblem(kind: TriggerRow['kind'], spec: string, now: number): string | null {
  if (kind === 'at') {
    const at = parseWhen(spec)
    if (at === null) return 'spec must be an ISO date-time, like 2026-10-06T07:30'
    if (at <= now) return 'that time is in the past'
    return null
  }
  if (kind === 'daily') return clockProblem(spec)
  if (kind === 'event') {
    const filter = parseEventFilter(spec)
    return typeof filter === 'string' ? filter : null
  }
  const minutes = Number(spec)
  if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES) {
    return `spec must be whole minutes, at least ${MIN_INTERVAL_MINUTES}`
  }
  return null
}

function clockProblem(spec: string): string | null {
  if (!/^\d{1,2}:\d{2}$/.test(spec)) return 'spec must be HH:mm'
  const [hours, minutes] = spec.split(':').map((part) => Number(part))
  if (hours === undefined || minutes === undefined) return 'spec must be HH:mm'
  if (hours > 23 || minutes > 59) return 'spec must be a real time of day'
  return null
}

function plainSchedule(kind: TriggerRow['kind'], spec: string): string {
  if (kind === 'at') return `once at ${spec.replace('T', ' ')}`
  if (kind === 'daily') return `every day at ${spec}`
  if (kind === 'event') return describeEventFilter(spec).replace(/^When/, 'when')
  return `every ${spec} minutes`
}

function gatherOf(value: unknown): number {
  const seconds = typeof value === 'number' ? value : Number(value)
  if (value === undefined || value === null || value === '' || !Number.isFinite(seconds) || seconds < 0) return DEFAULT_GATHER_SECONDS
  return Math.min(600, Math.round(seconds))
}

function kindOf(value: unknown): TriggerRow['kind'] | null {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value)
    ? (value as TriggerRow['kind'])
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...`
}

/** Kept next to the tool so a caller building a form can offer the same limit. */
export const ROUTINE_MIN_INTERVAL_MINUTES = MIN_INTERVAL_MINUTES
