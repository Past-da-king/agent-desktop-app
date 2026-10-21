import type { ChatItem } from '@agent/core'

import { plainText } from '../openui/lang'
import { tablesToOpenUi } from '../openui/report'
import { metaText, parseMeta } from './meta'

/** A report card's title, its body (without a first heading that only repeats the title) and its length. */
export function reportText(item: ChatItem): { title: string; markdown: string; words: number } {
  const meta = parseMeta(item.meta)
  const raw = metaText(meta, 'markdown') || item.text
  const title = metaText(meta, 'title') || item.text || 'Report'
  const trimmed = raw.replace(/^\s+/, '')
  const heading = /^(#{1,6})\s+(.*)\r?\n?/.exec(trimmed)
  const markdown =
    heading !== null && (heading[2] ?? '').trim().toLowerCase() === title.trim().toLowerCase()
      ? trimmed.slice(heading[0].length).replace(/^\s+/, '')
      : raw
  const words =
    typeof meta['words'] === 'number' && Number.isFinite(meta['words'])
      ? meta['words']
      : markdown.split(/\s+/).filter(Boolean).length
  return { title, markdown, words }
}

/** The opening words of a report as one plain line: cards become their titles, markup and rules go. */
export function plainPreview(markdown: string): string {
  return plainText(tablesToOpenUi(markdown))
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}
