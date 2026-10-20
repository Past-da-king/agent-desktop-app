import type { GoalRow, TaskRow } from '@agent/core'
import { useEffect, useState } from 'react'

import { agent, chat } from '../bridge'
import { dueLabel } from '../lib/format'
import { useEntity, useEntityLoaded } from '../state/useData'
import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { Field } from '../ui/Field'
import { Icon } from '../ui/Icon'
import { Mascot } from '../ui/Mascot'
import { Ring } from '../ui/Ring'
import { Segmented } from '../ui/Segmented'
import { Skeleton } from '../ui/Skeleton'

function sortTasks(tasks: TaskRow[]): TaskRow[] {
  return [...tasks].sort((a, b) => {
    const aDone = a.status === 'done' ? 1 : 0
    const bDone = b.status === 'done' ? 1 : 0
    if (aDone !== bDone) return aDone - bDone
    if (a.dueAt === null && b.dueAt === null) return a.createdAt - b.createdAt
    if (a.dueAt === null) return 1
    if (b.dueAt === null) return -1
    return a.dueAt - b.dueAt
  })
}

function AddTaskDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const selectTask = useUi((state) => state.selectTask)
  const setTab = useUi((state) => state.setTaskTab)
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [due, setDue] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    if (title.trim() === '') {
      setError('Give the to-do a name first.')
      return
    }
    setBusy(true)
    const now = Date.now()
    const dueAt = due === '' ? null : new Date(`${due}T09:00:00`).getTime()
    const row: TaskRow = {
      id: '',
      createdAt: now,
      goalId: null,
      title: title.trim(),
      notes: notes.trim(),
      status: 'todo',
      dueAt: dueAt !== null && Number.isFinite(dueAt) ? dueAt : null,
      owner: 'user',
      blocker: '',
      updatedAt: now,
    }
    try {
      const saved = await agent.data.upsert('task', row)
      selectTask(saved.id)
      setTab('todos')
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that to-do.')
      setBusy(false)
    }
  }

  return (
    <Dialog
      label="Add a to-do"
      onClose={onClose}
      labelledBy="add-todo-title"
    >
      <div>
        <span className="eyebrow">NEW TO-DO</span>
        <h2 className="h2" id="add-todo-title" style={{ marginTop: 6 }}>
          What needs doing?
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
        <label htmlFor="todo-notes">Notes</label>
        <textarea
          id="todo-notes"
          className="textarea"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Anything useful to remember"
        />
      </div>
      <div className="field">
        <label htmlFor="todo-due">Due date</label>
        <input
          id="todo-due"
          className="input"
          type="date"
          value={due}
          onChange={(event) => setDue(event.target.value)}
          style={{ paddingRight: 18 }}
        />
      </div>
      <div className="dialog-actions">
        <Button variant="text" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={() => {
            void save()
          }}
          disabled={busy}
        >
          {busy ? 'Saving...' : 'Add to-do'}
        </Button>
      </div>
    </Dialog>
  )
}

function GoalCard({ goal, tasks }: { goal: GoalRow; tasks: TaskRow[] }): JSX.Element {
  const steps = tasks.filter((task) => task.goalId === goal.id)
  const done = steps.filter((task) => task.status === 'done').length
  return (
    <div className="goal-card">
      <div className="top">
        <Ring pct={steps.length === 0 ? 0 : (done / steps.length) * 100} size={56} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="h3" style={{ fontSize: 18 }}>
            {goal.title}
          </div>
          <div className="small muted num">
            {done} of {steps.length} steps
          </div>
        </div>
      </div>
      <div>
        {steps.length === 0 ? (
          <p className="muted small">No steps yet.</p>
        ) : (
          steps.map((step) => (
            <div key={step.id} className={`stp ${step.status === 'done' ? 'done' : step.status === 'blocked' ? 'wait' : ''}`}>
              <i>{step.status === 'done' ? <Icon name="check" size={13} /> : null}</i>
              <span>{step.title}</span>
              {step.status === 'blocked' ? <span className="pill warn">Needs you</span> : null}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export function Tasks(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const tasks = useEntity('task')
  const goals = useEntity('goal')
  const tasksLoaded = useEntityLoaded('task')
  const goalsLoaded = useEntityLoaded('goal')
  const loaded = tasksLoaded && goalsLoaded
  const tab = useUi((state) => state.taskTab)
  const setTab = useUi((state) => state.setTaskTab)
  const selectedId = useUi((state) => state.taskSel)
  const selectTask = useUi((state) => state.selectTask)
  const navigate = useUi((state) => state.navigate)
  const [adding, setAdding] = useState(false)

  const userTasks = sortTasks(tasks.filter((task) => task.owner === 'user'))
  const selected = userTasks.find((task) => task.id === selectedId) ?? userTasks[0]
  const agentName = settings?.agentName.trim() || 'your agent'

  useEffect(() => {
    if (!loaded) return
    if (userTasks.length === 0) return
    if (selectedId === null || !userTasks.some((task) => task.id === selectedId)) {
      const first = userTasks[0]
      if (first) selectTask(first.id)
    }
  }, [loaded, selectedId, selectTask, userTasks])

  const toggle = (task: TaskRow): void => {
    void agent.data.upsert('task', { ...task, status: task.status === 'done' ? 'todo' : 'done' })
  }

  const askAgent = (task: TaskRow): void => {
    void chat.send(`Can you take this on: ${task.title}`)
    navigate({ page: 'chat' })
  }

  return (
    <div className="page">
      <div className="ph">
        <div>
          <span className="eyebrow">TASKS</span>
          <h1 className="h1">{userTasks.filter((task) => task.status !== 'done').length} on your list</h1>
        </div>
        <div className="ph-actions">
          <Button onClick={() => setAdding(true)}>
            <Icon name="plus" size={18} />
            Add to-do
          </Button>
        </div>
      </div>

      <Segmented
        ariaLabel="Task lists"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'todos', label: 'Your to-dos' },
          { value: 'agent', label: "Agent's work" },
        ]}
        style={{ maxWidth: 440, marginBottom: 24 }}
      />

      {!loaded ? (
        <Skeleton rows={5} />
      ) : tab === 'todos' ? (
        userTasks.length === 0 ? (
          <EmptyState
            mascot={settings?.mascot ?? 'scout'}
            title="Your list is clear"
            line="Add something small now, or just tell the agent and it will keep the list for you."
            action={
              <Button variant="tonal" size="sm" onClick={() => setAdding(true)}>
                Add your first to-do
              </Button>
            }
          />
        ) : (
          <div className="md">
            <div>
              <div className="list">
                {userTasks.map((task) => (
                  <div key={task.id} className={`todo${task.status === 'done' ? ' done' : ''}${selected?.id === task.id ? ' on' : ''}`}>
                    <button
                      type="button"
                      className="cb"
                      role="checkbox"
                      aria-checked={task.status === 'done'}
                      aria-label={`Mark ${task.status === 'done' ? 'not done' : 'done'}: ${task.title}`}
                      onClick={() => toggle(task)}
                    >
                      {task.status === 'done' ? <Icon name="check" size={16} /> : null}
                    </button>
                    <button
                      type="button"
                      className="todo-body"
                      style={{ flex: 1, minWidth: 0, textAlign: 'left' }}
                      onClick={() => selectTask(task.id)}
                    >
                      <div className="tt">{task.title}</div>
                      <div className="dd">{dueLabel(task)}</div>
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {selected ? (
              <div className="detail">
                <div>
                  <span className="eyebrow">{selected.status === 'done' ? 'DONE' : 'TO-DO'}</span>
                  <h2 className="h2" style={{ marginTop: 6 }}>
                    {selected.title}
                  </h2>
                </div>
                <div className="kv">
                  <span className="eyebrow mute">DUE</span>
                  <span className="h3" style={selected.dueAt !== null && selected.dueAt - Date.now() < 86_400_000 && selected.status !== 'done' ? { color: 'var(--tert)' } : undefined}>
                    {dueLabel(selected)}
                  </span>
                </div>
                <div className="kv">
                  <span className="eyebrow mute">NOTES</span>
                  <p style={{ fontSize: 15, lineHeight: 1.6 }}>{selected.notes || 'No notes yet.'}</p>
                </div>
                <div className="say">
                  <Mascot id={settings?.mascot ?? 'scout'} size={44} />
                  <p>
                    {agentName} can take this on. It will check with you before anything leaves this computer.
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <Button onClick={() => toggle(selected)}>
                    {selected.status === 'done' ? 'Mark as not done' : 'Mark done'}
                  </Button>
                  <Button variant="tonal" onClick={() => askAgent(selected)}>
                    Ask {agentName} to do it
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        )
      ) : goals.filter((goal) => goal.status === 'open').length === 0 ? (
        <EmptyState
          mascot={settings?.mascot ?? 'scout'}
          title="No agent work yet"
          line="When you give the agent a bigger goal, its steps and progress appear here."
          action={
            <Button
              variant="tonal"
              size="sm"
              onClick={() => {
                navigate({ page: 'chat' })
              }}
            >
              Tell the agent a goal
            </Button>
          }
        />
      ) : (
        <div className="cols2">
          {goals
            .filter((goal) => goal.status === 'open')
            .map((goal) => (
              <GoalCard key={goal.id} goal={goal} tasks={tasks} />
            ))}
        </div>
      )}

      {adding ? <AddTaskDialog onClose={() => setAdding(false)} /> : null}
    </div>
  )
}
