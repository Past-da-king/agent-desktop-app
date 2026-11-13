import { accountsOf, type AiPick, type ModelOption, type Settings as SettingsValues } from '@agent/core'
import { useEffect, useState } from 'react'

import { agent } from '../../bridge'
import { HotkeyControl, SelectControl } from './Controls'
import { ROW_BY_KEY, isDefault, type RowSpec } from './registry'
import { SettingRow } from './Row'

/**
 * "Show me how" in Settings (10 Nov 2026): which model walks the steps, and the two keys a walk holds while it runs.
 * Automatic is the default for both halves of the pick: the account the main chat uses (a key account when there is
 * one), and the smallest fast model that account lists. Nothing here names a model.
 */
interface Props {
  settings: SettingsValues | null
  put: (patch: Partial<SettingsValues>) => void
  resetRow: (spec: RowSpec) => void
}

const AUTO = ''

function changed(spec: RowSpec, settings: SettingsValues | null): boolean {
  return settings !== null && !isDefault(spec, (settings as unknown as Record<string, unknown>)[spec.key])
}

/** Agents and helpers: the model that walks the steps when you ask to be shown how. */
export function GuideModelRow({ settings, put, resetRow }: Props): JSX.Element | null {
  const spec = ROW_BY_KEY['guideModel']
  const pick: AiPick = settings?.guideModel ?? { account: AUTO, model: AUTO }
  const accounts = settings === null ? [] : accountsOf(settings)
  const [models, setModels] = useState<ModelOption[]>([])

  useEffect(() => {
    let live = true
    setModels([])
    if (pick.account === AUTO) return
    agent.settings.accounts
      .listModels(pick.account)
      .then((result) => {
        if (live) setModels(result.models)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [pick.account])

  if (spec === undefined) return null
  const known = models.some((model) => model.id === pick.model)
  return (
    <SettingRow spec={spec} changed={changed(spec, settings)} onReset={() => resetRow(spec)}>
      <SelectControl
        label="Account that shows you how"
        value={accounts.some((account) => account.id === pick.account) ? pick.account : AUTO}
        options={[{ value: AUTO, label: 'Automatic' }, ...accounts.map((account) => ({ value: account.id, label: account.label }))]}
        onChange={(account) => put({ guideModel: { account, model: AUTO } })}
      />
      {pick.account === AUTO ? null : (
        <SelectControl
          label="Model that shows you how"
          value={pick.model}
          options={[
            { value: AUTO, label: 'Smallest fast model' },
            ...(pick.model !== AUTO && !known ? [{ value: pick.model, label: pick.model }] : []),
            ...models.map((model) => ({ value: model.id, label: model.label })),
          ]}
          onChange={(model) => put({ guideModel: { account: pick.account, model } })}
        />
      )}
    </SettingRow>
  )
}

/** Advanced: the keys a walk holds while it runs. Esc always stops it. */
export function ShowMeKeyRows({ settings, put, resetRow }: Props): JSX.Element {
  const skip = ROW_BY_KEY['showMeSkipHotkey']
  const done = ROW_BY_KEY['showMeDoneHotkey']
  return (
    <>
      {skip === undefined ? null : (
        <SettingRow spec={skip} changed={changed(skip, settings)} onReset={() => resetRow(skip)}>
          <HotkeyControl label="Skip a step shortcut" value={settings?.showMeSkipHotkey ?? ''} onSave={(next) => put({ showMeSkipHotkey: next })} />
        </SettingRow>
      )}
      {done === undefined ? null : (
        <SettingRow spec={done} changed={changed(done, settings)} onReset={() => resetRow(done)}>
          <HotkeyControl label="I did it shortcut" value={settings?.showMeDoneHotkey ?? ''} onSave={(next) => put({ showMeDoneHotkey: next })} />
        </SettingRow>
      )}
    </>
  )
}
