import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { Logger, redact } from '../src/main/logger'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-log-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('redact', () => {
  it('removes OpenAI, Anthropic and OpenRouter style keys', () => {
    const text = 'keys sk-abcdefghijklmnopqrstuvwxyz sk-ant-api03-abcdefghijklmnop sk-or-v1-abcdefghijklmnop'
    const clean = redact(text)
    expect(clean).not.toContain('abcdefghijklmnop')
    expect(clean).toContain('sk-[redacted]')
  })

  it('removes Bearer tokens including the word Bearer', () => {
    const clean = redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature')
    expect(clean).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(clean).toContain('Bearer [redacted]')
  })

  it('removes email addresses', () => {
    expect(redact('contact someone@example.com for help')).toBe('contact [email] for help')
  })

  it('removes Google API keys and labelled secrets', () => {
    const clean = redact('AIzaSyA1234567890abcdefghijklmnopqrst and password: hunter2')
    expect(clean).not.toContain('AIzaSyA1234567890abcdefghijklmnopqrst')
    expect(clean).not.toContain('hunter2')
  })

  it('leaves ordinary operational text alone', () => {
    expect(redact('Window opened in 120 ms')).toBe('Window opened in 120 ms')
  })
})

describe('Logger', () => {
  it('writes a timestamped line to main.log inside the given folder', () => {
    const dir = tempDir()
    const logger = new Logger(dir)
    logger.info('Started', { platform: 'linux' })

    expect(logger.path()).toBe(join(dir, 'main.log'))
    const text = readFileSync(logger.path(), 'utf8')
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(text).toContain('INFO Started')
    expect(text).toContain('"platform":"linux"')
  })

  it('redacts secrets before they reach the file', () => {
    const dir = tempDir()
    const logger = new Logger(dir)
    logger.error('request failed for sk-live-abcdefghijklmnop with Bearer abcdefghijklmnopqrst', {
      email: 'person@example.com',
    })

    const text = readFileSync(logger.path(), 'utf8')
    expect(text).not.toContain('sk-live-abcdefghijklmnop')
    expect(text).not.toContain('abcdefghijklmnopqrst')
    expect(text).not.toContain('person@example.com')
    expect(text).toContain('[email]')
  })

  it('rotates to one previous file instead of growing without limit', () => {
    const dir = tempDir()
    const logger = new Logger(dir, { maxBytes: 120 })
    logger.info('first line that is long enough to fill the file')
    logger.info('second line that should cause rotation')
    logger.info('third line')

    expect(existsSync(join(dir, 'main.1.log'))).toBe(true)
    expect(readFileSync(join(dir, 'main.1.log'), 'utf8')).toContain('first line')
    expect(readFileSync(logger.path(), 'utf8')).toContain('third line')
  })

  it('never throws when the log folder cannot be written', () => {
    const dir = tempDir()
    const file = join(dir, 'not-a-folder')
    writeFileSync(file, 'occupied')
    const logger = new Logger(file)
    expect(() => logger.info('still fine')).not.toThrow()
  })

  it('creates the logs folder on first write', () => {
    const dir = tempDir()
    const logger = new Logger(join(dir, 'nested', 'logs'))
    logger.info('hello')
    expect(existsSync(logger.path())).toBe(true)
  })

  it('survives unreadable metadata', () => {
    const dir = tempDir()
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    const logger = new Logger(dir)
    expect(() => logger.info('meta test', circular)).not.toThrow()
    expect(readFileSync(logger.path(), 'utf8')).toContain('meta unreadable')
  })

  it('appends rather than replacing on each write', () => {
    const dir = tempDir()
    const logger = new Logger(dir)
    logger.info('one')
    logger.info('two')
    const text = readFileSync(logger.path(), 'utf8')
    expect(text.indexOf('one')).toBeLessThan(text.indexOf('two'))
  })

  it('starts a fresh folder without a previous file', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'logs'))
    const logger = new Logger(join(dir, 'logs'))
    logger.warn('warm')
    expect(existsSync(join(dir, 'logs', 'main.1.log'))).toBe(false)
  })
})

describe('redaction table', () => {
  it.each([
    ['an OpenAI style key', 'sk-live-abcdefghijklmnop', 'abcdefghijklmnop'],
    ['an Anthropic key', 'sk-ant-api03-abcdefghijklmnop', 'abcdefghijklmnop'],
    ['an OpenRouter key', 'sk-or-v1-abcdefghijklmnop', 'abcdefghijklmnop'],
    ['a project key', 'sk-proj-abcdefghijklmnop', 'abcdefghijklmnop'],
    ['a Google key', 'AIzaSyA1234567890abcdefghijklmnop', 'AIzaSyA1234567890'],
    ['a private email', 'first.last+tag@sub.example.org', 'first.last'],
    ['an uppercase email', 'PERSON@EXAMPLE.COM', 'PERSON'],
    ['a bearer token', 'Bearer abcdefghijklmnopqrst', 'abcdefghijklmnopqrst'],
    ['a lowercase bearer token', 'bearer abcdefghijklmnopqrst', 'abcdefghijklmnopqrst'],
    ['a labelled password', 'password=hunter2hunter2', 'hunter2hunter2'],
    ['a labelled token', 'token=abcdefghijklmnop', 'abcdefghijklmnop'],
    ['a labelled api key', 'api-key=abcdefghijklmnop', 'abcdefghijklmnop'],
  ])('removes %s', (_label, text, secret) => {
    expect(redact(text)).not.toContain(secret)
  })
})
