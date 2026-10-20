import { useMemo, useState } from 'react'

import type { ModelOption } from '@agent/core'

import { Icon } from './Icon'

/**
 * Pick a model from the list the provider itself returned for this key. A search box narrows it, and a name
 * that is not in the list can still be used, for a model the provider does not list.
 */
export function ModelList({
  models,
  value,
  onPick,
  autoFocus = false,
}: {
  models: ModelOption[]
  value: string
  onPick: (id: string) => void
  autoFocus?: boolean
}): JSX.Element {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = useMemo(
    () => (q === '' ? models : models.filter((m) => `${m.id} ${m.label}`.toLowerCase().includes(q))),
    [models, q],
  )
  const typed = query.trim()
  return (
    <div className="mlist">
      <label className="mlist-search">
        <Icon name="search" size={18} />
        <input
          value={query}
          autoFocus={autoFocus}
          placeholder={`Search ${models.length} models`}
          aria-label="Search models"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && typed !== '') onPick(shown[0]?.id ?? typed)
          }}
        />
      </label>
      <div className="mlist-rows" role="listbox" aria-label="Models">
        {shown.map((m) => (
          <button
            key={m.id || 'default'}
            type="button"
            role="option"
            aria-selected={m.id === value}
            className={`mlist-row${m.id === value ? ' on' : ''}`}
            title={m.id}
            onClick={() => onPick(m.id)}
          >
            <span className="mlist-t">
              <b>{m.label}</b>
              {m.line !== '' ? <span>{m.line}</span> : null}
            </span>
            {m.id === value ? <Icon name="check" size={18} /> : null}
          </button>
        ))}
        {shown.length === 0 && typed !== '' ? (
          <button type="button" className="mlist-row" onClick={() => onPick(typed)}>
            <span>Use {typed}</span>
          </button>
        ) : null}
      </div>
    </div>
  )
}
