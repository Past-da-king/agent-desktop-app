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

  const color = needsYou ? 'var(--tert)' : (fill ?? 'var(--mascot)')
  const layer = { position: 'absolute', inset: 0, width: size, height: size } as const
  // Cheap while busy: the shape change is a cross-fade between two stacked SVGs and the turning is a rotation of
  // the wrapper, both transform/opacity animations the compositor runs without any layout, style or path work.
  return (
    <span className="mascot" style={{ position: 'relative', display: 'inline-block', width: size, height: size, flex: 'none' }} aria-hidden="true">
      <span className={morph && shape.spin === 1 ? 'mascot-spin' : undefined} style={{ ...layer, display: 'block' }}>
        <svg viewBox="0 0 100 100" className={morph ? 'mascot-calm' : undefined} style={layer}>
          <path d={calm} fill={color} />
        </svg>
        {morph ? (
          <svg viewBox="0 0 100 100" className="mascot-busy" style={layer}>
            <path d={active} fill={color} />
          </svg>
        ) : null}
      </span>
      <svg viewBox="0 0 100 100" style={layer}>
        <g className="eyes" fill={needsYou ? 'var(--on-tert)' : 'var(--eye)'}>
          <ellipse cx="37.5" cy="49" rx="4.3" ry="6.4" />
          <ellipse cx="62.5" cy="49" rx="4.3" ry="6.4" />
        </g>
      </svg>
    </span>
  )
}
