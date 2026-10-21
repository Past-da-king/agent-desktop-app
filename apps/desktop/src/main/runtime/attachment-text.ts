/**
 * How the files the person attaches reach the model. One rule (attachmentKind in @agent/core):
 *  - pictures go as images the model looks at;
 *  - text and code files are read and put in the message;
 *  - Word, Excel, PowerPoint, OpenDocument and PDF files have their text pulled out and put in the message;
 *  - anything else (a zip, an installer, a video) is named with its saved path so the agent opens it with its
 *    own file tools.
 * Every file is also listed with its path, so the agent can always go back to the original.
 */
import { promises as fs } from 'node:fs'
import { inflateSync } from 'node:zlib'

import { attachmentKind, fileSizeLabel, type Attachment, type AttachmentKind } from '@agent/core'

import { zipTexts } from './zip-read'

/** Text from one file never takes more than this much of the message. */
export const PER_FILE_CHARS = 30_000
/** All attached text together. */
export const TOTAL_CHARS = 80_000
const MAX_TEXT_BYTES = 2 * 1024 * 1024

export interface PreparedMessage {
  /** What the model reads: the person's words, the file list and any text pulled out of the files. */
  text: string
  /** Absolute paths of pictures, sent as images. */
  images: string[]
}

interface Read {
  file: Attachment
  kind: AttachmentKind
  text: string | null
}

/** The message the model gets for this text and these files. Never throws: a file it cannot read is listed by path. */
export async function prepareMessage(text: string, attachments: Attachment[]): Promise<PreparedMessage> {
  if (attachments.length === 0) return { text, images: [] }
  const images: string[] = []
  const reads: Read[] = []
  let budget = TOTAL_CHARS
  for (const file of attachments) {
    const kind = attachmentKind(file.name, file.mime)
    if (kind === 'image') {
      images.push(file.path)
      reads.push({ file, kind, text: null })
      continue
    }
    if (kind === 'file' || budget <= 0) {
      reads.push({ file, kind, text: null })
      continue
    }
    let body: string | null = null
    try {
      body = kind === 'text' ? await readTextFile(file.path) : await readDocument(file.path, file.name)
    } catch {
      body = null
    }
    if (body !== null && body.trim() !== '') {
      const limit = Math.min(PER_FILE_CHARS, budget)
      const clipped =
        body.length > limit
          ? `${body.slice(0, limit)}\n...(cut here; the whole file is ${body.length} characters, open it with your file tools for the rest)`
          : body
      budget -= Math.min(body.length, limit)
      reads.push({ file, kind, text: clipped })
    } else {
      reads.push({ file, kind, text: null })
    }
  }

  const lines = reads.map(({ file, kind, text: body }) => {
    const size = file.size === undefined ? '' : `, ${fileSizeLabel(file.size)}`
    const what = `${file.name} (${describeKind(kind, file.name)}${size}) at ${file.path}`
    if (kind === 'image') return `- ${what}. The picture is attached for you to look at.`
    if (body !== null) return `- ${what}. Its text is below.`
    if (kind === 'file') return `- ${what}. Open it with your file tools if you need what is inside.`
    return `- ${what}. Its text could not be read here; open it with your file tools.`
  })
  const bodies = reads
    .filter((read) => read.text !== null)
    .map((read) => `--- ${read.file.name} ---\n${read.text}\n--- end of ${read.file.name} ---`)
  const head = text.trim() === '' ? 'I attached some files.' : text
  return {
    text: [head, `Attached files:\n${lines.join('\n')}`, ...bodies].join('\n\n'),
    images,
  }
}

function describeKind(kind: AttachmentKind, name: string): string {
  const extension = (name.split('.').pop() ?? '').toLowerCase()
  if (kind === 'image') return 'picture'
  if (extension === 'docx' || extension === 'odt') return 'document'
  if (extension === 'xlsx' || extension === 'ods') return 'spreadsheet'
  if (extension === 'pptx' || extension === 'odp') return 'slides'
  if (extension === 'pdf') return 'PDF'
  if (kind === 'text') return 'text file'
  if (extension === 'zip') return 'zip archive'
  return 'file'
}

/** A text file as text, or null when it is really binary. */
export async function readTextFile(path: string): Promise<string | null> {
  const handle = await fs.open(path, 'r')
  try {
    const info = await handle.stat()
    const length = Math.min(info.size, MAX_TEXT_BYTES)
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, 0)
    return decodeText(buf)
  } finally {
    await handle.close()
  }
}

/** UTF-8 (or UTF-16 with a byte order mark) text, or null when the bytes look binary. */
export function decodeText(buf: Buffer): string | null {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  const sample = buf.subarray(0, 8192)
  let zeros = 0
  for (const byte of sample) if (byte === 0) zeros++
  if (zeros > 0) return null
  return buf.toString('utf8').replace(/^﻿/, '')
}

export async function readDocument(path: string, name: string): Promise<string | null> {
  const info = await fs.stat(path)
  if (info.size > 25 * 1024 * 1024) return null
  const buf = await fs.readFile(path)
  return documentText(buf, name)
}

/** The readable text of an Office, OpenDocument or PDF file, or null when there is none to pull out. */
export function documentText(buf: Buffer, name: string): string | null {
  const extension = (name.split('.').pop() ?? '').toLowerCase()
  switch (extension) {
    case 'docx':
      return wordText(buf)
    case 'pptx':
      return slidesText(buf)
    case 'xlsx':
      return sheetText(buf)
    case 'odt':
    case 'ods':
    case 'odp':
      return openDocumentText(buf)
    case 'pdf':
      return pdfText(buf)
    default:
      return null
  }
}

// ---- Office XML ---------------------------------------------------------------------------------

export function xmlDecode(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeChar(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
}

function safeChar(code: number): string {
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

function tidy(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function wordText(buf: Buffer): string | null {
  const parts = zipTexts(buf, (entry) => /^word\/(document|footnotes|endnotes)\.xml$/.test(entry))
  if (parts.length === 0) return null
  const text = parts
    .map((part) =>
      part.text
        .replace(/<w:tab\/>/g, '\t')
        .replace(/<w:br[^>]*\/>/g, '\n')
        // A table row reads as one line of tab-separated cells.
        .replace(/<\/w:p>\s*<\/w:tc>/g, '\t')
        .replace(/<\/w:tc>/g, '\t')
        .replace(/\t?<\/w:tr>/g, '\n')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<[^>]+>/g, ''),
    )
    .join('\n')
  return tidy(xmlDecode(text)) || null
}

function slideNumber(name: string): number {
  const match = /(\d+)\.xml$/.exec(name)
  return match ? Number(match[1]) : 0
}

function slidesText(buf: Buffer): string | null {
  const slides = zipTexts(buf, (entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry)).sort(
    (a, b) => slideNumber(a.name) - slideNumber(b.name),
  )
  if (slides.length === 0) return null
  const text = slides
    .map((slide) => {
      const body = slide.text
        .replace(/<\/a:p>/g, '\n')
        .replace(/<a:br[^>]*\/>/g, '\n')
        .replace(/<[^>]+>/g, '')
      return `Slide ${slideNumber(slide.name)}\n${tidy(xmlDecode(body))}`
    })
    .join('\n\n')
  return tidy(text) || null
}

/** Column letters of a cell reference ("BC12" -> 54), 1-based. */
function columnOf(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? ''
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

function sheetText(buf: Buffer): string | null {
  const all = zipTexts(buf, (entry) => /^xl\/(sharedStrings|workbook)\.xml$|^xl\/worksheets\/sheet\d+\.xml$/.test(entry))
  const shared: string[] = []
  const sharedXml = all.find((part) => part.name === 'xl/sharedStrings.xml')?.text ?? ''
  for (const si of sharedXml.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
    const texts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1] ?? '')
    shared.push(xmlDecode(texts.join('')))
  }
  const names = [...(all.find((part) => part.name === 'xl/workbook.xml')?.text ?? '').matchAll(/<sheet [^>]*name="([^"]*)"/g)].map(
    (m) => xmlDecode(m[1] ?? ''),
  )
  const sheets = all
    .filter((part) => part.name.startsWith('xl/worksheets/'))
    .sort((a, b) => slideNumber(a.name) - slideNumber(b.name))
  if (sheets.length === 0) return null
  const out: string[] = []
  sheets.forEach((sheet, index) => {
    const rows: string[] = []
    for (const row of sheet.text.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
      const cells: string[] = []
      for (const cell of row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
        const ref = /\br="([A-Z]+)\d+"/.exec(cell)?.[1] ?? ''
        const type = /\bt="([^"]+)"/.exec(cell)?.[1] ?? ''
        let value = ''
        if (type === 's') value = shared[Number(/<v>([^<]*)<\/v>/.exec(cell)?.[1] ?? -1)] ?? ''
        else if (type === 'inlineStr') value = xmlDecode([...cell.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1] ?? '').join(''))
        else value = xmlDecode(/<v>([^<]*)<\/v>/.exec(cell)?.[1] ?? '')
        const column = ref === '' ? cells.length + 1 : columnOf(ref)
        while (cells.length < column - 1) cells.push('')
        cells.push(value.replace(/[\t\n]+/g, ' '))
      }
      if (cells.some((cell) => cell !== '')) rows.push(cells.join('\t'))
    }
    out.push(`Sheet: ${names[index] ?? `Sheet ${index + 1}`}\n${rows.join('\n')}`)
  })
  return tidy(out.join('\n\n')) || null
}

function openDocumentText(buf: Buffer): string | null {
  const content = zipTexts(buf, (entry) => entry === 'content.xml')[0]
  if (content === undefined) return null
  const text = content.text
    .replace(/<text:tab\/>/g, '\t')
    .replace(/<text:line-break\/>/g, '\n')
    .replace(/<\/text:(p|h)>/g, '\n')
    .replace(/<\/table:table-cell>/g, '\t')
    .replace(/<\/table:table-row>/g, '\n')
    .replace(/<[^>]+>/g, '')
  return tidy(xmlDecode(text)) || null
}

// ---- PDF ----------------------------------------------------------------------------------------

/**
 * The text a simple PDF draws (Tj and TJ in its content streams). PDFs whose fonts use custom encodings come
 * out empty or as noise; then this returns null and the agent opens the file itself.
 */
export function pdfText(buf: Buffer): string | null {
  const raw = buf.toString('latin1')
  const chunks: string[] = []
  const streamPattern = /<<([\s\S]*?)>>\s*stream\r?\n/g
  let match = streamPattern.exec(raw)
  while (match !== null) {
    const dict = match[1] ?? ''
    const begin = match.index + match[0].length
    const end = raw.indexOf('endstream', begin)
    if (end < 0) break
    if (!/\/Subtype\s*\/Image|\/Type\s*\/XObject/.test(dict)) {
      let data = buf.subarray(begin, end)
      let content: string | null = null
      if (/\/FlateDecode/.test(dict)) {
        try {
          content = inflateSync(data).toString('latin1')
        } catch {
          // Trailing bytes before endstream can upset inflate; trim the line break and try once more.
          data = data.subarray(0, Math.max(0, data.length - 2))
          try {
            content = inflateSync(data).toString('latin1')
          } catch {
            content = null
          }
        }
      } else if (!/\/Filter/.test(dict)) {
        content = data.toString('latin1')
      }
      if (content !== null && /\bBT\b/.test(content)) chunks.push(textOperators(content))
    }
    streamPattern.lastIndex = end
    match = streamPattern.exec(raw)
  }
  const text = tidy(chunks.join('\n'))
  const letters = (text.match(/[A-Za-zÀ-ɏ]/g) ?? []).length
  if (letters < 20 || letters < text.length * 0.3) return null
  return text
}

function textOperators(content: string): string {
  const out: string[] = []
  const blocks = content.match(/BT[\s\S]*?ET/g) ?? []
  for (const block of blocks) {
    let line = ''
    const ops = /(\[(?:[^\]\\]|\\.)*\])\s*TJ|(\((?:[^()\\]|\\.|\((?:[^()\\]|\\.)*\))*\))\s*(?:Tj|'|")|(T\*|Td|TD|Tm)/g
    let op = ops.exec(block)
    while (op !== null) {
      if (op[1] !== undefined) {
        for (const part of op[1].matchAll(/\((?:[^()\\]|\\.)*\)|-?\d+(?:\.\d+)?/g)) {
          const token = part[0]
          if (token.startsWith('(')) line += pdfString(token)
          else if (Number(token) < -200) line += ' '
        }
      } else if (op[2] !== undefined) {
        line += pdfString(op[2])
      } else if (op[3] !== undefined && line !== '') {
        out.push(line)
        line = ''
      }
      op = ops.exec(block)
    }
    if (line !== '') out.push(line)
  }
  return out.join('\n')
}

function pdfString(token: string): string {
  const inner = token.slice(1, -1)
  return inner.replace(/\\(\d{1,3}|.)/g, (_m, esc: string) => {
    if (/^\d+$/.test(esc)) return String.fromCharCode(parseInt(esc, 8))
    switch (esc) {
      case 'n':
        return '\n'
      case 'r':
        return ''
      case 't':
        return '\t'
      case 'b':
      case 'f':
        return ''
      default:
        return esc
    }
  })
}
