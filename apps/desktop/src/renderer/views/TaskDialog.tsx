import type { GoalRow, TaskRow } from '@agent/core'
import { useState } from 'react'

import { agent } from '../bridge'
import { dateInputValue, dueAtFromDateInput } from '../lib/format'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field } from '../ui/Field'
import { Icon } from '../ui/Icon'

export function TaskDialog({
  task,
  owner,
  goals,
  onClose,
  onSaved,
  onDelete,
}: {
  task: TaskRow | null
  owner: TaskRow['owner']
  goals: GoalRow[]
  onClose: () => void
  onSaved: (row: TaskRow) => void
  onDelete?: (row: TaskRow) => void
}): JSX.Element {
  const [title, setTitle] = useState(task?.title ?? '')
  const [notes, setNotes] = useState(task?.notes ?? '')
  const [status, setStatus] = useState<TaskRow['status']>(task?.status ?? 'todo')
  const [goalId, setGoalId] = useState(task?.goalId ?? '')
  const [blocker, setBlocker] = useState(task?.blocker ?? '')
  const [due, setDue] = useState(dateInputValue(task?.dueAt ?? null))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    if (title.trim() === '') {
      setError('Give the to-do a name first.')
      return
    }
    setBusy(true)
    const now = Date.now()
    const row: TaskRow = {
      id: task?.id ?? '',
      createdAt: task?.createdAt ?? now,
      goalId: goalId === '' ? null : goalId,
      title: title.trim(),
      notes: notes.trim(),
      status,
      dueAt: dueAtFromDateInput(due, task?.dueAt ?? null),
      owner: task?.owner ?? owner,
      blocker: status === 'blocked' ? blocker.trim() : '',
      updatedAt: now,
    }
    try {
      const saved = await agent.data.upsert('task', row)
      onSaved(saved)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that to-do.')
      setBusy(false)
    }
  }

  return (
    <Dialog
      label={task ? 'Edit to-do' : 'Add a to-do'}
      onClose={onClose}
      labelledBy="task-dialog-title"
    >
      <div>
        <span className="eyebrow">{task ? 'EDIT TO-DO' : owner === 'agent' ? 'AGENT STEP' : 'NEW TO-DO'}</span>
        <h2 className="h2" id="task-dialog-title" style={{ marginTop: 6 }}>
          {task ? 'Change this to-do' : 'What needs doing?'}
        </h2>
      </div>
      <Field
        label="To-do"
        value={title}
        onChange={(value) => {
          setTitle(value)
          setError('')
        }}
        placeholder="Send Lerato the invoice"
        error={error}
        onEnter={() => {
          void save()
        }}
      />
      <div className="field">
        <label htmlFor="task-notes">Notes</label>
        <textarea
          id="task-notes"
          className="textarea"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Anything useful to remember"
        />
      </div>
      <div className="task-grid">
        <div className="field">
          <label htmlFor="task-due">Due date</label>
          <input
            id="task-due"
            className="input"
            type="date"
            value={due}
            onChange={(event) => setDue(event.target.value)}
            style={{ paddingRight: 18 }}
          />
        </div>
        <div className="field">
          <label htmlFor="task-status">Status</label>
          <select
            id="task-status"
            className="input"
            value={status}
            onChange={(event) => setStatus(event.target.value as TaskRow['status'])}
            style={{ paddingRight: 18 }}
          >
            <option value="todo">To do</option>
            <option value="doing">Doing</option>
            <option value="blocked">Blocked</option>
            <option value="done">Done</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="task-goal">Goal</label>
        <select
          id="task-goal"
          className="input"
          value={goalId}
          onChange={(event) => setGoalId(event.target.value)}
          style={{ paddingRight: 18 }}
        >
          <option value="">No goal</option>
          {goals
            .filter((goal) => goal.status === 'open' || goal.id === task?.goalId)
            .map((goal) => (
              <option key={goal.id} value={goal.id}>
                {goal.title}
              </option>
            ))}
        </select>
      </div>
      {status === 'blocked' ? (
        <div className="field">
          <label htmlFor="task-blocker">What is blocking it?</label>
          <textarea
            id="task-blocker"
            className="textarea"
            value={blocker}
            onChange={(event) => setBlocker(event.target.value)}
            placeholder="Waiting for you to choose a guesthouse"
            style={{ minHeight: 80 }}
          />
        </div>
      ) : null}
      <div className="dialog-actions">
        {task && onDelete ? (
          <Button
            variant="line"
            style={{ color: 'var(--err)', borderColor: 'var(--err)', marginRight: 'auto' }}
            onClick={() => onDelete(task)}
            disabled={busy}
          >
            <Icon name="trash" size={18} />
            Delete
          </Button>
        ) : null}
        <Button variant="text" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={() => {
            void save()
          }}
          disabled={busy}
        >
          {busy ? 'Saving...' : task ? 'Save changes' : 'Add to-do'}
        </Button>
      </div>
    </Dialog>
  )
}
