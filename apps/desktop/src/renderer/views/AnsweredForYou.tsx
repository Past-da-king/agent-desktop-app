import { useEffect, useState } from 'react'
import type { AnsweredForYou } from '@agent/core'
import { agent } from '../bridge'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'

export function AnsweredForYouLink(): JSX.Element {
  const [open, setOpen] = useState(false)
  return <><Button variant="text" size="sm" onClick={() => setOpen(true)}>Answered for you</Button>{open ? <AnsweredForYouDialog onClose={() => setOpen(false)} /> : null}</>
}

export function AnsweredForYouDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [rows, setRows] = useState<AnsweredForYou[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setLoading(true)
    void agent.acts.list().then((value) => { if (live) { setRows(value); setError('') } }).catch(() => { if (live) setError('Could not load the answers.') }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [attempt])
  const undo = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      const result = await agent.acts.undo(id)
      if (!result.ok) setError(result.message)
      else setAttempt((n) => n + 1)
    } catch { setError('Undo did not go through. Try again.') }
    finally { setBusy('') }
  }
  return <Dialog label="Answered for you" onClose={onClose} className="answered-for-you">
    <div className="hp-title"><h2>Answered for you</h2><Button variant="text" size="sm" onClick={onClose}>Close</Button></div>
    <p className="muted">Decisions your agent made on your behalf, with its reason. Messages to people, payments and steps needing your own hands come to you.</p>
    {error ? <div role="alert">{error}<Button variant="text" size="sm" onClick={() => setAttempt((n) => n + 1)}>Retry</Button></div> : null}
    {loading ? <p className="muted" role="status">Loading answers...</p> : rows.length === 0 ? <p className="rowempty">Your agent has not answered any cards for you yet.</p> : <ol className="acts-list">{rows.map((row) => <li key={row.id} className="acts-entry">
      <div className="small muted"><time dateTime={new Date(row.at).toISOString()}>{new Date(row.at).toLocaleString()}</time> · {row.asker}</div>
      <b>{row.summary}</b>
      <div>{row.decision === 'answer' ? row.answer : row.decision === 'approve' ? 'Approved' : 'Declined'}</div>
      <p className="muted">{row.reason}</p>
      {row.undone > 0 ? <span className="small muted">Undone</span> : row.undo !== 'none' ? <Button variant="text" size="sm" disabled={busy !== ''} onClick={() => void undo(row.id)}>{busy === row.id ? 'Undoing...' : 'Undo'}</Button> : <span className="small muted">This action cannot be undone.</span>}
    </li>)}</ol>}
  </Dialog>
}
