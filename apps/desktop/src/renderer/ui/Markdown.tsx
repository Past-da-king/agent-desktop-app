import { Fragment, type ReactNode } from 'react'

/** Very small markdown: bold, inline code, paragraphs and numbered lists. */
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
  let list: string[] = []

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

  const flushList = (): void => {
    if (list.length === 0) return
    const key = `ol-${blocks.length}`
    blocks.push(
      <ol key={key}>
        {list.map((item, index) => (
          <li key={`${key}-${index}`}>{inline(item, `${key}-${index}`)}</li>
        ))}
      </ol>,
    )
    list = []
  }

  for (const line of text.split('\n')) {
    const item = /^\s*\d+\.\s+(.*)$/.exec(line)
    if (item) {
      flushParagraph()
      list.push(item[1] ?? '')
      continue
    }
    flushList()
    if (line.trim() === '') flushParagraph()
    else paragraph.push(line)
  }
  flushList()
  flushParagraph()

  return <>{blocks}</>
}
