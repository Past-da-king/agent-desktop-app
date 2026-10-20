import type { ButtonHTMLAttributes, ReactNode } from 'react'

import type { IconName } from './Icon'
import { Icon } from './Icon'

export function Pill({
  tone = 'mute',
  children,
}: {
  tone?: 'ok' | 'warn' | 'pri' | 'mute'
  children: ReactNode
}): JSX.Element {
  return <span className={`pill ${tone}`}>{children}</span>
}

export function Kbd({ children }: { children: ReactNode }): JSX.Element {
  return <kbd>{children}</kbd>
}

export function Avatar({ name, size = 36 }: { name: string; size?: number }): JSX.Element {
  const letter = (name.trim()[0] ?? 'A').toUpperCase()
  return (
    <div className="avatar" style={{ width: size, height: size, fontSize: Math.round(size / 2.6) }} aria-hidden="true">
      {letter}
    </div>
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName
  label: string
  size?: number
  tonal?: boolean
  comingSoon?: boolean
}

export function IconButton({
  icon,
  label,
  size = 22,
  tonal = false,
  comingSoon = false,
  className,
  disabled,
  type = 'button',
  ...rest
}: IconButtonProps): JSX.Element {
  const button = (
    <button
      type={type}
      className={`ib${tonal ? ' tonal' : ''}${className ? ` ${className}` : ''}`}
      aria-label={label}
      title={comingSoon ? 'Coming soon' : label}
      disabled={disabled === true || comingSoon}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  )
  if (!comingSoon) return button
  return (
    <span className="cs" title="Coming soon">
      {button}
    </span>
  )
}
