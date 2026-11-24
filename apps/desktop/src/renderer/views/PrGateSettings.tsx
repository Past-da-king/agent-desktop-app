import { useEffect, useState } from 'react'
import { useEntity } from '../state/useData'
import { useSettings } from '../state/useSettings'
import { Switch } from '../ui/Switch'
import { Button } from '../ui/Button'
import { toast } from '../state/useToast'
import { SettingRow } from './settings/Row'
import { ROW_BY_KEY } from './settings/registry'

const LABELS: Record<string,string> = {
  reviewerAgentId:'Independent reviewer',testProof:'Test proof',trialMergeAndSuite:'Trial merge and suite',
  featureFlagStates:'Feature flag states',environmentChecks:'Environment checks',skippedTests:'Skipped tests',
  diffHygiene:'Diff hygiene',finalDescription:'Final description',
}
function metadata(text:string):Record<string,unknown>{
  try{return JSON.parse(text) as Record<string,unknown>}catch{return {}}
}
export function PrGateSettings(): JSX.Element {
  const settings=useSettings(s=>s.settings),save=useSettings(s=>s.save)
  const rows=useEntity('chat_item')
  const [titles,setTitles]=useState((settings?.prGateSkillPages??[]).join('\n'))
  useEffect(()=>setTitles((settings?.prGateSkillPages??[]).join('\n')),[settings?.prGateSkillPages])
  const commit=():void=>{
    void save({prGateSkillPages:titles.split('\n').map(s=>s.trim()).filter(Boolean)})
      .then(()=>toast('PR gate skill pages saved.')).catch(()=>toast('Could not save skill pages. Try again.'))
  }
  const log=rows.filter(r=>r.kind==='pr_gate').sort((a,b)=>b.createdAt-a.createdAt).slice(0,100)
  return <div className="prgate">
    <SettingRow spec={ROW_BY_KEY['prGateEnabled']!} changed={settings?.prGateEnabled===true} onReset={()=>void save({prGateEnabled:false})}>
      <Switch on={settings?.prGateEnabled===true} label="PR gate" onToggle={next=>void save({prGateEnabled:next})}/>
    </SettingRow>
    <SettingRow spec={ROW_BY_KEY['prGateSkillPages']!} stack changed={(settings?.prGateSkillPages.length??0)>0} onReset={()=>void save({prGateSkillPages:[]})}>
      <div className="prgate-pages">
        <label htmlFor="pr-gate-pages" className="small muted">One memory page title per line</label>
        <textarea id="pr-gate-pages" aria-label="PR gate skill pages" className="textarea" rows={3} value={titles} onChange={e=>setTitles(e.target.value)}/>
        <Button size="sm" onClick={commit}>Save skill pages</Button>
      </div>
    </SettingRow>
    <div className="prgate-help small muted">
      Drafts pass freely. Review and merge actions need independent evidence. A grant passes the same call once for sixty minutes after attestation.
      The checklist is read live from memory. Missing pages add the generic checklist.
      GitHub API writes, named ready/create/merge buttons and index-only GitHub clicks are checked.
      Other DOM interactions and dynamic external programs cannot be fully inspected.
      Unreadable body files and replay targets are held. Approving a review is logged without holding it.
      Agents need your approval to change this switch, policy list or configured policy pages.
    </div>
    <div className="prgate-log" aria-label="PR gate log">
      <p className="eyebrow muted">PR GATE LOG</p>
      {log.length===0?<p className="small muted">No gate events yet.</p>:log.map(row=>{
        const data=metadata(row.meta),fields=data['attestation']
        return <details key={row.id} className="prgate-event">
          <summary><b>{row.text}</b><span className="small muted">{new Date(row.createdAt).toLocaleString()}</span></summary>
          <p className="small">{String(data['actor']??'')} / {String(data['device']??'')} / {String(data['tool']??'')}</p>
          {fields&&typeof fields==='object'?<dl>{Object.entries(fields).map(([key,value])=><div key={key}><dt>{LABELS[key]??key}</dt><dd>{String(value)}</dd></div>)}</dl>:null}
        </details>
      })}
      {log.length>0?<p className="small muted">Newest 100 events. Up to 500 are kept in synced data. Evidence is redacted; raw commands and credentials are omitted.</p>:null}
    </div>
  </div>
}
