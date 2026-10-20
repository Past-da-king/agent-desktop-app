import type { ReactNode } from 'react'

export function Eyebrow({ children, muted = false }: { children: ReactNode; muted?: boolean }): JSX.Element {
  return <span className={`eyebrow${muted ? ' mute' : ''}`}>{children}</span>
}
