import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type ButtonVariant = 'fill' | 'tonal' | 'line' | 'text' | 'on-tc'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'md' | 'lg' | 'sm'
  block?: boolean
  /** A disabled button with a real "Coming soon" tooltip, per AGENTS.md. */
  comingSoon?: boolean
  children?: ReactNode
}

export function Button({
  variant = 'fill',
  size = 'md',
  block = false,
  comingSoon = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps): JSX.Element {
  const classes = ['btn', variant, size === 'lg' ? 'lg' : size === 'sm' ? 'sm' : '', block ? 'block' : '', className ?? '']
    .filter(Boolean)
    .join(' ')

  const button = (
    <button
      type={type}
      className={classes}
      disabled={disabled === true || comingSoon}
      aria-disabled={comingSoon ? true : undefined}
      {...rest}
    >
      {children}
    </button>
  )

  if (!comingSoon) return button
  return (
    <span className={block ? 'cs block' : 'cs'} title="Coming soon">
      {button}
    </span>
  )
}
