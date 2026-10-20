import type { MascotId } from '@agent/core'

import { outlinePath, type ShapeId } from './shapes'

/**
 * The mascot family: the same Material 3 Expressive shapes as the phone app (ui/Components.kt), each with the
 * shape it rests in and the shape it morphs to while it works. Spinning ones turn slowly while busy.
 */
interface MascotShape {
  rest: ShapeId
  busy: ShapeId
  spin: 0 | 1
  label: string
}

export const MASCOTS: Record<MascotId, MascotShape> = {
  scout: { rest: 'cookie9', busy: 'softBurst', spin: 1, label: 'Scout' },
  ghost: { rest: 'ghostish', busy: 'ghostish', spin: 0, label: 'Ghost' },
  clover: { rest: 'clover4', busy: 'clover8', spin: 1, label: 'Clover' },
  bloom: { rest: 'flower', busy: 'sunny', spin: 1, label: 'Bloom' },
  puff: { rest: 'puffy', busy: 'cookie12', spin: 0, label: 'Puff' },
  gem: { rest: 'gem', busy: 'puffyDiamond', spin: 0, label: 'Gem' },
  pebble: { rest: 'pill', busy: 'oval', spin: 0, label: 'Pebble' },
  heart: { rest: 'heart', busy: 'heart', spin: 0, label: 'Heart' },
  bun: { rest: 'bun', busy: 'arch', spin: 0, label: 'Bun' },
}

/** The order the picker shows, the same order as the phone app. */
export const MASCOT_ORDER: MascotId[] = ['scout', 'ghost', 'clover', 'bloom', 'puff', 'gem', 'pebble', 'heart', 'bun']

const cache = new Map<string, string>()

export function mascotPath(id: MascotId, busy: boolean): string {
  const key = `${id}:${busy ? 'b' : 'r'}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const m = MASCOTS[id]
  const d = outlinePath(busy ? m.busy : m.rest)
  cache.set(key, d)
  return d
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function Mascot({
  id,
  size = 48,
  busy = false,
  fill,
  needsYou = false,
}: {
  id: MascotId
  size?: number
  busy?: boolean
  fill?: string
  /** The phone's rule: the sidekick wears the person's accent, and turns amber only when it needs them. */
  needsYou?: boolean
}): JSX.Element {
  const shape = MASCOTS[id]
  const calm = mascotPath(id, false)
  const active = mascotPath(id, true)
  const reduce = prefersReducedMotion()
  const morph = busy && !reduce

  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <g>
        {morph && shape.spin === 1 ? (
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 50 50"
            to="360 50 50"
            dur="14s"
            repeatCount="indefinite"
          />
        ) : null}
        <path d={calm} fill={needsYou ? 'var(--tert)' : (fill ?? 'var(--mascot)')} style={{ transition: 'fill .3s var(--effects)' }}>
          {morph ? (
            <animate
              attributeName="d"
              dur="2.6s"
              repeatCount="indefinite"
              calcMode="spline"
              keyTimes="0;.5;1"
              keySplines=".4 0 .2 1;.4 0 .2 1"
              values={`${calm};${active};${calm}`}
            />
          ) : null}
        </path>
      </g>
      <g className="eyes" fill={needsYou ? 'var(--on-tert)' : 'var(--eye)'}>
        <ellipse cx="37.5" cy="49" rx="4.3" ry="6.4" />
        <ellipse cx="62.5" cy="49" rx="4.3" ry="6.4" />
      </g>
    </svg>
  )
}
