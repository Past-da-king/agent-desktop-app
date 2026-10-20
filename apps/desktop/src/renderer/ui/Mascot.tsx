import type { MascotId } from '@agent/core'

/**
 * The mascot family, ported from design/mockup.html. The same rounded polygons as the phone app:
 * a wavy blob (scout, bloom, clover, puff, ghost), a superellipse (gem, pebble, bun), and a heart.
 * `busy` morphs the outline and, for some mascots, slowly spins.
 */
interface MascotShape {
  k: 'w' | 's' | 'h'
  n?: number
  a?: number
  bn?: number
  ba?: number
  p?: number
  bp?: number
  rot?: number
  spin: 0 | 1
  label: string
}

export const MASCOTS: Record<MascotId, MascotShape> = {
  scout: { k: 'w', n: 9, a: 0.07, bn: 9, ba: 0.17, spin: 1, label: 'Scout' },
  bloom: { k: 'w', n: 5, a: 0.2, bn: 5, ba: 0.3, spin: 1, label: 'Bloom' },
  clover: { k: 'w', n: 4, a: 0.22, bn: 8, ba: 0.12, spin: 1, label: 'Clover' },
  puff: { k: 'w', n: 8, a: 0.09, bn: 12, ba: 0.07, spin: 0, label: 'Puff' },
  gem: { k: 's', p: 1.55, bp: 1.25, rot: Math.PI / 4, spin: 0, label: 'Gem' },
  pebble: { k: 's', p: 2.9, bp: 2, rot: 0, spin: 0, label: 'Pebble' },
  heart: { k: 'h', spin: 0, label: 'Heart' },
  ghost: { k: 'w', n: 7, a: 0.11, bn: 11, ba: 0.16, spin: 0, label: 'Ghost' },
  bun: { k: 's', p: 2, bp: 1.65, rot: 0, spin: 0, label: 'Bun' },
}

/** The order the picker shows, matching the mockup and adding the two extra mascots at the end. */
export const MASCOT_ORDER: MascotId[] = [
  'scout',
  'bloom',
  'clover',
  'puff',
  'gem',
  'pebble',
  'heart',
  'ghost',
  'bun',
]

const cache = new Map<string, string>()

export function mascotPath(id: MascotId, busy: boolean): string {
  const key = `${id}:${busy ? 'b' : 'r'}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit

  const m = MASCOTS[id]
  const N = 120
  const pts: Array<[number, number]> = []

  if (m.k === 'h') {
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < N; i += 1) {
      const t = (i / N) * 2 * Math.PI
      xs.push(16 * Math.sin(t) ** 3)
      ys.push(-(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)))
    }
    const x0 = Math.min(...xs)
    const x1 = Math.max(...xs)
    const y0 = Math.min(...ys)
    const y1 = Math.max(...ys)
    const s = 88 / Math.max(x1 - x0, y1 - y0)
    for (let i = 0; i < N; i += 1) {
      const x = xs[i] ?? 0
      const y = ys[i] ?? 0
      pts.push([50 + (x - (x0 + x1) / 2) * s, 52 + (y - (y0 + y1) / 2) * s])
    }
  } else {
    for (let i = 0; i < N; i += 1) {
      const th = (i / N) * 2 * Math.PI - Math.PI / 2
      let r: number
      if (m.k === 'w') {
        const n = busy ? (m.bn ?? 9) : (m.n ?? 9)
        const a = busy ? (m.ba ?? 0.12) : (m.a ?? 0.1)
        r = 1 - a + a * Math.cos(n * (th + Math.PI / 2))
      } else {
        const p = busy ? (m.bp ?? 2) : (m.p ?? 2)
        const rot = m.rot ?? 0
        const c = Math.abs(Math.cos(th - rot))
        const s = Math.abs(Math.sin(th - rot))
        r = 1 / (c ** p + s ** p) ** (1 / p)
      }
      pts.push([50 + 46 * r * Math.cos(th), 50 + 46 * r * Math.sin(th)])
    }
  }

  const d = `M${pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('L')}Z`
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
}: {
  id: MascotId
  size?: number
  busy?: boolean
  fill?: string
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
        <path d={calm} fill={fill ?? 'var(--mascot)'}>
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
      <g className="eyes" fill="var(--eye)">
        <ellipse cx="37.5" cy="49" rx="4.3" ry="6.4" />
        <ellipse cx="62.5" cy="49" rx="4.3" ry="6.4" />
      </g>
    </svg>
  )
}
