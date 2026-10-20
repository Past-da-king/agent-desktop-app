/** The small progress ring used on goals. */
export function Ring({ pct, size = 44 }: { pct: number; size?: number }): JSX.Element {
  const r = (size - 8) / 2
  const c = 2 * Math.PI * r
  const safe = Math.max(0, Math.min(100, pct))
  return (
    <div className="ring" style={{ width: `${size}px`, height: `${size}px` }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ transform: 'rotate(-90deg)' }}
        aria-hidden="true"
      >
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--outline-v)" strokeWidth="4" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${(c * safe) / 100} ${c}`}
        />
      </svg>
      <span>{Math.round(safe)}</span>
    </div>
  )
}
