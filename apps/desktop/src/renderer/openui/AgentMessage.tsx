import type { ChatItem } from '@agent/core'
import { useMemo } from 'react'

import { agent, chat } from '../bridge'
import { metaStrings, parseMeta } from '../lib/meta'
import { Markdown } from '../ui/Markdown'
import { askProgram } from './ask'
import { splitMessage } from './lang'
import { OpenUiBlock, OpenUiProvider, type OpenUiHandlers } from './OpenUiView'

function openUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) return
  void agent.shell.openExternal(url).catch(() => {
    // Opening a link is best effort; the card stays as it was.
  })
}

/**
 * An agent message: its words as markdown, and every ```openui-lang block drawn as cards in place. A button on a
 * card goes to the agent quietly (chat.tap); a follow-up chip is sent as the person's own message.
 */
export function AgentMessage({ item }: { item: ChatItem }): JSX.Element {
  const parts = useMemo(() => splitMessage(item.text), [item.text])
  const taps = metaStrings(parseMeta(item.meta), 'taps')
  const tapKey = taps.join('\u0000')
  const handlers = useMemo<OpenUiHandlers>(
    () => ({
      send: (text) => {
        if (text.trim() !== '') void chat.send(text)
      },
      act: (label, message) => {
        void chat.tap(item.id, label, message)
      },
      openUrl,
      tapped: new Set(tapKey === '' ? [] : tapKey.split('\u0000')),
    }),
    [item.id, tapKey],
  )
  const rich = parts.some((part) => part.kind === 'openui')
  return (
    <div className={`a-msg${rich ? ' rich' : ''}`}>
      <OpenUiProvider value={handlers}>
        {parts.map((part, i) =>
          part.kind === 'prose' ? (
            <div className="a-prose" key={i}>
              <Markdown text={part.text} />
            </div>
          ) : (
            <OpenUiBlock key={i} source={part.source} streaming={!part.closed} />
          ),
        )}
      </OpenUiProvider>
    </div>
  )
}

/**
 * A question the agent is waiting on, drawn as an OpenUI ask card: who needs you, the question, one full-width
 * button per answer, and always a No. A tap answers the question itself; nothing is posted as a message.
 */
export function AskCard({ question, options, disabled, onPick }: { question: string; options: string[]; disabled: boolean; onPick: (answer: string) => void }): JSX.Element {
  const source = useMemo(() => askProgram('Needs you', 'Pick one, or type your own answer below', question, options), [question, options])
  const handlers = useMemo<OpenUiHandlers>(() => ({ pick: (text) => (disabled ? undefined : onPick(text)), openUrl }), [disabled, onPick])
  return (
    <div className={`oui-ask${disabled ? ' busy' : ''}`}>
      <OpenUiProvider value={handlers}>
        <OpenUiBlock source={source} />
      </OpenUiProvider>
    </div>
  )
}
