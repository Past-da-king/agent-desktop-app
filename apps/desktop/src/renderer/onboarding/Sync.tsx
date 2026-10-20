import type { EntityName, SyncProgress } from '@agent/core'
import { useEffect, useRef, useState } from 'react'

import { agent } from '../bridge'
import { isLocalOnly } from '../state/onboarding'
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

const WAITING: SyncProgress = { phase: 'connecting', counts: {} }

export function Sync(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const navigate = useUi((state) => state.navigate)
  const signedIn = settings?.signedIn === true
  const [progress, setProgress] = useState<SyncProgress>(signedIn ? WAITING : { phase: 'done', counts: {} })
  const [error, setError] = useState('')
  const [skipped, setSkipped] = useState(false)
  const started = useRef(false)

  const run = async (): Promise<void> => {
    setError('')
    setSkipped(false)
    setProgress(WAITING)
    try {
      const status = await agent.account.firstSync()
      if (status.error) setError(status.error)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sync could not finish.')
    }
  }

  useEffect(() => {
    if (!signedIn) {
      if (isLocalOnly()) {
        navigate({ page: 'onboarding', step: 'ai' })
      } else {
        setProgress({ phase: 'done', counts: {} })
      }
      return
    }
    const off = agent.account.onProgress((next) => {
      setProgress(next)
      if (next.phase === 'error') setError(next.message ?? 'Sync could not finish.')
    })
    if (!started.current) {
      started.current = true
      void run()
    }
    return off
  }, [signedIn, navigate])

  if (!signedIn && isLocalOnly()) {
    return (
      <OnboardingLayout step="sync">
        <div className="ob-col" />
      </OnboardingLayout>
    )
  }

  const done = progress.phase === 'done'
  const busy = progress.phase === 'connecting' || progress.phase === 'pulling'
  const failed = progress.phase === 'error' || (error !== '' && !done)
  const counts = progress.counts

  const countFor = (entities: EntityName[]): number =>
    entities.reduce((sum, entity) => sum + (counts[entity] ?? 0), 0)

  const rowState = (entities: EntityName[]): { count: number; done: boolean } => {
    const count = countFor(entities)
    return { count, done: !signedIn || done || count > 0 }
  }

  return (
    <OnboardingLayout step="sync">
      <div className="ob-col">
        <div>
          <div className="eyebrow">{signedIn ? 'ONE AGENT, TWO DEVICES' : 'A CLEAN START'}</div>
          <h1 className="h1" style={{ marginTop: 8 }}>
            {signedIn ? 'Bringing your agent over' : 'Starting fresh here'}
          </h1>
          <p className="muted" style={{ marginTop: 8, fontSize: 15 }}>
            {signedIn
              ? 'Your phone and this computer now work as the same agent. This takes a few seconds.'
              : 'Nothing to bring yet. Anything you teach it on this computer will show up on your phone once you add it.'}
          </p>
        </div>

        <div className="card">
          {ITEMS.map((item) => {
            const state = rowState(item.entities)
            const spinning = signedIn && busy && !state.done
            return (
              <div key={item.key} className={`syncrow${state.done && signedIn ? ' done' : ''}`}>
                <div className="st">
                  {state.done && signedIn ? (
                    <Icon name="check" size={18} />
                  ) : spinning ? (
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
                    {!signedIn
                      ? 'Empty'
                      : state.count > 0
                        ? `${state.count} brought over`
                        : done
                          ? 'Nothing yet'
                          : 'Waiting'}
                  </div>
                </div>
                <div className="small muted">
                  {!signedIn ? '' : state.done ? 'Done' : spinning ? 'Syncing' : 'Waiting'}
                </div>
              </div>
            )
          })}
        </div>

        <p className="small muted" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Icon name="lock" size={16} />
          API keys stay on the device they were typed on.
        </p>

        {failed ? (
          <div className="ob-note warn" role="status" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span>{error || 'Sync could not finish. You can try again, or carry on and sync later.'}</span>
            <span style={{ display: 'flex', gap: 8 }}>
              <Button size="sm" variant="tonal" onClick={() => void run()}>
                Retry
              </Button>
              <Button
                size="sm"
                variant="text"
                onClick={() => {
                  setSkipped(true)
                  navigate({ page: 'onboarding', step: 'ai' })
                }}
              >
                Skip for now
              </Button>
            </span>
          </div>
        ) : null}

        <Button
          size="lg"
          block
          disabled={signedIn && !done && !skipped}
          onClick={() => navigate({ page: 'onboarding', step: 'ai' })}
        >
          {signedIn && busy ? 'Syncing...' : 'Continue'}
          <Icon name="arrow" size={20} />
        </Button>
      </div>
    </OnboardingLayout>
  )
}
