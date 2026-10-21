import { Fragment, type ReactNode } from 'react'

import { CopyButton } from './CopyButton'

/** A fenced code block, with its language and a copy button. */
function CodeBlock({ code, lang }: { code: string; lang: string }): JSX.Element {
  return (
    <div className="md-code">
      <div className="md-code-h">
        <span>{lang === '' ? 'Code' : lang}</span>
        <CopyButton text={code} label="Copy code" />
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}

/** Very small markdown: headings, bold, inline code, paragraphs, numbered and bulleted lists, and memory links. */
function inline(text: string, keyPrefix: string, onWikiLink?: (name: string) => void): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[\[[^\]]+\]\])/g)
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <b key={key}>{part.slice(2, -2)}</b>
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={key}>{part.slice(1, -1)}</code>
    }
    const link = /^\[\[([^\]]+)\]\]$/.exec(part)
    if (link) {
      const name = link[1]?.trim() ?? ''
      if (onWikiLink && name !== '') {
        return (
          <button key={key} type="button" className="linkish" onClick={() => onWikiLink(name)}>
            {name}
          </button>
        )
      }
      return <Fragment key={key}>{name}</Fragment>
    }
    return <Fragment key={key}>{part}</Fragment>
  })
}

export function Markdown({
  text,
  onWikiLink,
}: {
  text: string
  /** When given, `[[Page]]` becomes a real button that navigates to (or creates) that memory page. */
  onWikiLink?: (name: string) => void
}): JSX.Element {
  const blocks: ReactNode[] = []
  let paragraph: string[] = []
  let numbered: string[] = []
  let bulleted: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    const key = `p-${blocks.length}`
    blocks.push(
      <p key={key}>
        {paragraph.map((line, index) => (
          <Fragment key={`${key}-${index}`}>
            {index > 0 ? <br /> : null}
            {inline(line, `${key}-${index}`, onWikiLink)}
          </Fragment>
        ))}
      </p>,
    )
    paragraph = []
  }

  const flushNumbered = (): void => {
    if (numbered.length === 0) return
    const key = `ol-${blocks.length}`
    blocks.push(
      <ol key={key}>
        {numbered.map((item, index) => (
          <li key={`${key}-${index}`}>{inline(item, `${key}-${index}`, onWikiLink)}</li>
        ))}
      </ol>,
    )
    numbered = []
  }

  const flushBulleted = (): void => {
    if (bulleted.length === 0) return
    const key = `ul-${blocks.length}`
    blocks.push(
      <ul key={key}>
        {bulleted.map((item, index) => (
          <li key={`${key}-${index}`}>{inline(item, `${key}-${index}`, onWikiLink)}</li>
        ))}
      </ul>,
    )
    bulleted = []
  }

  const flushAll = (): void => {
    flushParagraph()
    flushNumbered()
    flushBulleted()
  }

  let fence: { lang: string; lines: string[] } | null = null
  for (const line of text.split('\n')) {
    // Fenced code (```lang ... ```): kept exactly as written, with a copy button.
    const fenceLine = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line)
    if (fence !== null) {
      if (fenceLine !== null && fenceLine[1] === '') {
        blocks.push(<CodeBlock key={`code-${blocks.length}`} code={fence.lines.join('\n')} lang={fence.lang} />)
        fence = null
      } else {
        fence.lines.push(line)
      }
      continue
    }
    if (fenceLine !== null) {
      flushAll()
      fence = { lang: fenceLine[1] ?? '', lines: [] }
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      flushAll()
      const level = heading[1]?.length ?? 1
      blocks.push(
        <div className={level > 2 ? 'md-h sub' : 'md-h'} key={`h-${blocks.length}`}>
          {inline(heading[2] ?? '', `h-${blocks.length}`, onWikiLink)}
        </div>,
      )
      continue
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      flushParagraph()
      flushNumbered()
      bulleted.push(bullet[1] ?? '')
      continue
    }
    const item = /^\s*\d+\.\s+(.*)$/.exec(line)
    if (item) {
      flushParagraph()
      flushBulleted()
      numbered.push(item[1] ?? '')
      continue
    }
    flushNumbered()
    flushBulleted()
    if (line.trim() === '') flushParagraph()
    else paragraph.push(line)
  }
  // A block still open at the end (a reply that is still streaming) shows what it has so far.
  if (fence !== null) blocks.push(<CodeBlock key={`code-${blocks.length}`} code={fence.lines.join('\n')} lang={fence.lang} />)
  flushAll()

  return <>{blocks}</>
}
