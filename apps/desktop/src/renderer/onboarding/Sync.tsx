import type { EntityName, SyncProgress } from '@agent/core'
import { useEffect, useState } from 'react'

import { agent } from '../bridge'
import { isLocalOnly } from '../state/onboarding'
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
  const navigate = useUi((state) => state.navigate)
  const localOnly = isLocalOnly()
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const fresh = signedIn === false || localOnly
  const [progress, setProgress] = useState<SyncProgress>({ phase: 'connecting', counts: {} })
  const [error, setError] = useState('')
  const [skipped, setSkipped] = useState(false)
  const [attempt, setAttempt] = useState(0)

  // Ask the account layer rather than trusting a settings event that may still be in flight
  // right after sign-in. The sync step must never mistake a fresh sign-in for local-only.
  useEffect(() => {
    let live = true
    void agent.account
      .status()
      .then((status) => {
        if (live) setSignedIn(status.signedIn)
      })
      .catch(() => {
        if (live) setSignedIn(false)
      })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    if (localOnly) {
      navigate({ page: 'onboarding', step: 'ai' })
    }
  }, [localOnly, navigate])

  useEffect(() => {
    if (localOnly) return
    if (signedIn === null) return
    if (!signedIn) {
      setProgress({ phase: 'done', counts: {} })
      return
    }
    let live = true
    setError('')
    setProgress({ phase: 'connecting', counts: {} })
    const off = agent.account.onProgress((next) => {
      if (!live) return
      setProgress(next)
      if (next.phase === 'error') setError(next.message ?? 'Sync could not finish.')
    })
    void agent.account
      .firstSync()
      .then((status) => {
        if (live && status.error) setError(status.error)
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : 'Sync could not finish.')
      })
    return () => {
      live = false
      off()
    }
  }, [signedIn, attempt, localOnly])

  const done = progress.phase === 'done'
  const busy = progress.phase === 'connecting' || progress.phase === 'pulling'
  const counts = progress.counts

  const countFor = (entities: EntityName[]): number =>
    entities.reduce((sum, entity) => sum + (counts[entity] ?? 0), 0)

  const ready = fresh || done || skipped

  return (
    <OnboardingLayout step="sync" onBack={() => navigate({ page: 'onboarding', step: 'signin' })}>
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
            const itemDone = fresh ? true : done || count > 0
            const itemBusy = !fresh && busy && !itemDone
            const detail = fresh
              ? 'Empty'
              : count > 0
                ? `${count} brought over`
                : done
                  ? 'Nothing yet'
                  : itemBusy
                    ? 'Looking...'
                    : 'Waiting'
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
                  <div className="small muted">{detail}</div>
                </div>
                <div className="small muted">
                  {fresh ? '' : itemDone ? 'Done' : itemBusy ? 'Looking...' : 'Waiting'}
                </div>
              </div>
            )
          })}
        </div>

        <p className="small muted" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Icon name="lock" size={16} />
          API keys stay on the device they were typed on.
        </p>

        {error ? (
          <>
            <p className="ob-note warn" role="status">
              {error} You can try again, or carry on and sync later from Settings.
            </p>
            <div className="ob-alt">
              <Button
                variant="line"
                disabled={busy}
                onClick={() => {
                  setSkipped(false)
                  setAttempt((value) => value + 1)
                }}
              >
                Retry
              </Button>
              <Button
                variant="text"
                onClick={() => {
                  setSkipped(true)
                  setError('')
                }}
              >
                Skip for now
              </Button>
            </div>
          </>
        ) : null}

        <div className="ob-cta">
          <Button
            size="lg"
            block
            disabled={fresh ? false : !ready}
            onClick={() => navigate({ page: 'onboarding', step: 'ai' })}
          >
            {fresh ? 'Continue' : ready ? 'Continue' : busy ? 'Syncing...' : 'Continue'}
            <Icon name="arrow" size={20} />
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  )
}
