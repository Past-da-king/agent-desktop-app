import { useEffect, useRef, useState } from 'react'

import { PROVIDERS } from '@agent/core'

import { useSettings } from '../state/useSettings'
import { Icon } from './Icon'

interface Choice {
  id: string
  label: string
  line: string
}

/** Claude Code takes these aliases and always maps them to the newest model of each family. */
const CLAUDE: Choice[] = [
  { id: '', label: 'Default', line: 'What your Claude plan picks' },
  { id: 'opus', label: 'Opus', line: 'The most capable, for hard work' },
  { id: 'sonnet', label: 'Sonnet', line: 'Fast and very capable' },
  { id: 'haiku', label: 'Haiku', line: 'The quickest, for small jobs' },
  { id: 'fable', label: 'Fable', line: 'For writing and stories' },
]

function labelFor(id: string, choices: Choice[]): string {
  return choices.find((choice) => choice.id === id)?.label ?? id
}

/**
 * The model pill in the chat header. On a plan it chooses the plan's model (Claude: Opus, Sonnet, Haiku,
 * Fable; Codex: its default or a typed model id); with an API key it chooses the provider's model.
 * The choice applies from the next message.
 */
export function ModelPicker(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState('')
  const root = useRef<HTMLDivElement>(null)

  const plan = settings?.mode === 'subscription'
  const cli = settings?.cli === 'codex' ? 'codex' : 'claude'
  const current = plan ? (settings?.cliModel ?? '') : (settings?.model ?? '')
  const provider = PROVIDERS.find((item) => item.id === settings?.provider)

  const choices: Choice[] = plan
    ? cli === 'claude'
      ? CLAUDE
      : [{ id: '', label: 'Default', line: 'What your Codex setup picks' }]
    : provider === undefined
      ? []
      : [{ id: provider.defaultModel, label: provider.defaultModel, line: `${provider.label}'s recommended model` }]

  const shown = plan
    ? cli === 'claude'
      ? `Claude ${labelFor(current, CLAUDE) === 'Default' ? '' : labelFor(current, CLAUDE)}`.trim()
      : current === ''
        ? 'Codex'
        : `Codex ${current}`
    : current.trim() || 'No model chosen'

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const choose = (id: string): void => {
    void save(plan ? { cliModel: id } : { model: id })
    setOpen(false)
    setCustom('')
  }

  return (
    <div className="model-pick" ref={root}>
      <button
        type="button"
        className="model"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Choose the model"
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="bolt" size={16} />
        <span>{shown}</span>
        <Icon name="chevd" size={16} />
      </button>
      {open ? (
        <div className="model-menu" role="menu" aria-label="Models">
          <div className="eyebrow mute">{plan ? (cli === 'claude' ? 'ON YOUR CLAUDE PLAN' : 'ON YOUR CHATGPT PLAN') : (provider?.label ?? 'MODEL').toUpperCase()}</div>
          {choices.map((choice) => (
            <button
              key={choice.id || 'default'}
              type="button"
              role="menuitemradio"
              aria-checked={current === choice.id}
              className={`model-item${current === choice.id ? ' on' : ''}`}
              onClick={() => choose(choice.id)}
            >
              <span className="mi-t">
                <b>{choice.label}</b>
                <span>{choice.line}</span>
              </span>
              {current === choice.id ? <Icon name="check" size={18} /> : null}
            </button>
          ))}
          {plan && cli === 'claude' ? null : (
            <form
              className="model-custom"
              onSubmit={(event) => {
                event.preventDefault()
                if (custom.trim() !== '') choose(custom.trim())
              }}
            >
              <label htmlFor="model-custom">Another model</label>
              <div className="row">
                <input
                  id="model-custom"
                  className="input"
                  value={custom}
                  placeholder={current || 'Model id'}
                  onChange={(event) => setCustom(event.target.value)}
                />
                <button type="submit" className="btn tonal sm" disabled={custom.trim() === ''}>
                  Use
                </button>
              </div>
            </form>
          )}
        </div>
      ) : null}
    </div>
  )
}
