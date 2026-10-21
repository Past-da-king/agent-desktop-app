import { useEffect, useState } from 'react'

import { copyText } from '../lib/copy'
import { Icon } from './Icon'

/** A small copy button: says Copied for a moment after it worked. */
export function CopyButton({ text, label = 'Copy', className = '' }: { text: string; label?: string; className?: string }): JSX.Element {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const timer = window.setTimeout(() => setState('idle'), 1600)
    return () => window.clearTimeout(timer)
  }, [state])
  return (
    <button
      type="button"
      className={`copy-btn ${className}`.trim()}
      aria-label={state === 'done' ? 'Copied' : label}
      title={state === 'done' ? 'Copied' : label}
      onClick={() => {
        void copyText(text).then((ok) => setState(ok ? 'done' : 'failed'))
      }}
    >
      <Icon name={state === 'done' ? 'check' : 'copy'} size={16} />
      <span>{state === 'done' ? 'Copied' : state === 'failed' ? 'Could not copy' : label}</span>
    </button>
  )
}
