/**
 * How attached files reach the model: classification, and text pulled out of real Word, Excel, PowerPoint and
 * PDF files written to disk here (real ZIP containers and a real deflated PDF content stream).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync, deflateSync } from 'node:zlib'

import { afterAll, describe, expect, it } from 'vitest'

import { attachmentKind, fileSizeLabel, type Attachment } from '@agent/core'

import { PER_FILE_CHARS, decodeText, documentText, prepareMessage, xmlDecode } from '../src/main/runtime/attachment-text'
import { zipEntries, zipTexts } from '../src/main/runtime/zip-read'

const dir = mkdtempSync(join(tmpdir(), 'agent-attach-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A real ZIP archive: deflated entries, local headers, central directory and end record. */
function zip(files: Record<string, string>, store = false): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8')
    const packed = store ? data : deflateRawSync(data)
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(store ? 0 : 8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, packed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(store ? 0 : 8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + packed.length
  }
  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, end])
}

const DOCX = zip({
  '[Content_Types].xml': '<Types/>',
  'word/document.xml':
    '<w:document><w:body><w:p><w:r><w:t>Quarterly report</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Revenue rose 12% &amp; costs fell.</w:t></w:r><w:r><w:tab/><w:t>Q3</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>R 1,200</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
})

const XLSX = zip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="Invoices" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>',
  'xl/sharedStrings.xml': '<sst><si><t>Invoice</t></si><si><t>Amount</t></si><si><t>INV-2047</t></si><si><r><t>Over</t></r><r><t>due</t></r></si></sst>',
  'xl/worksheets/sheet1.xml':
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12850</v></c><c r="D2" t="s"><v>3</v></c></row></sheetData></worksheet>',
  'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Call Thandi</t></is></c></row></sheetData></worksheet>',
})

const PPTX = zip({
  'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Next steps</a:t></a:r></a:p></p:sld>',
  'ppt/slides/slide10.xml': '<p:sld><a:p><a:r><a:t>Appendix</a:t></a:r></a:p></p:sld>',
  'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Launch plan</a:t></a:r></a:p><a:p><a:r><a:t>October</a:t></a:r></a:p></p:sld>',
})

/** A small real PDF with one deflated content stream that draws two lines of text. */
function pdf(): Buffer {
  const content = 'BT /F1 18 Tf 72 720 Td (Invoice summary for Acme) Tj 0 -24 Td [(Total due: R 12) -300 (850)] TJ ET'
  const packed = deflateSync(Buffer.from(content, 'latin1'))
  const head = Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
      '3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n' +
      `4 0 obj << /Length ${packed.length} /Filter /FlateDecode >>\nstream\n`,
    'latin1',
  )
  const tail = Buffer.from('\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1')
  return Buffer.concat([head, packed, tail])
}

function file(name: string, data: Buffer | string, mime = ''): Attachment {
  const path = join(dir, name)
  writeFileSync(path, data)
  return { path, name, mime, size: Buffer.byteLength(data) }
}

describe('attachment kinds', () => {
  it.each([
    ['photo.PNG', '', 'image'],
    ['shot.jpeg', 'image/jpeg', 'image'],
    ['clipboard', 'image/png', 'image'],
    ['report.docx', '', 'document'],
    ['budget.xlsx', '', 'document'],
    ['deck.pptx', '', 'document'],
    ['scan.pdf', 'application/pdf', 'document'],
    ['notes.txt', '', 'text'],
    ['main.tsx', '', 'text'],
    ['query.sql', '', 'text'],
    ['README', 'text/plain', 'text'],
    ['logo.svg', 'image/svg+xml', 'text'],
    ['site.zip', 'application/zip', 'file'],
    ['setup.exe', '', 'file'],
    ['clip.mp4', 'video/mp4', 'file'],
    ['data.bin', '', 'file'],
  ])('%s (%s) is %s', (name, mime, kind) => {
    expect(attachmentKind(name, mime)).toBe(kind)
  })

  it('labels sizes for the chips', () => {
    expect(fileSizeLabel(312)).toBe('312 bytes')
    expect(fileSizeLabel(38_400)).toBe('38 KB')
    expect(fileSizeLabel(2_400_000)).toBe('2.3 MB')
  })
})

describe('reading the zip container', () => {
  it('lists and inflates entries, stored or deflated', () => {
    const stored = zip({ 'a.txt': 'plain', 'b/c.xml': '<x/>' }, true)
    expect(zipEntries(stored).map((entry) => entry.name)).toEqual(['a.txt', 'b/c.xml'])
    expect(zipTexts(stored, () => true).map((entry) => entry.text)).toEqual(['plain', '<x/>'])
    expect(zipTexts(DOCX, (name) => name === 'word/document.xml')[0]?.text).toContain('Quarterly report')
    expect(zipEntries(Buffer.from('not a zip at all'))).toEqual([])
  })
})

describe('text pulled out of documents', () => {
  it('reads a Word document with paragraphs, tabs and table cells', () => {
    const text = documentText(DOCX, 'report.docx') ?? ''
    expect(text).toContain('Quarterly report\nRevenue rose 12% & costs fell.\tQ3')
    expect(text).toContain('North\tR 1,200')
  })

  it('reads every sheet of a workbook as rows, with shared and inline strings', () => {
    const text = documentText(XLSX, 'budget.xlsx') ?? ''
    expect(text).toContain('Sheet: Invoices\nInvoice\tAmount\nINV-2047\t12850\t\tOverdue')
    expect(text).toContain('Sheet: Notes\nCall Thandi')
  })

  it('reads slides in slide order', () => {
    const text = documentText(PPTX, 'deck.pptx') ?? ''
    expect(text.indexOf('Slide 1\nLaunch plan\nOctober')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('Slide 2')).toBeLessThan(text.indexOf('Slide 10'))
  })

  it('reads the text a simple PDF draws, and gives up on one with none', () => {
    const text = documentText(pdf(), 'invoice.pdf') ?? ''
    expect(text).toContain('Invoice summary for Acme')
    expect(text).toContain('Total due: R 12 850')
    expect(documentText(Buffer.from('%PDF-1.4\n%%EOF'), 'empty.pdf')).toBeNull()
  })

  it('decodes text files and refuses binary ones', () => {
    expect(decodeText(Buffer.from('﻿hello', 'utf8'))).toBe('hello')
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('wide text', 'utf16le')]))).toBe('wide text')
    expect(decodeText(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toBeNull()
    expect(xmlDecode('a &lt;b&gt; &#65;&#x42; &amp;amp;')).toBe('a <b> AB &amp;')
  })
})

describe('the message the model gets', () => {
  it('sends pictures as images, puts document and text content in, and names other files by path', async () => {
    const picture = file('screen.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png')
    const word = file('report.docx', DOCX)
    const sheet = file('budget.xlsx', XLSX)
    const code = file('build.ts', 'export const answer = 42\n')
    const archive = file('site.zip', zip({ 'index.html': '<h1>hi</h1>' }), 'application/zip')
    const scan = file('invoice.pdf', pdf(), 'application/pdf')

    const prepared = await prepareMessage('Check these', [picture, word, sheet, code, archive, scan])
    expect(prepared.images).toEqual([picture.path])
    expect(prepared.text.startsWith('Check these\n\nAttached files:')).toBe(true)
    expect(prepared.text).toContain(`screen.png (picture, 4 bytes) at ${picture.path}. The picture is attached for you to look at.`)
    expect(prepared.text).toContain(`report.docx (document, `)
    expect(prepared.text).toContain('--- report.docx ---\nQuarterly report')
    expect(prepared.text).toContain('--- budget.xlsx ---\nSheet: Invoices')
    expect(prepared.text).toContain('--- build.ts ---\nexport const answer = 42')
    expect(prepared.text).toContain('--- invoice.pdf ---\nInvoice summary for Acme')
    expect(prepared.text).toContain(`site.zip (zip archive, `)
    expect(prepared.text).toContain(`at ${archive.path}. Open it with your file tools if you need what is inside.`)
    expect(prepared.text).not.toContain('--- site.zip ---')
  })

  it('cuts a long file and says where the rest is', async () => {
    const long = file('log.txt', 'x'.repeat(PER_FILE_CHARS + 500))
    const prepared = await prepareMessage('', [long])
    expect(prepared.text.startsWith('I attached some files.')).toBe(true)
    expect(prepared.text).toContain('(cut here; the whole file is')
  })

  it('lists a file it cannot read instead of failing the message', async () => {
    const gone: Attachment = { path: join(dir, 'missing.docx'), name: 'missing.docx', mime: '' }
    const prepared = await prepareMessage('see attached', [gone])
    expect(prepared.text).toContain('missing.docx (document) at')
    expect(prepared.text).toContain('could not be read here; open it with your file tools')
  })

  it('leaves a message with no files as it is', async () => {
    expect(await prepareMessage('hello', [])).toEqual({ text: 'hello', images: [] })
  })
})
