import type { EntityName, SyncProgress } from '@agent/core'
import { useEffect, useRef, useState } from 'react'

import { agent } from '../bridge'
import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { OnboardingLayout } from './OnboardingLayout'

const ITEMS: Array<{ key: string; icon: 'memory' | 'tasks' | 'clock' | 'chat'; label: string; entities: EntityName[] }> = [
  { key: 'memory', icon: 'memory', label: 'Memory', entities: ['memory'] },
  { key: 'tasks', icon: 'tasks', label: 'To-dos and goals', entities: ['task', 'goal'] },
  { key: 'routines', icon: 'clock', label: 'Routines', entities: ['trigger'] },
  { key: 'chats', icon: 'chat', label: 'Chats', entities: ['chat_item'] },
]

export function Sync(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const navigate = useUi((state) => state.navigate)
  const fresh = !(settings?.signedIn ?? false)
  const [progress, setProgress] = useState<SyncProgress>({ phase: fresh ? 'done' : 'connecting', counts: {} })
  const [error, setError] = useState('')
  const started = useRef(false)

  useEffect(() => {
    if (fresh) {
      setProgress({ phase: 'done', counts: {} })
      return
    }
    const off = agent.account.onProgress((next) => {
      setProgress(next)
      if (next.phase === 'error') setError(next.message ?? 'Sync could not finish.')
    })
    if (!started.current) {
      started.current = true
      void agent.account
        .firstSync()
        .then((status) => {
          if (status.error) setError(status.error)
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : 'Sync could not finish.')
        })
    }
    return off
  }, [fresh])

  const done = progress.phase === 'done'
  const busy = progress.phase === 'connecting' || progress.phase === 'pulling'
  const counts = progress.counts

  const countFor = (entities: EntityName[]): number =>
    entities.reduce((sum, entity) => sum + (counts[entity] ?? 0), 0)

  return (
    <OnboardingLayout step="sync">
      <div className="ob-col">
        <div>
          <div className="eyebrow">{fresh ? 'A CLEAN START' : 'ONE AGENT, TWO DEVICES'}</div>
          <h1 className="h1" style={{ marginTop: 8 }}>
            {fresh ? 'Starting fresh here' : 'Bringing your agent over'}
          </h1>
          <p className="muted" style={{ marginTop: 8, fontSize: 15 }}>
            {fresh
              ? 'Nothing to bring yet. Anything you teach it on this computer will show up on your phone once you add it.'
              : 'Your phone and this computer now work as the same agent. This takes a few seconds.'}
          </p>
        </div>

        <div className="card">
          {ITEMS.map((item) => {
            const count = countFor(item.entities)
            const itemDone = fresh || (done && count >= 0)
            const itemBusy = !fresh && busy
            return (
              <div key={item.key} className={`syncrow${itemDone && !fresh ? ' done' : ''}`}>
                <div className="st">
                  {itemDone && !fresh ? (
                    <Icon name="check" size={18} />
                  ) : itemBusy ? (
                    <span className="spin" style={{ display: 'inline-flex' }}>
                      <Icon name="sync" size={18} />
                    </span>
                  ) : (
                    <Icon name={item.icon} size={18} />
                  )}
                </div>
                <div className="t">
                  <div className="h3">{item.label}</div>
                  <div className="small muted">
                    {fresh ? 'Empty' : count > 0 ? `${count} brought over` : 'Looking...'}
                  </div>
                </div>
                <div className="small muted">{fresh ? '' : itemDone ? 'Done' : 'Waiting'}</div>
              </div>
            )
          })}
        </div>

        <p className="small muted" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Icon name="lock" size={16} />
          API keys stay on the device they were typed on.
        </p>

        {error ? (
          <p className="ob-note warn" role="status">
            {error} You can carry on and sync again from Settings.
          </p>
        ) : null}

        <Button
          size="lg"
          block
          disabled={!fresh && busy}
          onClick={() => navigate({ page: 'onboarding', step: 'ai' })}
        >
          {fresh ? 'Continue' : done ? 'Continue' : 'Syncing...'}
          <Icon name="arrow" size={20} />
        </Button>
      </div>
    </OnboardingLayout>
  )
}
