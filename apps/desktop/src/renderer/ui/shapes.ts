/**
 * Material 3 Expressive shapes, ported from androidx `MaterialShapes.kt` (the same definitions the phone app's
 * mascots use), so a sidekick on the desktop is the same silhouette as on the phone.
 *
 * A shape is a polygon whose vertices each carry a corner rounding (radius, smoothing), in the unit square with its
 * centre at (0.5, 0.5). `outline()` rounds the corners with cubic curves, then resamples the outline to a fixed
 * number of points starting at the top, so any two shapes can morph into each other point by point (the SVG
 * `<animate attributeName="d">` in Mascot.tsx needs identical path structure on both ends).
 */

type Pt = [number, number]
interface Rounding {
  r: number
  s: number
}
interface Vertex {
  p: Pt
  round: Rounding
}

const NONE: Rounding = { r: 0, s: 0 }
const R = (r: number, s = 0): Rounding => ({ r, s })

const rad = (deg: number): number => (deg / 180) * Math.PI
const deg = (a: number): number => (a * 180) / Math.PI

function rotate(points: Vertex[], degrees: number, c: Pt = [0.5, 0.5]): Vertex[] {
  const a = rad(degrees)
  return points.map(({ p, round }) => {
    const x = p[0] - c[0]
    const y = p[1] - c[1]
    return { p: [x * Math.cos(a) - y * Math.sin(a) + c[0], x * Math.sin(a) + y * Math.cos(a) + c[1]], round }
  })
}

function scale(points: Vertex[], sx: number, sy: number, c: Pt = [0.5, 0.5]): Vertex[] {
  return points.map(({ p, round }) => ({ p: [(p[0] - c[0]) * sx + c[0], (p[1] - c[1]) * sy + c[1]], round }))
}

/** androidx `doRepeat` + `customPolygon`. */
function custom(pnr: Array<[Pt, Rounding?]>, reps: number, mirroring = false): Vertex[] {
  const c: Pt = [0.5, 0.5]
  const pts = pnr.map(([p, r]) => ({ p, round: r ?? NONE }))
  if (!mirroring) {
    const out: Vertex[] = []
    for (let i = 0; i < pts.length * reps; i += 1) {
      const v = pts[i % pts.length] as Vertex
      out.push(rotate([v], (Math.floor(i / pts.length) * 360) / reps, c)[0] as Vertex)
    }
    return out
  }
  const angles = pts.map(({ p }) => deg(Math.atan2(p[1] - c[1], p[0] - c[0])))
  const dists = pts.map(({ p }) => Math.hypot(p[0] - c[0], p[1] - c[1]))
  const actual = reps * 2
  const section = 360 / actual
  const out: Vertex[] = []
  for (let it = 0; it < actual; it += 1) {
    for (let index = 0; index < pts.length; index += 1) {
      const i = it % 2 === 0 ? index : pts.length - 1 - index
      if (i > 0 || it % 2 === 0) {
        const a0 = angles[0] ?? 0
        const ai = angles[i] ?? 0
        const a = rad(section * it + (it % 2 === 0 ? ai : section - ai + 2 * a0))
        const d = dists[i] ?? 0
        out.push({ p: [Math.cos(a) * d + c[0], Math.sin(a) * d + c[1]], round: (pts[i] as Vertex).round })
      }
    }
  }
  return out
}

/** `RoundedPolygon.star`, radius 1 around (0.5, 0.5) scaled to the unit square, then rotated. */
function star(n: number, inner: number, round: Rounding, rotation = 0): Vertex[] {
  const out: Vertex[] = []
  for (let i = 0; i < n * 2; i += 1) {
    const a = (i * Math.PI) / n
    const r = i % 2 === 0 ? 0.5 : 0.5 * inner
    out.push({ p: [0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)], round })
  }
  return rotation ? rotate(out, rotation) : out
}

/** A regular polygon with per-vertex rounding (`RoundedPolygon(numVertices, perVertexRounding)`). */
function regular(n: number, rounds: Rounding[], rotation = 0): Vertex[] {
  const out: Vertex[] = []
  for (let i = 0; i < n; i += 1) {
    const a = (i * 2 * Math.PI) / n
    out.push({ p: [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)], round: rounds[i] ?? NONE })
  }
  return rotation ? rotate(out, rotation) : out
}

/** A circle as many lightly rounded vertices; reads as a true circle once resampled. */
function circle(): Vertex[] {
  return regular(48, Array.from({ length: 48 }, () => NONE))
}

export type ShapeId =
  | 'cookie9'
  | 'cookie12'
  | 'softBurst'
  | 'ghostish'
  | 'clover4'
  | 'clover8'
  | 'flower'
  | 'sunny'
  | 'puffy'
  | 'gem'
  | 'puffyDiamond'
  | 'pill'
  | 'oval'
  | 'heart'
  | 'bun'
  | 'arch'
  | 'circle'

const SHAPES: Record<ShapeId, () => Vertex[]> = {
  cookie9: () => star(9, 0.8, R(0.5), -90),
  cookie12: () => star(12, 0.8, R(0.5), -90),
  softBurst: () =>
    custom(
      [
        [[0.193, 0.277], R(0.053)],
        [[0.176, 0.055], R(0.053)],
      ],
      10,
    ),
  ghostish: () =>
    custom(
      [
        [[0.5, 0], R(1)],
        [[1, 0], R(1)],
        [[1, 1.14], R(0.254, 0.106)],
        [[0.575, 0.906], R(0.253)],
      ],
      1,
      true,
    ),
  clover4: () =>
    custom(
      [
        [[0.5, 0.074]],
        [[0.725, -0.099], R(0.476)],
      ],
      4,
      true,
    ),
  clover8: () =>
    custom(
      [
        [[0.5, 0.036]],
        [[0.758, -0.101], R(0.209)],
      ],
      8,
    ),
  flower: () =>
    custom(
      [
        [[0.37, 0.187]],
        [[0.416, 0.049], R(0.381)],
        [[0.479, 0.001], R(0.095)],
      ],
      8,
      true,
    ),
  sunny: () => star(8, 0.8, R(0.15)),
  puffy: () =>
    scale(
      custom(
        [
          [[0.5, 0.053]],
          [[0.545, -0.04], R(0.405)],
          [[0.67, -0.035], R(0.426)],
          [[0.717, 0.066], R(0.574)],
          [[0.722, 0.128]],
          [[0.777, 0.002], R(0.36)],
          [[0.914, 0.149], R(0.66)],
          [[0.926, 0.289], R(0.66)],
          [[0.881, 0.346]],
          [[0.94, 0.344], R(0.126)],
          [[1.003, 0.437], R(0.255)],
        ],
        2,
        true,
      ),
      1,
      0.742,
    ),
  gem: () =>
    custom(
      [
        [[0.499, 1.023], R(0.241, 0.778)],
        [[-0.005, 0.792], R(0.208)],
        [[0.073, 0.258], R(0.228)],
        [[0.433, 0], R(0.491)],
      ],
      1,
      true,
    ),
  puffyDiamond: () =>
    custom(
      [
        [[0.87, 0.13], R(0.146)],
        [[0.818, 0.357]],
        [[1, 0.332], R(0.853)],
      ],
      4,
      true,
    ),
  pill: () =>
    custom(
      [
        [[0.961, 0.039], R(0.426)],
        [[1.001, 0.428]],
        [[1, 0.609], R(1)],
      ],
      2,
      true,
    ),
  oval: () => rotate(scale(circle(), 1, 0.64), -45),
  heart: () =>
    custom(
      [
        [[0.5, 0.268], R(0.016)],
        [[0.792, -0.066], R(0.958)],
        [[1.064, 0.276], R(1)],
        [[0.501, 0.946], R(0.129)],
      ],
      1,
      true,
    ),
  bun: () =>
    custom(
      [
        [[0.796, 0.5]],
        [[0.853, 0.518], R(1)],
        [[0.992, 0.631], R(1)],
        [[0.968, 1], R(1)],
      ],
      2,
      true,
    ),
  arch: () => regular(4, [R(1), R(1), R(0.2), R(0.2)], -135),
  circle,
}

function cubic(a: Pt, b: Pt, c: Pt, d: Pt, t: number): Pt {
  const u = 1 - t
  return [
    u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
    u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1],
  ]
}

/**
 * Rounds every corner the way androidx does in spirit: the corner cut along each edge is r / tan(theta/2),
 * stretched by the smoothing, and scaled down when two neighbouring cuts would not fit on one edge.
 * The corner itself is a cubic whose handles follow the circular-arc rule.
 */
function roundedPolyline(vs: Vertex[]): Pt[] {
  const n = vs.length
  const at = (i: number): Vertex => vs[((i % n) + n) % n] as Vertex
  const want: number[] = []
  const halfAngle: number[] = []
  for (let i = 0; i < n; i += 1) {
    const p = at(i).p
    const a = at(i - 1).p
    const b = at(i + 1).p
    const u: Pt = [a[0] - p[0], a[1] - p[1]]
    const v: Pt = [b[0] - p[0], b[1] - p[1]]
    const lu = Math.hypot(u[0], u[1]) || 1e-9
    const lv = Math.hypot(v[0], v[1]) || 1e-9
    const cos = Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (lu * lv)))
    const theta = Math.acos(cos)
    halfAngle.push(theta / 2)
    const r = at(i).round.r
    want.push(r > 0 && theta > 1e-3 && theta < Math.PI - 1e-3 ? (r / Math.tan(theta / 2)) * (1 + at(i).round.s) : 0)
  }
  const factor = new Array<number>(n).fill(1)
  for (let i = 0; i < n; i += 1) {
    const p = at(i).p
    const q = at(i + 1).p
    const len = Math.hypot(q[0] - p[0], q[1] - p[1])
    const total = (want[i] ?? 0) + (want[(i + 1) % n] ?? 0)
    if (total > len && total > 0) {
      const f = len / total
      factor[i] = Math.min(factor[i] ?? 1, f)
      factor[(i + 1) % n] = Math.min(factor[(i + 1) % n] ?? 1, f)
    }
  }
  const out: Pt[] = []
  for (let i = 0; i < n; i += 1) {
    const p = at(i).p
    const cut = (want[i] ?? 0) * (factor[i] ?? 1)
    if (cut <= 1e-6) {
      out.push(p)
      continue
    }
    const a = at(i - 1).p
    const b = at(i + 1).p
    const la = Math.hypot(a[0] - p[0], a[1] - p[1])
    const lb = Math.hypot(b[0] - p[0], b[1] - p[1])
    const A: Pt = [p[0] + ((a[0] - p[0]) / la) * cut, p[1] + ((a[1] - p[1]) / la) * cut]
    const B: Pt = [p[0] + ((b[0] - p[0]) / lb) * cut, p[1] + ((b[1] - p[1]) / lb) * cut]
    // Handle length for a circular arc of turn angle (pi - theta), expressed as a fraction of the cut.
    const turn = Math.PI - 2 * (halfAngle[i] ?? 0)
    const radius = cut * Math.tan(halfAngle[i] ?? 0)
    const k = Math.min(1, ((4 / 3) * Math.tan(turn / 4) * radius) / cut) * (1 - 0.25 * at(i).round.s)
    const C1: Pt = [A[0] + (p[0] - A[0]) * k, A[1] + (p[1] - A[1]) * k]
    const C2: Pt = [B[0] + (p[0] - B[0]) * k, B[1] + (p[1] - B[1]) * k]
    for (let s = 0; s <= 16; s += 1) out.push(cubic(A, C1, C2, B, s / 16))
  }
  return out
}

/** Equal-arclength resampling, starting at the point nearest straight up from the centre, clockwise on screen. */
function resample(poly: Pt[], count: number): Pt[] {
  let area = 0
  for (let i = 0; i < poly.length; i += 1) {
    const p = poly[i] as Pt
    const q = poly[(i + 1) % poly.length] as Pt
    area += p[0] * q[1] - q[0] * p[1]
  }
  const pts = area < 0 ? [...poly].reverse() : poly
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length
  let start = 0
  let best = Infinity
  pts.forEach((p, i) => {
    const a = Math.atan2(p[1] - cy, p[0] - cx)
    const diff = Math.abs(Math.atan2(Math.sin(a + Math.PI / 2), Math.cos(a + Math.PI / 2)))
    if (diff < best) {
      best = diff
      start = i
    }
  })
  const ring = [...pts.slice(start), ...pts.slice(0, start)]
  const lens = [0]
  for (let i = 1; i <= ring.length; i += 1) {
    const p = ring[i - 1] as Pt
    const q = ring[i % ring.length] as Pt
    lens.push((lens[i - 1] ?? 0) + Math.hypot(q[0] - p[0], q[1] - p[1]))
  }
  const total = lens[lens.length - 1] ?? 1
  const out: Pt[] = []
  let j = 0
  for (let k = 0; k < count; k += 1) {
    const target = (k / count) * total
    while ((lens[j + 1] ?? total) < target) j += 1
    const p = ring[j] as Pt
    const q = ring[(j + 1) % ring.length] as Pt
    const seg = (lens[j + 1] ?? total) - (lens[j] ?? 0) || 1
    const t = (target - (lens[j] ?? 0)) / seg
    out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t])
  }
  return out
}

/** The outline of a shape fitted into a 100 x 100 box with `margin` on every side, as `count` points. */
export function outline(id: ShapeId, count = 120, margin = 4): Pt[] {
  const pts = resample(roundedPolyline(SHAPES[id]()), count)
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const y0 = Math.min(...ys)
  const y1 = Math.max(...ys)
  const s = (100 - 2 * margin) / Math.max(x1 - x0, y1 - y0)
  const ox = 50 - ((x0 + x1) / 2) * s
  const oy = 50 - ((y0 + y1) / 2) * s
  return pts.map((p) => [p[0] * s + ox, p[1] * s + oy])
}

export function outlinePath(id: ShapeId, count = 120, margin = 4): string {
  return `M${outline(id, count, margin)
    .map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    .join('L')}Z`
}
