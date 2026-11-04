/**
 * The controls Settings uses, one per kind of value (4 Nov 2026): a select for a list of choices, a field for text, a
 * number that saves when it is finished (never on every keystroke, so typing 1.5 never saves 1), a slider for a real
 * range, a shortcut recorder, and the time and date fields. They take a value and say the new one; the page saves it
 * through the same settings call the rest of the app uses.
 */
import { useEffect, useRef, useState } from 'react'

import { agent } from '../../bridge'
import { acceleratorFromEvent, formatAccelerator } from '../../lib/hotkey'
import { toast } from '../../state/useToast'
import { Button } from '../../ui/Button'
import { Icon } from '../../ui/Icon'

export interface Option {
  value: string
  label: string
}

/** A list of choices. Use it when there are more than four, or the words are long. */
export function SelectControl({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: Option[]
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <select className="sel" aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

/** Text that saves when the field is left or Enter is pressed. */
export function TextControl({
  label,
  value,
  placeholder,
  onCommit,
  width,
}: {
  label: string
  value: string
  placeholder?: string
  onCommit: (value: string) => void
  width?: number
}): JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = (): void => {
    const next = draft.trim()
    if (next === value.trim()) return
    onCommit(next)
  }
  return (
    <input
      className="inp"
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      style={width === undefined ? undefined : { width }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          setDraft(value)
          event.currentTarget.blur()
        }
      }}
    />
  )
}

/**
 * A number that counts something, or is off. Blank and 0 mean off (no limit, no check), which is what the rows that
 * use it say in their placeholder.
 */
export function NumberControl({
  label,
  value,
  unit,
  off = 'Off',
  decimal = false,
  max,
  onCommit,
}: {
  label: string
  value: number
  unit?: string
  off?: string
  decimal?: boolean
  max?: number
  onCommit: (value: number) => void
}): JSX.Element {
  const shown = typeof value === 'number' && value > 0 ? String(value) : ''
  const [draft, setDraft] = useState(shown)
  const [bad, setBad] = useState(false)
  useEffect(() => setDraft(shown), [shown])

  const commit = (): void => {
    const text = draft.trim()
    if (text === '') {
      setBad(false)
      if (value !== 0) onCommit(0)
      return
    }
    if (!(decimal ? /^\d+(\.\d+)?$/ : /^\d+$/).test(text)) {
      setBad(true)
      toast(`Type a ${decimal ? '' : 'whole '}number, or leave it empty for ${off.toLowerCase()}.`)
      return
    }
    setBad(false)
    const next = Number(text)
    if (max !== undefined && next > max) {
      toast(`${label} can be at most ${max}${unit ?? ''}.`)
      return
    }
    if (next !== value) onCommit(next)
  }

  return (
    <>
      <input
        className={`inp num${bad ? ' bad' : ''}`}
        aria-label={unit === undefined ? label : `${label}, ${unit}`}
        inputMode={decimal ? 'decimal' : 'numeric'}
        placeholder={off}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
      />
      {unit === undefined ? null : <span className="pill mute">{unit}</span>}
    </>
  )
}

/** A real range, 0.1 to 1, shown as a percentage. */
export function SliderControl({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (value: number) => void
}): JSX.Element {
  const percent = Math.round(Math.min(1, Math.max(0.1, value)) * 100)
  return (
    <>
      <input
        className="range"
        type="range"
        min={10}
        max={100}
        step={5}
        value={percent}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value) / 100)}
      />
      <span className="small muted" style={{ width: 38, textAlign: 'right' }}>
        {percent}%
      </span>
    </>
  )
}

/** A time of day, HH:MM. Empty turns the thing off. */
export function TimeControl({
  label,
  value,
  onCommit,
}: {
  label: string
  value: string
  onCommit: (value: string) => void
}): JSX.Element {
  return (
    <input
      className="inp"
      type="time"
      aria-label={label}
      value={value}
      style={{ width: 130 }}
      onChange={(event) => onCommit(event.target.value)}
    />
  )
}

/** A date and a time, kept as the local ISO time the store writes. */
export function DateTimeControl({
  label,
  value,
  onCommit,
}: {
  label: string
  value: string
  onCommit: (value: string) => void
}): JSX.Element {
  const local = value === '' ? '' : value.slice(0, 16)
  return (
    <input
      className="inp"
      type="datetime-local"
      aria-label={label}
      value={local}
      style={{ width: 210 }}
      onChange={(event) => onCommit(event.target.value === '' ? '' : `${event.target.value}:00`)}
    />
  )
}

/**
 * A global shortcut: the keys as a button, and pressing it listens for the next key press. Our own shortcuts step
 * aside while it listens, or pressing one would start it instead of being heard here.
 */
export function HotkeyControl({
  label,
  value,
  onSave,
}: {
  label: string
  value: string
  onSave: (accelerator: string) => void
}): JSX.Element {
  const [recording, setRecording] = useState(false)
  const saveRef = useRef(onSave)
  saveRef.current = onSave
  const platform = agent.platform
  const keys = formatAccelerator(value, platform)

  useEffect(() => {
    if (!recording) return
    void agent.hotkeys.pause(true).catch(() => undefined)
    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(false)
        return
      }
      const accelerator = acceleratorFromEvent(event, platform)
      if (accelerator === null) return
      setRecording(false)
      saveRef.current(accelerator)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      void agent.hotkeys.pause(false).catch(() => undefined)
    }
  }, [recording, platform])

  return (
    <>
      <button
        type="button"
        className={`rec${recording ? ' on' : ''}`}
        aria-label={recording ? `Listening for the ${label}` : `Change the ${label}, now ${keys.join(' + ') || 'none'}`}
        onClick={() => setRecording(!recording)}
      >
        <Icon name="key" size={16} />
        {recording ? 'Press the keys now' : keys.length === 0 ? 'No shortcut' : keys.join(' + ')}
      </button>
      {keys.length > 0 && !recording ? (
        <Button variant="text" size="sm" onClick={() => saveRef.current('')} aria-label={`Turn off the ${label}`}>
          Turn off
        </Button>
      ) : null}
    </>
  )
}
