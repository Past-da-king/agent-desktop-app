import type { ReactNode } from 'react'

export function Chip({
  children,
  active = false,
  onClick,
  icon,
  disabled = false,
  comingSoon = false,
  role,
  ariaChecked,
}: {
  children: ReactNode
  active?: boolean
  onClick?: () => void
  icon?: ReactNode
  disabled?: boolean
  comingSoon?: boolean
  role?: 'radio'
  ariaChecked?: boolean
}): JSX.Element {
  const blocked = disabled || comingSoon
  const chip = (
    <button
      type="button"
      className={`chip${active ? ' on' : ''}`}
      onClick={onClick}
      disabled={blocked}
      role={role}
      aria-checked={role === 'radio' ? ariaChecked ?? active : undefined}
    >
      {icon}
      {children}
    </button>
  )
  if (!comingSoon) return chip
  return (
    <span className="cs" title="Coming soon">
      {chip}
    </span>
  )
}
