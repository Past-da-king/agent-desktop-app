import { Fragment, type ReactNode } from 'react'

/** Very small markdown: headings, bold, inline code, paragraphs, numbered and bulleted lists. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <b key={key}>{part.slice(2, -2)}</b>
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={key}>{part.slice(1, -1)}</code>
    }
    return <Fragment key={key}>{part}</Fragment>
  })
}

export function Markdown({ text }: { text: string }): JSX.Element {
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
            {inline(line, `${key}-${index}`)}
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
          <li key={`${key}-${index}`}>{inline(item, `${key}-${index}`)}</li>
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
          <li key={`${key}-${index}`}>{inline(item, `${key}-${index}`)}</li>
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

  for (const line of text.split('\n')) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      flushAll()
      const level = heading[1]?.length ?? 1
      blocks.push(
        <div className={level > 2 ? 'md-h sub' : 'md-h'} key={`h-${blocks.length}`}>
          {inline(heading[2] ?? '', `h-${blocks.length}`)}
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
  flushAll()

  return <>{blocks}</>
}
