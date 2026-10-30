import { useEffect } from 'react'

import { reportText } from '../lib/report'
import { ReportBody } from '../openui/ReportBody'
import { useCalmEntity, useEntity } from '../state/useData'
import { usePanel } from '../state/usePanel'
import { CopyButton } from '../ui/CopyButton'
import { Icon } from '../ui/Icon'

/**
 * A report open beside the chat, in the side panel's place, drawn with OpenUI. The X (or Esc) closes it and the
 * browser panel is back as it was; the chat stays usable the whole time.
 */
export function ReportStage(): JSX.Element | null {
  const id = usePanel((store) => store.report)
  const close = usePanel((store) => store.closeReport)
  const items = useCalmEntity('chat_item')
  const row = id === null ? undefined : items.find((item) => item.id === id && item.kind === 'report')

  useEffect(() => {
    if (id === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [id, close])

  if (id === null) return null
  if (row === undefined) {
    return (
      <div className="hp-stage" role="region" aria-label="Report">
        <div className="hp-stage-bar">
          <b>This report is gone</b>
          <span className="hp-stage-gap" />
          <button type="button" className="hp-x" onClick={close} aria-label="Close the report">
            <Icon name="x" size={20} />
          </button>
        </div>
      </div>
    )
  }

  const report = reportText(row)
  return (
    <div className="hp-stage rp-stage" role="region" aria-label={`Report: ${report.title}`}>
      <div className="hp-stage-bar">
        <span className="hp-ic">
          <Icon name="doc" size={16} />
        </span>
        <span className="rp-bar-t">
          <span className="eyebrow">REPORT</span>
          <b>{report.title}</b>
        </span>
        <span className="hp-stage-gap" />
        <CopyButton text={report.markdown} label="Copy" />
        <button type="button" className="hp-x" onClick={close} aria-label="Close the report">
          <Icon name="x" size={20} />
        </button>
      </div>
      <div className="hp-stage-body">
        <div className="rp-col">
          <div className="small muted">
            {report.words} {report.words === 1 ? 'word' : 'words'}
          </div>
          <ReportBody markdown={report.markdown} />
        </div>
      </div>
    </div>
  )
}
