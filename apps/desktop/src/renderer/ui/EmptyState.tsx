import type { MascotId } from '@agent/core'
import type { ReactNode } from 'react'

import { Mascot } from './Mascot'

export function EmptyState({
  mascot,
  title,
  line,
  action,
}: {
  mascot: MascotId
  title: string
  line: string
  action?: ReactNode
}): JSX.Element {
  return (
    <div className="empty">
      <Mascot id={mascot} size={64} />
      <div className="h3">{title}</div>
      <p>{line}</p>
      {action}
    </div>
  )
}
