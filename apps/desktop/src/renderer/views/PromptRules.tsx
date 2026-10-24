/**
 * Settings > Instructions: the person's standing instructions for every agent (shared/prompt-rules.ts). He sees each
 * rule, edits it, deletes it and reads how it changed; the agent changes them too when he asks (prompt_rules). Every
 * change is kept as a version. They are synced rows, so his other devices and the server use the same ones.
 */
import type { PromptRuleRow } from '@agent/core'
import { useState } from 'react'

import { agent } from '../bridge'
import { useEntity } from '../state/useData'
import { toast } from '../state/useToast'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/bits'
import { SectionHeader } from '../ui/SectionHeader'
import { activeRules, editedRule, newRule, removedRule, RULE_MAX_CHARS } from '../../shared/prompt-rules'

/** What the Settings page writes as "who". */
const BY_YOU = 'you'

export function PromptRulesSettings(): JSX.Element {
  const rows = useEntity('prompt_rule')
  const run = (work: Promise<unknown>, done: string): void => {
    void work.then(() => toast(done)).catch((cause: unknown) => toast(cause instanceof Error ? cause.message : 'That did not save.'))
  }
  return (
    <PromptRulesList
      rows={rows}
      onAdd={(text) => run(agent.data.upsert('prompt_rule', newRule(text, 'Added in Settings', BY_YOU, Date.now())), 'Rule added. Every agent follows it from its next run.')}
      onEdit={(row, text) => {
        const change = editedRule(row, text, 'Edited in Settings', BY_YOU, Date.now())
        if (change !== null) run(agent.data.upsert('prompt_rule', change), 'Rule saved.')
      }}
      onRemove={(row) => {
        const change = removedRule(row, 'Deleted in Settings', BY_YOU, Date.now())
        if (change === null) return
        void agent.data
          .upsert('prompt_rule', change)
          .then(() =>
            toast('Rule deleted.', {
              actionLabel: 'Undo',
              onAction: () => {
                const back = editedRule({ ...row, ...change } as PromptRuleRow, row.text, 'Undo in Settings', BY_YOU, Date.now())
                if (back !== null) void agent.data.upsert('prompt_rule', back)
              },
            }),
          )
          .catch(() => toast('That did not delete.'))
      }}
    />
  )
}

export interface PromptRulesListProps {
  rows: PromptRuleRow[]
  onAdd: (text: string) => void
  onEdit: (row: PromptRuleRow, text: string) => void
  onRemove: (row: PromptRuleRow) => void
}

/** The section itself, from its rows (so it can be drawn in tests). */
export function PromptRulesList({ rows, onAdd, onEdit, onRemove }: PromptRulesListProps): JSX.Element {
  const rules = activeRules(rows)
  const [draft, setDraft] = useState('')
  const add = (): void => {
    const text = draft.trim()
    if (text === '') return
    onAdd(text)
    setDraft('')
  }
  return (
    <section className="prules">
      <SectionHeader eyebrow="INSTRUCTIONS" line="Rules every agent follows, from its next run" />
      <div className="card prules-card">
        <p className="small muted prules-lead">
          Your standing instructions, in every agent's prompt: the main chat, project chats, helpers and routines, on all
          your devices. Ask your agent to "update the system prompt" or write one here. They never switch off asking
          before deleting, paying or sending.
        </p>
        {rules.length === 0 ? <p className="prules-none">No rules yet.</p> : null}
        <ul className="prules-list">
          {rules.map((rule) => (
            <RuleRow key={rule.id} rule={rule} onEdit={onEdit} onRemove={onRemove} />
          ))}
        </ul>
        <div className="prules-add">
          <label className="eyebrow mute" htmlFor="prules-new">
            NEW RULE
          </label>
          <textarea
            id="prules-new"
            className="textarea"
            value={draft}
            maxLength={RULE_MAX_CHARS}
            placeholder="For example: close your browser tabs when you are done."
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                add()
              }
            }}
          />
          <div className="prules-actions">
            <Button variant="tonal" size="sm" disabled={draft.trim() === ''} onClick={add}>
              Add rule
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}

function RuleRow({ rule, onEdit, onRemove }: { rule: PromptRuleRow; onEdit: PromptRulesListProps['onEdit']; onRemove: PromptRulesListProps['onRemove'] }): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(rule.text)
  const [history, setHistory] = useState(false)
  const versions = Array.isArray(rule.history) ? rule.history : []
  const latest = versions[versions.length - 1]
  return (
    <li className="prules-rule">
      {editing ? (
        <div className="prules-edit">
          <textarea
            className="textarea"
            aria-label="Rule"
            value={text}
            maxLength={RULE_MAX_CHARS}
            onChange={(event) => setText(event.target.value)}
            autoFocus
          />
          <div className="prules-actions">
            <Button variant="text" size="sm" onClick={() => { setText(rule.text); setEditing(false) }}>
              Cancel
            </Button>
            <Button
              variant="tonal"
              size="sm"
              disabled={text.trim() === ''}
              onClick={() => {
                onEdit(rule, text)
                setEditing(false)
              }}
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div className="prules-body">
          <p className="prules-text">{rule.text}</p>
          <div className="prules-tools">
            <IconButton icon="edit" size={18} label="Edit rule" onClick={() => { setText(rule.text); setEditing(true) }} />
            <IconButton icon="trash" size={18} label="Delete rule" onClick={() => onRemove(rule)} />
          </div>
        </div>
      )}
      <div className="prules-meta small muted">
        <span>
          {latest === undefined ? 'Added' : changeWord(latest.change)} {when(rule.updatedAt || rule.createdAt)}
          {latest === undefined ? '' : ` by ${latest.by}`}
          {rule.reason.trim() === '' ? '' : `: ${rule.reason.trim()}`}
        </span>
        {versions.length > 1 ? (
          <button type="button" className="prules-hist-btn" aria-expanded={history} onClick={() => setHistory(!history)}>
            {history ? 'Hide history' : `History (${versions.length})`}
          </button>
        ) : null}
      </div>
      {history ? (
        <ol className="prules-hist">
          {[...versions].reverse().map((version) => (
            <li key={version.n}>
              <span className="small muted">
                v{version.n} {changeWord(version.change).toLowerCase()} {when(version.at)} by {version.by}
                {version.reason === '' ? '' : ` (${version.reason})`}
              </span>
              <span className="prules-hist-text">{version.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </li>
  )
}

function changeWord(change: string): string {
  if (change === 'edited') return 'Changed'
  if (change === 'removed') return 'Deleted'
  if (change === 'restored') return 'Brought back'
  return 'Added'
}

/** "24 Oct, 16:40": when a rule changed. */
function when(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  return `on ${new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
}
