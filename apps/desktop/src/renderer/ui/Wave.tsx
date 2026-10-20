import { useId } from 'react'

import { prefersReducedMotion } from './Mascot'

/** The progress wave from the mockup. */
export function Wave({
  pct,
  track = 'var(--on-pc)',
  line = 'var(--on-pc)',
}: {
  pct: number
  track?: string
  line?: string
}): JSX.Element {
  const raw = useId()
  const id = `w${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const safe = Math.max(0, Math.min(100, pct))

  return (
    <svg className="wave" width="100%" height="14" aria-hidden="true">
      <defs>
        <pattern id={id} width="28" height="14" patternUnits="userSpaceOnUse">
          <path d="M0 7Q7 0 14 7T28 7" fill="none" stroke={line} strokeWidth="3" strokeLinecap="round" />
          {prefersReducedMotion() ? null : (
            <animateTransform
              attributeName="patternTransform"
              type="translate"
              from="0 0"
              to="-28 0"
              dur="1.4s"
              repeatCount="indefinite"
            />
          )}
        </pattern>
      </defs>
      <line
        x1={`${safe}%`}
        y1="7"
        x2="calc(100% - 2px)"
        y2="7"
        stroke={track}
        strokeOpacity=".35"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <rect x="0" y="0" width={`${safe}%`} height="14" fill={`url(#${id})`} />
    </svg>
  )
}
