/**
 * The helper tools the MAIN agent uses to hand work out and keep an eye on it, ported from
 * reference/phone/tools/AgentTools.kt. The helpers themselves are in runtime/helpers.ts.
 */
import { bool, schema, str, type JsonObject, type Tool } from '@agent/core'

import type { HelperHost, HelperTask } from '../runtime/helpers'

export function helperTools(host: HelperHost): Tool[] {
  return [
    delegateTool(host),
    helperSteerTool(host),
    helperPushTool(host),
    helpersStatusTool(host),
    helperStopTool(host),
  ]
}

function delegateTool(host: HelperHost): Tool {
  return {
    spec: {
      name: 'delegate',
      description:
        'Set helper agents working in the background. They do the actual work: searching, reading pages, memory and tasks. Each brief must stand alone: the goal, everything you know that matters (names, dates, the user\'s preferences and constraints from memory), exactly what to do or find, what to hand back, and anything that needs the user\'s approval. Returns at once; each helper\'s result arrives later as a message from it. Several briefs run at the same time.',
      schema: schema(['tasks'], {
        tasks: {
          type: 'array',
          description: 'Self-contained briefs, one per helper, as many as the work needs. They all start at once.',
          items: {
            type: 'object',
            properties: {
              label: str('A 2 to 4 word name per helper, e.g. Uber to airport. The user sees this.'),
              brief: str('The full, standalone brief for this helper'),
              model: str(
                'Optional. Which of the HELPER MODELS (listed in your instructions) runs this job, by its name there, e.g. "Claude plan · opus". Pick by what the job needs. Leave it out for the first one.',
              ),
              profile: str(
                "The user's profile this helper works in (e.g. Work). It can then only use that profile's connected accounts, learned apps and browser sign-ins. Leave it out for General: none of their accounts.",
              ),
              device: str(
                "Optional: where it runs. Leave it out (best): a linked server takes jobs that do not need this computer, so this computer keeps its resources; it looks the same here either way. 'here' keeps it on this computer (its files, its signed-in browser, its screen); or name a linked device.",
              ),
            },
            required: ['label', 'brief'],
          },
        },
        profiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional, the same as each task\'s profile, in task order (for briefs written without it).',
        },
        together: bool(
          'These briefs are parts of ONE answer: hold every result until all are done and hand them to you as one message. Default false.',
        ),
      }),
    },
    run: async (input, ctx) => {
      const tasks = parseTasks(input['tasks'], input['profiles'])
      if (tasks.length === 0) return 'No tasks given.'
      // A helper reports back to the chat that started it.
      return ctx.chat === undefined
        ? host.delegate(tasks, input['together'] === true)
        : host.delegate(tasks, input['together'] === true, { chat: ctx.chat })
    },
  }
}

function helperSteerTool(host: HelperHost): Tool {
  return {
    spec: {
      name: 'helper_steer',
      description:
        'Send a helper more information or a correction while it works ("the user means the 7pm show, not 9pm"). It reads it before its next step and keeps going. On a helper that already finished it sends it back to work.',
      schema: schema(['id', 'message'], {
        id: str('Helper id, from delegate or helpers_status'),
        message: str('What it needs to know, as an instruction to it'),
      }),
    },
    run: async (input) => host.steer(text(input['id']), text(input['message'])),
  }
}

function helperPushTool(host: HelperHost): Tool {
  return {
    spec: {
      name: 'helper_push',
      description:
        'Send a finished helper back to work: it keeps everything it found and carries on with your message. Use it when a helper says it cannot, or its result is thin: name a concrete next thing to try and tell it you believe it can do it.',
      schema: schema(['id', 'message'], {
        id: str('Helper id'),
        message: str('What to try next, plus encouragement'),
      }),
    },
    run: async (input) => host.push(text(input['id']), text(input['message'])),
  }
}

function helpersStatusTool(host: HelperHost): Tool {
  return {
    spec: {
      name: 'helpers_status',
      description:
        'See every helper: running ones with their latest steps, and recently finished ones with their results.',
      schema: schema([], {}),
    },
    run: async () => host.status(),
  }
}

function helperStopTool(host: HelperHost): Tool {
  return {
    spec: {
      name: 'helper_stop',
      description:
        'Stop a running helper by its id (from delegate or helpers_status). Then delegate again with a better brief if the work is still needed.',
      schema: schema(['id'], {
        id: str('Helper id'),
      }),
    },
    run: async (input) => {
      const id = text(input['id'])
      return (await host.stop(id))
        ? `Stopped helper #${id}.`
        : `No running helper #${id}.`
    },
  }
}

export function parseTasks(value: unknown, profiles?: unknown): HelperTask[] {
  if (!Array.isArray(value)) return []
  const byOrder = Array.isArray(profiles) ? profiles.map((p) => text(p).trim()) : []
  const tasks: HelperTask[] = []
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    const brief = text(row['brief']).trim()
    if (brief === '') continue
    const label = text(row['label']).trim()
    const model = text(row['model']).trim()
    const profile = text(row['profile']).trim() || (byOrder[index] ?? '')
    const device = text(row['device']).trim()
    tasks.push({ label, brief, ...(model === '' ? {} : { model }), ...(profile === '' ? {} : { profile }), ...(device === '' ? {} : { device }) })
  }
  return tasks
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
