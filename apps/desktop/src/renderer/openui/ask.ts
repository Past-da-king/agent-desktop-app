import { NO, withNo } from '../../shared/ask-options'

/** A string literal in OpenUI Lang. */
export function q(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '').replace(/\n/g, '\\n')}"`
}

/**
 * What an agent asks of the user, as an OpenUI program: who needs you and why, the question, then one full-width
 * button per answer. No is always the last button. Ported from the phone app's AskCard.kt (AskProgram.build).
 */
export function askProgram(title: string, subtitle: string | null, question: string, options: string[]): string {
  const all = withNo(options)
  const last = all.length - 1
  const lines = [
    'root = Card([head, body, actions])',
    `head = CardHeader(${q(title)}${subtitle !== null && subtitle.trim() !== '' ? `, ${q(subtitle)}` : ''})`,
    `body = TextContent(${q(question)}, "large")`,
    `actions = Buttons([${all.map((_, i) => `b${i}`).join(', ')}], "column")`,
    ...all.map((o, i) => `b${i} = Button(${q(o)}, Action([@ToAssistant(${q(o)})]), ${q(i === 0 && last > 0 && o !== NO ? 'primary' : 'secondary')})`),
  ]
  return `${lines.join('\n')}\n`
}
