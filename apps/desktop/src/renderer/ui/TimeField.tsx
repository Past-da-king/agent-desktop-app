import { useEffect, useState } from 'react'

import { finishTime, typeTime } from '../lib/time-input'

/** A time of day on the 24-hour clock, the way the rest of the app writes it. `value` and `onChange` are "HH:MM". */
export function TimeField({
  id,
  value,
  onChange,
  ariaLabel,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  ariaLabel?: string
}): JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    setDraft((current) => (finishTime(current) === value ? current : value))
  }, [value])
  return (
    <input
      id={id}
      className="input time-field"
      type="text"
      inputMode="numeric"
      autoComplete="off"
      placeholder="07:00"
      maxLength={5}
      aria-label={ariaLabel}
      value={draft}
      onChange={(event) => {
        const next = typeTime(event.target.value)
        setDraft(next)
        const done = finishTime(next)
        if (done !== '' && next.length >= 4) onChange(done)
      }}
      onBlur={() => {
        const done = finishTime(draft)
        if (done === '') setDraft(value)
        else {
          setDraft(done)
          if (done !== value) onChange(done)
        }
      }}
    />
  )
}
