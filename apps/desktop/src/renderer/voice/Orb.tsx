import type { CallState } from '@agent/core'
import { useEffect, useRef } from 'react'

import { springStep } from './pcm'

/**
 * The call's orb. Its size follows the loudness of whoever is talking on a spring (it overshoots a
 * little and settles), its glow breathes, and it is the person's accent colour except while the agent
 * waits for them, when it turns amber. With reduced motion it holds still and only the colour speaks.
 */
export function Orb({
  state,
  level,
  size = 220,
}: {
  state: CallState
  level: () => number
  size?: number
}): JSX.Element {
  const core = useRef<HTMLDivElement>(null)
  const halo = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    if (reduced) return
    let frame = 0
    let last = performance.now()
    let scale = 1
    let velocity = 0
    let glow = 0
    const tick = (now: number): void => {
      const dt = (now - last) / 1000
      last = now
      const loud = Math.max(0, Math.min(1, level()))
      ;[scale, velocity] = springStep(scale, velocity, 1 + 0.26 * loud, dt)
      glow += (loud - glow) * 0.18
      const breathe = 0.5 + 0.5 * Math.sin(now / 900)
      if (core.current) core.current.style.transform = `scale(${scale.toFixed(4)})`
      if (halo.current) {
        halo.current.style.transform = `scale(${(1.04 + glow * 0.5 + breathe * 0.04).toFixed(4)})`
        halo.current.style.opacity = (0.35 + glow * 0.55).toFixed(3)
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [level])

  return (
    <div className={`orb is-${state}`} style={{ width: size, height: size }} aria-hidden="true">
      <div className="orb-halo" ref={halo} />
      <div className="orb-core" ref={core}>
        <i className="orb-blob b1" />
        <i className="orb-blob b2" />
        <i className="orb-blob b3" />
        <i className="orb-shine" />
      </div>
    </div>
  )
}
