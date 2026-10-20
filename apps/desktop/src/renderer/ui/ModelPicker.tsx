import { useEffect, useRef, useState } from 'react'

import { PROVIDERS, type ModelOption } from '@agent/core'

import { agent } from '../bridge'
import { useSettings } from '../state/useSettings'
import { Icon } from './Icon'
import { ModelList } from './ModelList'

/** On a plan, an empty model means "what the plan picks". */
const PLAN_DEFAULT: ModelOption = { id: '', label: 'Default', line: 'What your plan picks' }

/**
 * The model pill in the chat header. Every choice is asked live each time it opens: the provider's own list
 * for an API key, the engine's own list on a Claude or ChatGPT plan. Nothing is a built-in list. A model the
 * list does not show can still be typed into the search. The choice applies from the next message.
 */
export function ModelPicker(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const [open, setOpen] = useState(false)
  const [listed, setListed] = useState<{ models: ModelOption[]; message: string } | null>(null)
  const root = useRef<HTMLDivElement>(null)

  const plan = settings?.mode === 'subscription'
  const cli = settings?.cli === 'codex' ? 'codex' : 'claude'
  const current = plan ? (settings?.cliModel ?? '') : (settings?.model ?? '')
  const provider = PROVIDERS.find((item) => item.id === settings?.provider)
  const source = plan ? (cli === 'claude' ? 'your Claude plan' : 'your ChatGPT plan') : (provider?.label ?? 'the provider')
  const known = listed?.models.find((m) => m.id === current)

  const shown = plan
    ? `${cli === 'claude' ? 'Claude' : 'ChatGPT'}${current === '' ? '' : ` ${known?.label ?? current}`}`
    : known?.label || current.trim() || 'Choose a model'

  useEffect(() => {
    if (!open) return
    let live = true
    setListed(null)
    agent.settings
      .listModels()
      .then((result) => {
        if (live) setListed({ models: result.models, message: result.message })
      })
      .catch(() => {
        if (live) setListed({ models: [], message: `Could not ask ${source} for its models.` })
      })
    return () => {
      live = false
    }
  }, [open, source])

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
  }

  const options = listed === null ? [] : plan && !listed.models.some((m) => m.id === '') ? [PLAN_DEFAULT, ...listed.models] : listed.models

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
          <div className="eyebrow mute">{`ON ${source.toUpperCase()}`}</div>
          {listed === null ? (
            <p className="small muted model-wait">Asking {source} for its models</p>
          ) : (
            <>
              {options.length > (plan ? 1 : 0) ? null : <p className="small muted model-wait">{listed.message}</p>}
              <ModelList models={options} value={current} onPick={choose} autoFocus />
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
