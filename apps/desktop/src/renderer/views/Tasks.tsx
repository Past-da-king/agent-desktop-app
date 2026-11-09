import type { GoalRow, TaskRow } from '@agent/core'
import { useEffect, useState } from 'react'

import { agent, chat } from '../bridge'
import { dueLabel } from '../lib/format'
import { dueTone, overdue, userTasks } from '../lib/tasks'
import { useEntity, useEntityLoaded } from '../state/useData'
import { useNarrow } from '../state/useNarrow'
import { useSettings } from '../state/useSettings'
import { toast } from '../state/useToast'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { Icon } from '../ui/Icon'
import { Mascot } from '../ui/Mascot'
import { Ring } from '../ui/Ring'
import { Segmented } from '../ui/Segmented'
import { Skeleton } from '../ui/Skeleton'
import { TaskDialog } from './TaskDialog'

/** The width where `.list-detail` becomes one column (styles/responsive.css). */
export const TASKS_NARROW = '(max-width:1180px)'

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
  const taskRows = useEntity('task')
  const goals = useEntity('goal')
  const tasksLoaded = useEntityLoaded('task')
  const goalsLoaded = useEntityLoaded('goal')
  const loaded = tasksLoaded && goalsLoaded
  const tab = useUi((state) => state.taskTab)
  const setTab = useUi((state) => state.setTaskTab)
  const selectedId = useUi((state) => state.taskSel)
  const selectTask = useUi((state) => state.selectTask)
  const navigate = useUi((state) => state.navigate)
  const [dialog, setDialog] = useState<{ task: TaskRow | null } | null>(null)
  // Below this width the list takes the whole page, so the detail opens over it instead of under 31 rows.
  const narrow = useNarrow(TASKS_NARROW)
  const [sheet, setSheet] = useState(false)

  const tasks = userTasks(taskRows)
  const selected = tasks.find((task) => task.id === selectedId) ?? tasks[0]
  const openCount = tasks.filter((task) => task.status !== 'done').length
  const agentName = settings?.agentName.trim() || 'your agent'

  useEffect(() => {
    if (!loaded) return
    if (tasks.length === 0) {
      if (selectedId !== null) selectTask(null)
      return
    }
    if (selectedId === null || !tasks.some((task) => task.id === selectedId)) {
      const first = tasks[0]
      if (first) selectTask(first.id)
    }
  }, [loaded, selectedId, selectTask, tasks])

  const toggle = (task: TaskRow): void => {
    void agent.data.upsert('task', { ...task, status: task.status === 'done' ? 'todo' : 'done' }).catch((cause: unknown) => {
      toast(cause instanceof Error ? cause.message : 'Could not change that to-do.')
    })
  }

  const remove = (task: TaskRow): void => {
    setDialog(null)
    setSheet(false)
    selectTask(null)
    void agent.data
      .remove('task', task.id)
      .then(() => {
        toast('To-do deleted.', {
          actionLabel: 'Undo',
          onAction: () => {
            void agent.data.upsert('task', task).catch((cause: unknown) => {
              toast(cause instanceof Error ? cause.message : 'Could not bring that to-do back.')
            })
          },
        })
      })
      .catch((cause: unknown) => {
        toast(cause instanceof Error ? cause.message : 'Could not delete that to-do.')
      })
  }

  const askAgent = (task: TaskRow): void => {
    void chat.send(`Can you take this on: ${task.title}`)
    navigate({ page: 'chat' })
  }

  const detail = selected ? (
              <div className={narrow ? 'detail in-dialog' : 'detail'}>
                <div>
                  <span className="eyebrow">{selected.status === 'done' ? 'DONE' : 'TO-DO'}</span>
                  <h2 className="h2" id="task-detail-title" style={{ marginTop: 6 }}>
                    {selected.title}
                  </h2>
                </div>
                <div className="kv">
                  <span className="eyebrow mute">DUE</span>
                  <span className={`h3 due${dueTone(selected)}`}>
                    {overdue(selected) ? 'Overdue · ' : ''}
                    {dueLabel(selected)}
                  </span>
                </div>
                <div className="kv">
                  <span className="eyebrow mute">STATUS</span>
                  <span style={{ fontSize: 15 }}>
                    {selected.status === 'doing'
                      ? 'Doing'
                      : selected.status === 'blocked'
                        ? 'Blocked'
                        : selected.status === 'done'
                          ? 'Done'
                          : 'To do'}
                  </span>
                </div>
                {selected.blocker ? (
                  <div className="kv">
                    <span className="eyebrow mute">BLOCKED BY</span>
                    <p style={{ fontSize: 15, lineHeight: 1.6 }}>{selected.blocker}</p>
                  </div>
                ) : null}
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
                  <Button variant="tonal" onClick={() => setDialog({ task: selected })}>
                    <Icon name="edit" size={18} />
                    Edit
                  </Button>
                  <Button variant="tonal" onClick={() => askAgent(selected)}>
                    Ask {agentName} to do it
                  </Button>
                  <Button
                    variant="line"
                    style={{ color: 'var(--err)', borderColor: 'var(--err)' }}
                    onClick={() => remove(selected)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
  ) : null

  return (
    <div className="page">
      <div className="ph">
        <div>
          <span className="eyebrow">TASKS</span>
          <h1 className="h1">{openCount === 0 ? 'A clear list' : `${openCount} on your list`}</h1>
        </div>
        <div className="ph-actions">
          <Button onClick={() => setDialog({ task: null })}>
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
          { value: 'todos', label: 'My to-dos' },
          { value: 'agent', label: "Agent's work" },
        ]}
        style={{ maxWidth: 440, marginBottom: 24 }}
      />

      {!loaded ? (
        <Skeleton rows={5} />
      ) : tab === 'todos' ? (
        tasks.length === 0 ? (
          <EmptyState
            mascot={settings?.mascot ?? 'scout'}
            title="Your list is clear"
            line="Add something small now, or just tell the agent and it will keep the list for you."
            action={
              <Button variant="tonal" size="sm" onClick={() => setDialog({ task: null })}>
                Add your first to-do
              </Button>
            }
          />
        ) : (
          <div className="list-detail">
            <div>
              <div className="list">
                {tasks.map((task) => (
                  <div key={task.id} className={`todo${task.status === 'done' ? ' done' : ''}${selected?.id === task.id && (!narrow || sheet) ? ' on' : ''}`}>
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
                      onClick={() => {
                        selectTask(task.id)
                        setSheet(true)
                      }}
                    >
                      <div className="tt">{task.title}</div>
                      <div className={`dd${dueTone(task)}`}>
                        {overdue(task) ? 'Overdue · ' : ''}
                        {dueLabel(task)}
                      </div>
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {narrow ? null : detail}
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
              <GoalCard key={goal.id} goal={goal} tasks={taskRows} />
            ))}
        </div>
      )}

      {narrow && sheet && detail !== null && dialog === null ? (
        <Dialog label="To-do" onClose={() => setSheet(false)} labelledBy="task-detail-title">
          {detail}
        </Dialog>
      ) : null}

      {dialog ? (
        <TaskDialog
          task={dialog.task}
          owner="user"
          goals={goals}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            selectTask(saved.id)
            setTab('todos')
          }}
          onDelete={remove}
        />
      ) : null}
    </div>
  )
}
