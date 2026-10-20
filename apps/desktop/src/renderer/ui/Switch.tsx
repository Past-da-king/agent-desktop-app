export function Switch({
  on,
  onToggle,
  label,
  disabled = false,
  comingSoon = false,
}: {
  on: boolean
  onToggle: (next: boolean) => void
  label: string
  disabled?: boolean
  comingSoon?: boolean
}): JSX.Element {
  const blocked = disabled || comingSoon
  const control = (
    <button
      type="button"
      className={`sw2${on ? ' on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={blocked}
      style={blocked ? { opacity: 0.6, cursor: 'not-allowed' } : undefined}
      onClick={() => {
        if (!blocked) onToggle(!on)
      }}
    />
  )
  if (!comingSoon) return control
  return (
    <span className="cs" title="Coming soon">
      {control}
    </span>
  )
}
