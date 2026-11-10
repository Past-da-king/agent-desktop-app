/**
 * screen_guide ("show me how", 10 Nov 2026): the guided click-through of browser_guide, on WHATEVER window the person
 * is on (Chrome, any desktop program), not only the app's own browser. A ring and a short label on the next thing to
 * use, his own click is the feedback, the next step appears at once. Nothing is clicked or typed for him, and the
 * ring is drawn in a window that screen sharing does not see.
 *
 * The person starts the same walk himself from the quick chat bar ("how do I..."); this is the agent's way in.
 */
import { int, schema, str, type JsonObject, type Tool } from '@agent/core'

import { MAX_STEPS, stepFrom, type ShowStep } from '../showme/planner'

/** The part of showme/service.ts ShowMeService the tool needs. */
export interface ScreenGuideHost {
  guide(request: { question: string; steps?: ShowStep[]; timeoutMs?: number; owner?: string }, signal?: AbortSignal): Promise<string>
}

export interface ScreenGuideToolDeps {
  /** Absent on a device with no screen of his to guide on (a headless node). */
  showMe?: () => ScreenGuideHost | null
}

const NO_SCREEN = 'Guiding on his screen needs the computer he is at, and this device cannot do it.'

const STEP_FIELDS: Record<string, JsonObject> = {
  label: str('What he should do, a few words: "Click Create pixel", "Paste the pixel name"'),
  name: str('The element as his screen shows it: the button text, the field label, the menu item'),
  role: str('button, link, textbox, checkbox, combobox, tab, menuitem, listitem (optional)'),
  nth: int('Which one when several share the name, 1 is the first'),
  value: str('Clipboard fill for a field: the value goes on his clipboard and the label says so, so he only pastes. A {{vault:REF}} placeholder works and is never shown'),
  sensitive: { type: 'boolean', description: 'The value is secret: the label names only the field, the value is never shown or kept, and the clipboard is cleared after his paste' },
}

export function screenGuideTools(deps: ScreenGuideToolDeps): Tool[] {
  return [
    {
      spec: {
        name: 'screen_guide',
        description:
          "Show the person how to do something on HIS OWN screen, in whatever window he is on (Chrome, any desktop program): a ring and a short label on the next thing to use, he clicks it himself, the next step appears at once. Nothing is clicked for him, and screen sharing does not see the ring. Use it when he asks to be shown how, or a step needs his own hands outside your browser. Give `question` (what he wants to do) and it finds the route itself: a matching skill page in memory or a learned app when there is one, else it plans from what is on his screen with a small fast model. Give `steps` when you already know the route (each {label, name, role}); a step with `value` puts that text on his clipboard so he only pastes (a {{vault:REF}} or sensitive value is never shown, and the clipboard is cleared after). Returns when he finishes, presses Esc, or it times out, with what he did at each step. For a page in YOUR browser use browser_guide instead.",
        schema: schema(['question'], {
          question: str('What he wants to do, in his words: "create a pixel", "export this sheet as PDF"'),
          steps: {
            type: 'array',
            description: 'The route, when you already know it: steps in order, each {label, name, role?, nth?, value?, sensitive?}. Leave out to have it planned.',
            items: { type: 'object', properties: STEP_FIELDS, required: ['name'] },
          },
          timeout_seconds: int('How long he has for the whole walk, default 600 (10 to 1800)'),
        }),
      },
      run: async (input, ctx) => {
        const host = deps.showMe?.() ?? null
        if (host === null) return NO_SCREEN
        const question = typeof input['question'] === 'string' ? input['question'].replace(/\s+/g, ' ').trim() : ''
        const raw = Array.isArray(input['steps']) ? input['steps'] : []
        if (question === '' && raw.length === 0) return 'Say what he wants to do (question), or give the steps.'
        if (raw.length > MAX_STEPS) return `At most ${MAX_STEPS} steps in one walk.`
        const steps: ShowStep[] = []
        for (const [i, item] of raw.entries()) {
          const step = stepFrom(item)
          if (step === null) return `Step ${i + 1}: say which element by its name on screen.`
          steps.push(step)
        }
        const seconds = typeof input['timeout_seconds'] === 'number' && Number.isFinite(input['timeout_seconds']) ? Math.min(1800, Math.max(10, Math.floor(input['timeout_seconds']))) : 600
        try {
          return await host.guide({ question: question || steps.map((step) => step.label).join(', '), ...(steps.length > 0 ? { steps } : {}), timeoutMs: seconds * 1000, owner: ctx.owner ?? ctx.agentLabel }, ctx.signal)
        } catch (error) {
          return `The walk had a problem: ${error instanceof Error ? error.message : String(error)}`
        }
      },
    },
  ]
}
