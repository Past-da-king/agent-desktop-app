export function Skeleton({ rows = 4 }: { rows?: number }): JSX.Element {
  return (
    <div className="sk" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={`sk-row${i === 0 ? ' big' : ''}${i % 3 === 2 ? ' short' : ''}`} />
      ))}
    </div>
  )
}
