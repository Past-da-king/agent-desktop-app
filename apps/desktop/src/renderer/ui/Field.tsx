import { useId, useState, type RefObject } from 'react'

import { Icon } from './Icon'

export interface FieldProps {
  label: string
  /** Optional handle so a step can focus the field when its value is missing. */
  inputRef?: RefObject<HTMLInputElement>
  value: string
  onChange: (value: string) => void
  type?: 'text' | 'email' | 'password' | 'url'
  placeholder?: string
  autoComplete?: string
  error?: string
  ok?: string
  disabled?: boolean
  inputMode?: 'text' | 'email' | 'url'
  /** Password fields get the show/hide eye from the mockup. */
  revealable?: boolean
  revealLabel?: string
  onEnter?: () => void
}

export function Field({
  label,
  inputRef,
  value,
  onChange,
  type = 'text',
  placeholder,
  autoComplete,
  error,
  ok,
  disabled,
  inputMode,
  revealable,
  revealLabel,
  onEnter,
}: FieldProps): JSX.Element {
  const id = useId()
  const [shown, setShown] = useState(false)
  const actualType = revealable && shown ? 'text' : type

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="wrap">
        <input
          id={id}
          ref={inputRef}
          className={`input${error ? ' bad' : ''}`}
          type={actualType}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          disabled={disabled}
          inputMode={inputMode}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          style={revealable ? undefined : { paddingRight: 18 }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onEnter) {
              e.preventDefault()
              onEnter()
            }
          }}
        />
        {revealable ? (
          <button
            type="button"
            className="eye"
            aria-label={`${shown ? 'Hide' : 'Show'} ${revealLabel ?? 'password'}`}
            onClick={() => setShown((s) => !s)}
          >
            <Icon name={shown ? 'eyeoff' : 'eye'} />
          </button>
        ) : null}
      </div>
      <div className={`err${ok && !error ? ' ok' : ''}`} id={`${id}-err`} role={error ? 'alert' : 'status'}>
        {error || ok || ''}
      </div>
    </div>
  )
}
