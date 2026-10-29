/**
 * The trusted host side of mini-apps, behind one small interface so the engine under it can be swapped
 * (docs/plans/mini-apps.md, "Cordis verdict"). Each saved mini-app is loaded as one plugin, built by HOST code from
 * its row (never from agent-written code): its bridge sessions, data subscriptions and refresh timers are effects of
 * that plugin, so unloading it (an edit reloads, a delete unloads) takes every one of them away at once.
 *
 * Two engines: Cordis (@deepseek-ai/cordis, MIT, pinned to 4.0.5 in package.json: a plugin kernel with services and
 * effects undone on unload) and a plain registry with the same dispose model, used when Cordis cannot start. Agent-
 * written code never runs here: it runs in the sandboxed frame (main/miniapps/protocol.ts) and only sends messages.
 */
import { Context } from '@deepseek-ai/cordis'

/** One plugin's lifetime: effects started in it are stopped when it is disposed (or when the effect is stopped). */
export interface Scope {
  /** Starts something that must stop with the plugin; returns a stopper for stopping it sooner. */
  effect(start: () => () => void, label?: string): () => void
  readonly active: boolean
  dispose(): Promise<void>
}

export interface PluginHost {
  readonly kind: 'cordis' | 'plain'
  /** A host service plugins may inject (tools, data, calendar). */
  provide(name: string, value: object): void
  /** Loads one plugin: apply runs at once with the services it injects. */
  load(name: string, inject: string[], apply: (scope: Scope, services: Record<string, unknown>) => void): Scope
  dispose(): Promise<void>
}

// ---- Cordis --------------------------------------------------------------------------------------------------------

interface CordisFiber {
  dispose(): Promise<void>
}

interface CordisCtx {
  effect(execute: () => () => void, label?: string): (() => unknown) & { then?: unknown }
  plugin(plugin: { name: string; inject?: string[]; apply: (ctx: CordisCtx) => void }, config?: unknown): CordisFiber
  provide(name: string): unknown
  get(name: string): unknown
  [service: string]: unknown
}

export function cordisHost(): PluginHost {
  const root = new Context() as unknown as CordisCtx
  const fibers = new Set<CordisFiber>()
  return {
    kind: 'cordis',
    provide(name, value) {
      root.provide(name)
      root[name] = value
    },
    load(name, inject, apply) {
      let active = true
      let ctx: CordisCtx | null = null
      const fiber = root.plugin({
        name,
        inject,
        apply(pluginCtx) {
          ctx = pluginCtx
          const services: Record<string, unknown> = {}
          for (const key of inject) services[key] = pluginCtx[key]
          apply(scope, services)
        },
      })
      fibers.add(fiber)
      const scope: Scope = {
        get active() {
          return active
        },
        effect(start, label) {
          if (!active || ctx === null) {
            // Not running (or gone): nothing starts, nothing to stop.
            return () => undefined
          }
          const stop = ctx.effect(start, label)
          return () => {
            void Promise.resolve(stop()).catch(() => undefined)
          }
        },
        async dispose() {
          if (!active) return
          active = false
          fibers.delete(fiber)
          await fiber.dispose()
        },
      }
      return scope
    },
    async dispose() {
      for (const fiber of [...fibers]) await fiber.dispose().catch(() => undefined)
      fibers.clear()
    },
  }
}

// ---- plain -------------------------------------------------------------------------------------------------------

export function plainHost(): PluginHost {
  const services = new Map<string, unknown>()
  const scopes = new Set<Scope>()
  return {
    kind: 'plain',
    provide(name, value) {
      services.set(name, value)
    },
    load(_name, inject, apply) {
      let active = true
      const stops = new Set<() => void>()
      const scope: Scope = {
        get active() {
          return active
        },
        effect(start) {
          if (!active) return () => undefined
          const stop = start()
          let done = false
          const once = (): void => {
            if (done) return
            done = true
            stops.delete(once)
            stop()
          }
          stops.add(once)
          return once
        },
        async dispose() {
          if (!active) return
          active = false
          scopes.delete(scope)
          for (const stop of [...stops].reverse()) stop()
        },
      }
      scopes.add(scope)
      const given: Record<string, unknown> = {}
      for (const key of inject) given[key] = services.get(key)
      apply(scope, given)
      return scope
    },
    async dispose() {
      for (const scope of [...scopes]) await scope.dispose()
    },
  }
}

/** Cordis when it starts; the plain registry (same behaviour) when it cannot, with the reason logged. */
export function createPluginHost(log: (message: string, detail?: Record<string, unknown>) => void = () => undefined, prefer: 'cordis' | 'plain' = 'cordis'): PluginHost {
  if (prefer === 'plain') return plainHost()
  try {
    return cordisHost()
  } catch (error) {
    log('Mini-apps: Cordis did not start, using the plain host', { message: error instanceof Error ? error.message : String(error) })
    return plainHost()
  }
}
