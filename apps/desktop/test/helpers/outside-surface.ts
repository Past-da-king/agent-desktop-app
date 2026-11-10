/**
 * The guide tests run on both drawing paths (10 Nov 2026): the page drawing its own ring, and the page only reporting
 * where the target is while something outside it draws (the private overlay window). This is that "something" for a
 * test: it draws nothing and remembers everything it was told.
 */
import { runGuide, type GuideHost, type GuideOptions, type GuideResult, type GuideStep, type GuideSurface, type GuideSurfaceStep } from '../../src/main/browser/guide'
import type { GuideReport } from '../../src/main/browser/guide-page'

export const DRAWS = ['page', 'outside'] as const
export type Draw = (typeof DRAWS)[number]

export interface RecordingSurface extends GuideSurface {
  begun: GuideSurfaceStep[]
  ended: string[]
  reports: GuideReport[]
  /** The step showing now, if any. */
  current(): GuideSurfaceStep | null
  /** The last place reported for the step showing now. */
  last(): GuideReport | null
}

export function recordingSurface(outside: () => boolean = () => true): RecordingSurface {
  const surface: RecordingSurface = {
    begun: [],
    ended: [],
    reports: [],
    outside,
    begin: (step) => {
      surface.begun.push(step)
    },
    report: (report) => {
      surface.reports.push(report)
    },
    end: (token) => {
      surface.ended.push(token)
    },
    current: () => {
      const step = surface.begun[surface.begun.length - 1]
      return step === undefined || surface.ended.includes(step.token) ? null : step
    },
    last: () => {
      const step = surface.current()
      if (step === null) return null
      for (let i = surface.reports.length - 1; i >= 0; i--) if (surface.reports[i]!.token === step.token) return surface.reports[i]!
      return null
    },
  }
  return surface
}

/** runGuide on one drawing path; `surface` is what the outside path was told (null on the page path). */
export function guideOn(draw: Draw): { run: (host: GuideHost, steps: GuideStep[], options?: GuideOptions) => Promise<GuideResult>; surface: RecordingSurface | null } {
  const surface = draw === 'outside' ? recordingSurface() : null
  return {
    surface,
    run: (host, steps, options = {}) => runGuide(host, steps, { ...options, ...(surface === null ? {} : { surface }) }),
  }
}
