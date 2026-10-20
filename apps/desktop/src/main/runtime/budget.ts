/**
 * The main agent's action budget, ported from `Budgeted` in reference/phone/AgentRuntime.kt.
 *
 * The main agent may do a small job itself, but only for a few steps per turn. Everything bigger
 * belongs to a helper. One budget is shared by every action tool, so six calls in one turn stop at
 * the limit, and it is refreshed when the person sends a message.
 */
import type { Tool } from '@agent/core'

/** The hard limit of action steps the main agent gets in one turn. */
export const MAIN_ACTION_STEPS = 5

export class StepBudget {
  used = 0

  constructor(readonly max: number = MAIN_ACTION_STEPS) {}

  reset(): void {
    this.used = 0
  }
}

/** Wrap an action tool so every call counts against the turn's budget. */
export function budgeted(inner: Tool, budget: StepBudget): Tool {
  return {
    spec: inner.spec,
    run: async (input, ctx) => {
      if (budget.used >= budget.max) {
        return `Step limit: you've used your ${budget.max} steps for this turn. This job is bigger than a quick one, so hand it to a helper with delegate and put what you've found so far in the brief.`
      }
      budget.used++
      return inner.run(input, ctx)
    },
  }
}
