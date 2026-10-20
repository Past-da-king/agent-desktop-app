/**
 * Connected apps through Composio, with the person's own key. Names and wording follow reference
 * phone tools/Composio.kt (AppsListTool, AppsConnectTool, AppsFindToolsTool, AppsRunTool) and the
 * guarded run in AgentRuntime.kt. Every action goes through the per-account rules in AppGuard.
 */
import { int, schema, str, type JsonObject, type Tool } from '@agent/core'

import { appName } from '../apps/catalog'
import { NO_KEY, type AppsService } from '../apps/service'

const CONNECT = 'Connect'
const DECLINE = 'Decline'

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function failure(cause: unknown): string {
  return `Error: ${cause instanceof Error ? cause.message : String(cause)}`
}

export function appTools(apps: AppsService | undefined): Tool[] {
  if (apps === undefined) return []
  return [connectedTool(apps), findToolsTool(apps), runTool(apps), connectTool(apps)]
}

function connectedTool(apps: AppsService): Tool {
  return {
    spec: {
      name: 'apps_connected',
      description: "List the person's connected apps (Gmail, Calendar, Drive, Slack... via Composio), with each account and what it allows.",
      schema: schema([], {}),
    },
    run: async () => {
      if (apps.backend() === null) return NO_KEY
      try {
        const list = await apps.accounts()
        if (list.length === 0) return 'No apps connected yet. Use apps_connect to offer one.'
        return list
          .map((a) => {
            const r = apps.rulesFor(a.id)
            return `${a.app}: ${a.status} · ${a.label} · account ${a.id} · reading ${r.read}, changing ${r.change}`
          })
          .join('\n')
      } catch (cause) {
        return failure(cause)
      }
    },
  }
}

function findToolsTool(apps: AppsService): Tool {
  return {
    spec: {
      name: 'apps_find_tools',
      description:
        "Find the actions available in a connected app (for example toolkit gmail, query 'search unread'). Returns tool slugs with their parameters, for apps_run.",
      schema: schema(['query'], {
        query: str('What you want to do'),
        toolkit: str('Toolkit slug to search within'),
        limit: int('Max results, default 6'),
      }),
    },
    run: async (input) => {
      const backend = apps.backend()
      if (backend === null) return NO_KEY
      const raw = input['limit']
      const limit = typeof raw === 'number' && raw > 0 ? Math.min(Math.floor(raw), 20) : 6
      try {
        return await backend.findTools(text(input['query']), text(input['toolkit']).trim().toLowerCase(), limit)
      } catch (cause) {
        return failure(cause)
      }
    },
  }
}

function runTool(apps: AppsService): Tool {
  return {
    spec: {
      name: 'apps_run',
      description:
        "Run one action in a connected app by its tool slug (from apps_find_tools), for example GMAIL_FETCH_EMAILS. Each account's rules decide: reading and changing are each allowed, ask the person first, or never.",
      schema: schema(['slug', 'arguments'], {
        slug: str('Tool slug'),
        arguments: { type: 'object', description: "Arguments per the tool's parameters" },
        account: str('Which account, when the app has several connected: the account id from apps_connected'),
      }),
    },
    run: async (input, ctx) => {
      const backend = apps.backend()
      if (backend === null) return NO_KEY
      const slug = text(input['slug']).trim().toUpperCase()
      if (!/^[A-Z0-9_]{3,120}$/.test(slug)) return 'Pass the tool slug from apps_find_tools, for example GMAIL_FETCH_EMAILS.'
      const rawArgs = input['arguments']
      const args: JsonObject =
        rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as JsonObject) : {}
      const named = text(input['account']).trim()
      const detail = JSON.stringify(args, null, 2).slice(0, 1500)
      const verdict = await apps.guard.check(ctx, [slug], named === '' ? null : named, detail)
      if (verdict.refuse !== undefined) return verdict.refuse
      const what = slug.toLowerCase().replace(/_/g, ' ')
      const id = await ctx.activity(`Using ${what}`, { tool: 'apps' })
      try {
        const res = await backend.execute(slug, args, verdict.account)
        await ctx.updateActivity(id, `${res.ok ? 'Used' : 'Failed:'} ${what}`, { tool: 'apps' })
        return res.text
      } catch (cause) {
        await ctx.updateActivity(id, `Failed: ${what}`, { tool: 'apps' })
        return failure(cause)
      }
    },
  }
}

/**
 * The agent connects an app itself when it needs one: it asks, the person says Connect, the sign-in
 * opens in their own browser, and the tool waits until Composio reports it connected.
 */
function connectTool(apps: AppsService): Tool {
  return {
    spec: {
      name: 'apps_connect',
      description:
        "Connect an app the task needs (for example gmail, googlecalendar, googledrive, googledocs, slack, notion). Asks the person, opens the sign-in in their browser, and waits until it is connected (up to 5 minutes). Never paste sign-in links yourself.",
      schema: schema(['toolkit', 'reason'], {
        toolkit: str('Composio toolkit slug, lower case'),
        reason: str("What you need it for, finishing 'so I can...'"),
      }),
    },
    run: async (input, ctx) => {
      if (apps.backend() === null) return NO_KEY
      const slug = text(input['toolkit']).trim().toLowerCase()
      if (!/^[a-z0-9_]{2,60}$/.test(slug)) return 'Pass the toolkit slug, for example gmail.'
      const name = appName(slug)
      let existing: number
      try {
        existing = (await apps.activeAccounts([slug])).length
      } catch (cause) {
        return failure(cause)
      }
      const reason = text(input['reason']).trim().replace(/^so I can /i, '').replace(/[.?]+$/, '')
      const question =
        (existing > 0 ? `Connect another ${name} account` : `Connect ${name}`) + (reason === '' ? '?' : ` so I can ${reason}?`)
      const answer = await ctx.ask(question, [CONNECT, DECLINE])
      if (answer === null) return `Nobody is around to connect ${name}. Tell the person they can connect it in Connections.`
      if (answer !== CONNECT) {
        return `The person declined connecting ${name}${answer !== DECLINE ? ` and said: ${answer}` : ''}. Carry on without it.`
      }
      let started: Awaited<ReturnType<AppsService['begin']>>
      try {
        started = await apps.begin(slug)
      } catch (cause) {
        return `Could not start connecting ${name}: ${cause instanceof Error ? cause.message : String(cause)}`
      }
      const id = await ctx.activity(`Waiting for you to sign in to ${name}`, { tool: 'apps' })
      const result = await started.wait(ctx.signal)
      await ctx.updateActivity(id, result === 'connected' ? `${name} connected` : `${name} sign-in not finished`, { tool: 'apps' })
      if (result === 'connected') return `${name} (${slug}) is connected now. Carry on with the task.`
      if (result === 'stopped') return 'Stopped.'
      return `The person has not finished signing in to ${name} yet. Do not paste a link; say you will continue once it is connected (they can also connect it in Connections).`
    },
  }
}
