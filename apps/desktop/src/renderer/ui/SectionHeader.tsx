import type { ReactNode } from 'react'

import { Eyebrow } from './Eyebrow'

export function SectionHeader({
  eyebrow,
  line,
  right,
}: {
  eyebrow: string
  line: string
  right?: ReactNode
}): JSX.Element {
  return (
    <div className="sec-row">
      <div className="sec">
        <Eyebrow>{eyebrow}</Eyebrow>
        <span className="sec-line">{line}</span>
      </div>
      {right}
    </div>
  )
}
