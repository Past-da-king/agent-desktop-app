import { useEffect, useState } from 'react'
import { useEntity } from '../state/useData'
import { useSettings } from '../state/useSettings'
import { Switch } from '../ui/Switch'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { toast } from '../state/useToast'

/** The audit is synced chat data, so decisions made on a node are visible here too. */
export function PrGateSettings(): JSX.Element {
  const settings = useSettings(s => s.settings)
  const save = useSettings(s => s.save)
  const rows = useEntity('chat_item')
  const [titles,setTitles] = useState((settings?.prGateSkillPages ?? []).join('\n'))
  useEffect(()=>setTitles((settings?.prGateSkillPages ?? []).join('\n')), [settings?.prGateSkillPages])
  const log = rows.filter(r=>r.kind==='pr_gate').sort((a,b)=>b.createdAt-a.createdAt).slice(0,100)
  return <div className="card wake-card">
    <div className="rowc">
      <div className="ri"><Icon name="shield" size={22}/></div>
      <div className="rt"><b>PR gate</b><span>Require independent review evidence before making a pull request reviewable. Drafts pass freely.</span></div>
      <Switch on={settings?.prGateEnabled === true} label="PR gate" onToggle={next=>void save({prGateEnabled:next})}/>
    </div>
    <label className="small" htmlFor="pr-gate-pages">PR gate skill pages</label>
    <p className="small muted">One memory page title per line. Read live at each gate hit. Missing pages use the generic checklist.</p>
    <textarea id="pr-gate-pages" className="input" rows={4} value={titles} onChange={e=>setTitles(e.target.value)} style={{width:'100%',boxSizing:'border-box'}}/>
    <Button onClick={()=>void save({prGateSkillPages:titles.split('\n').map(s=>s.trim()).filter(Boolean)}).then(()=>toast('PR gate skill pages saved.')).catch(()=>toast('Could not save skill pages. Try again.'))}>Save skill pages</Button>
    <p className="small muted">Each attestation passes the identical call once within ten minutes. Logs omit commands and credentials. This checks recognised GitHub operations, not arbitrary programs.</p>
    <h3>PR gate log</h3>
    {log.length===0 ? <p className="small muted">No gate events yet.</p> : log.map(row=>{
      let data: Record<string,unknown> = {}
      try { data = JSON.parse(row.meta) as Record<string,unknown> } catch { /* A malformed older row remains readable. */ }
      return <details key={row.id} className="rowc" style={{display:'block',overflowWrap:'anywhere'}}>
        <summary>{row.text} <span className="small muted">{new Date(row.createdAt).toLocaleString()}</span></summary>
        <p className="small">{String(data['actor'] ?? '')} ? {String(data['device'] ?? '')} ? {String(data['tool'] ?? '')}</p>
        <pre className="small" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(data,null,2)}</pre>
      </details>
    })}
  </div>
}
