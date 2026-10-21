import { useMemo } from 'react'

import { agent, chat } from '../bridge'
import { Markdown } from '../ui/Markdown'
import { OpenUiBlock, OpenUiProvider, type OpenUiHandlers } from './OpenUiView'
import { reportParts } from './report'

function openUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) return
  void agent.shell.openExternal(url).catch(() => {
    // Opening a link is best effort; the report stays as it was.
  })
}

/**
 * A report as OpenUI draws it: the prose as markdown with working links, and every card block and table as cards
 * in place. A follow-up chip in a report is sent as the person's own message.
 */
export function ReportBody({ markdown }: { markdown: string }): JSX.Element {
  const parts = useMemo(() => reportParts(markdown), [markdown])
  const handlers = useMemo<OpenUiHandlers>(
    () => ({
      send: (text) => {
        if (text.trim() !== '') void chat.send(text)
      },
      openUrl,
    }),
    [],
  )
  return (
    <div className="a-msg rich report-body">
      <OpenUiProvider value={handlers}>
        {parts.map((part, i) =>
          part.kind === 'prose' ? (
            <div className="a-prose" key={i}>
              <Markdown text={part.text} onLink={openUrl} />
            </div>
          ) : (
            <OpenUiBlock key={i} source={part.source} />
          ),
        )}
      </OpenUiProvider>
    </div>
  )
}
