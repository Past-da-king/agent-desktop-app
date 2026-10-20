/**
 * A small file logger for the main process. Rotation keeps one previous file so a long-running
 * install cannot fill the disk. Callers pass short operational messages; prompts, file contents and
 * secrets must never reach this module, and `redact` is a second line of defence when they do.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'info' | 'warn' | 'error'
export type LogMeta = Record<string, unknown>

const DEFAULT_MAX_BYTES = 1024 * 1024

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  [/\b(?:x-api-key|api[_-]?key|token|password)\s*[:=]\s*\S+/gi, '[redacted]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
]

/** Remove anything that looks like a credential or a personal address. */
export function redact(text: string): string {
  let result = text
  for (const [pattern, replacement] of SECRET_PATTERNS) result = result.replace(pattern, replacement)
  return result
}

function formatMeta(meta: LogMeta | undefined): string {
  if (meta === undefined) return ''
  try {
    return ` ${redact(JSON.stringify(meta))}`
  } catch {
    return ' [meta unreadable]'
  }
}

export interface LoggerOptions {
  maxBytes?: number
}

export class Logger {
  private readonly dir: string
  private readonly file: string
  private readonly prior: string
  private readonly maxBytes: number

  constructor(dir: string, options: LoggerOptions = {}) {
    this.dir = dir
    this.file = join(dir, 'main.log')
    this.prior = join(dir, 'main.1.log')
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  }

  path(): string {
    return this.file
  }

  info(message: string, meta?: LogMeta): void {
    this.write('info', message, meta)
  }

  warn(message: string, meta?: LogMeta): void {
    this.write('warn', message, meta)
  }

  error(message: string, meta?: LogMeta): void {
    this.write('error', message, meta)
  }

  private write(level: LogLevel, message: string, meta?: LogMeta): void {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redact(message)}${formatMeta(meta)}\n`
    try {
      mkdirSync(this.dir, { recursive: true })
      this.rotateIfNeeded(Buffer.byteLength(line, 'utf8'))
      appendFileSync(this.file, line, 'utf8')
    } catch {
      // Logging must never take the app down.
    }
  }

  private rotateIfNeeded(incoming: number): void {
    if (!existsSync(this.file)) return
    const size = statSync(this.file).size
    if (size + incoming <= this.maxBytes) return
    try {
      if (existsSync(this.prior)) unlinkSync(this.prior)
      renameSync(this.file, this.prior)
    } catch {
      // If rotation fails, keep appending to the current file rather than losing the line.
    }
  }
}
