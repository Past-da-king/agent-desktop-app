import { useEffect, useState } from 'react'
import type { ChatItem } from '@agent/core'
import { agent } from '../bridge'
import { useSettings } from '../state/useSettings'
import { Switch } from '../ui/Switch'
import { Button } from '../ui/Button'
import { toast } from '../state/useToast'
import { SettingRow } from './settings/Row'
import { ROW_BY_KEY } from './settings/registry'

const LABELS: Record<string, string> = {
  reviewerAgentId: 'Independent reviewer',
  testProof: 'Test proof',
  trialMergeAndSuite: 'Trial merge and suite',
  featureFlagStates: 'Feature flag states',
  environmentChecks: 'Environment checks',
  skippedTests: 'Skipped tests',
  diffHygiene: 'Diff hygiene',
  finalDescription: 'Final description',
}
function metadata(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return {}
  }
}
export function PrGateSettings(): JSX.Element {
  const settings = useSettings((s) => s.settings),
    save = useSettings((s) => s.save)
  const [rows, setRows] = useState<ChatItem[]>([])
  useEffect(() => {
    let alive = true,
      queued = false
    let shown = new Set<string>()
    const read = async (): Promise<void> => {
      const next = await agent.data.where('chat_item', {
        chat: 'pr-gate-audit',
        kind: 'pr_gate',
        newestFirst: true,
        limit: 100,
      })
      if (alive) {
        shown = new Set(next.map((row) => row.id))
        setRows(next)
      }
    }
    void read().catch(() => toast('Could not read the PR gate log.'))
    const off = agent.data.onChanged((change) => {
      if (change.entity !== 'chat_item' || queued) return
      const relevant = (item: typeof change): boolean =>
        item.row !== undefined
          ? (item.row as { kind?: unknown }).kind === 'pr_gate'
          : item.id !== undefined
            ? shown.has(item.id)
            : true
      if (change.batch ? !change.batch.some(relevant) : !relevant(change))
        return
      // Coalesce bursts; the query remains indexed and capped, including reset events.
      queued = true
      queueMicrotask(() => {
        queued = false
        if (alive)
          void read().catch(() => toast('Could not read the PR gate log.'))
      })
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  const [titles, setTitles] = useState(
    (settings?.prGateSkillPages ?? []).join('\n'),
  )
  useEffect(
    () => setTitles((settings?.prGateSkillPages ?? []).join('\n')),
    [settings?.prGateSkillPages],
  )
  const commit = (): void => {
    void save({
      prGateSkillPages: titles
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    })
      .then(() => toast('PR gate skill pages saved.'))
      .catch(() => toast('Could not save skill pages. Try again.'))
  }
  return (
    <div className="prgate">
      <SettingRow
        spec={ROW_BY_KEY['prGateEnabled']!}
        changed={settings?.prGateEnabled === true}
        onReset={() => void save({ prGateEnabled: false })}
      >
        <Switch
          on={settings?.prGateEnabled === true}
          label="PR gate"
          onToggle={(next) => void save({ prGateEnabled: next })}
        />
      </SettingRow>
      <SettingRow
        spec={ROW_BY_KEY['prGateSkillPages']!}
        stack
        changed={(settings?.prGateSkillPages.length ?? 0) > 0}
        onReset={() => void save({ prGateSkillPages: [] })}
      >
        <div className="prgate-pages">
          <label htmlFor="pr-gate-pages" className="small muted">
            One memory page title per line
          </label>
          <textarea
            id="pr-gate-pages"
            aria-label="PR gate skill pages"
            className="textarea"
            rows={3}
            value={titles}
            onChange={(e) => setTitles(e.target.value)}
            onBlur={commit}
          />
          <Button size="sm" onClick={commit}>
            Save skill pages
          </Button>
        </div>
      </SettingRow>
      <div className="prgate-help small muted">
        <p>Drafts pass freely. Review and merge actions need independent evidence. Grants pass the same call once within sixty minutes. Policy pages are read live; missing pages add the generic checklist.</p>
        <p>Explicit GitHub writes and review/merge controls are checked. Other DOM actions and opaque programs cannot be fully inspected. Unreadable PR payloads are held; unreadable local scripts pass with a deduplicated note. Review approvals are logged.</p>
        <p>Linked devices need this version and synced policy. Agents need your approval to change the policy. Codex command output keeps its head and tail within about 150,000 characters. Remote replay protection is bounded and resets when the host restarts.</p>
      </div>
      <div className="prgate-log" aria-label="PR gate log">
        <p className="eyebrow muted">PR GATE LOG</p>
        {rows.length === 0 ? (
          <p className="small muted">No gate events yet.</p>
        ) : (
          rows.map((row) => {
            const data = metadata(row.meta),
              fields = data['attestation']
            return (
              <details key={row.id} className="prgate-event">
                <summary>
                  <b>{row.text}</b>
                  <span className="small muted">
                    {new Date(row.createdAt).toLocaleString()}
                  </span>
                </summary>
                <p className="small">
                  {String(data['actor'] ?? '')} / {String(data['device'] ?? '')}{' '}
                  / {String(data['tool'] ?? '')}
                </p>
                {fields && typeof fields === 'object' ? (
                  <dl>
                    {Object.entries(fields).map(([key, value]) => (
                      <div key={key}>
                        <dt>{LABELS[key] ?? key}</dt>
                        <dd>{String(value)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </details>
            )
          })
        )}
        {rows.length > 0 ? (
          <p className="small muted">
            Newest 100 events. Up to 500 are kept in synced data. Evidence is
            redacted; raw commands and credentials are omitted.
          </p>
        ) : null}
      </div>
    </div>
  )
}
