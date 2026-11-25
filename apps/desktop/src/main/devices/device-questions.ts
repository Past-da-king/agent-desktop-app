import type { ApprovalOrigin, JsonObject, ToolContext } from '@agent/core'
import type { DataStore } from '../runtime/data'

/** Paired hands ask through the context that dispatched the command, never as a fresh user request. */
export class DeviceQuestions {
  private readonly contexts = new Map<string, { ctx: ToolContext; expires: number }>()
  private readonly questions = new Map<string, { command: string; signature: string; answer: Promise<{ handled: true; answer: string | null }> }>()
  constructor(private readonly store: DataStore, private readonly self: () => string, private readonly now: () => number) {}
  remember(id: string, ctx: ToolContext, expires: number): void { this.contexts.set(id, { ctx, expires }) }
  forget(id: string): void {
    this.contexts.delete(id)
    for (const [key, value] of this.questions) if (value.command === id) this.questions.delete(key)
  }
  clear(): void { this.contexts.clear(); this.questions.clear() }
  prune(): void {
    for (const [id, value] of this.contexts) if (value.expires <= this.now() || value.ctx.signal.aborted) this.forget(id)
  }
  async ask(device: string, args: unknown[]): Promise<{ handled: boolean; answer: string | null }> {
    const prior = typeof args[0] === 'string' ? this.contexts.get(args[0]) : undefined
    if (prior?.ctx.signal.aborted === true) return { handled: true, answer: null }
    this.prune()
    const [id, sequence, question, options, offeredOrigin] = args
    if (typeof id !== 'string' || typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 1 || sequence > 128 || typeof question !== 'string' || question.length > 16000 || !Array.isArray(options) || options.length > 20 || !options.every((item) => typeof item === 'string' && item.length <= 1000)) throw new Error('Invalid device question.')
    const row = await this.store.get('device_command', id)
    if (row === null || row.kind !== 'tool' || row.brainId !== this.self() || row.target !== device || row.expiresAt <= this.now() || (row.status !== 'queued' && row.status !== 'sent')) throw new Error('That command is not active for this device.')
    const active = this.contexts.get(id)
    if (active === undefined) return { handled: false, answer: null }
    let input: JsonObject = {}
    try { const parsed: unknown = JSON.parse(row.args ?? '{}'); if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) input = parsed as JsonObject } catch { /* No invented arguments. */ }
    let origin: ApprovalOrigin = { tool: row.tool ?? '', input }
    if (typeof offeredOrigin === 'object' && offeredOrigin !== null && !Array.isArray(offeredOrigin)) {
      const value = offeredOrigin as Record<string, unknown>
      const learned = row.tool === 'webapp_run' || row.tool === 'webapp_test' || row.tool?.startsWith('web_') === true
      if (learned && value['tool'] === 'webapp_run' && typeof value['input'] === 'object' && value['input'] !== null && !Array.isArray(value['input'])) {
        const inner = value['input'] as JsonObject
        const name = typeof input['tool'] === 'string' ? input['tool'] : inner['tool']
        const matches = name === inner['tool'] && (row.tool === 'webapp_run' || row.tool === 'webapp_test' || (typeof name === 'string' && row.tool?.endsWith(`_${name}`) === true))
        // The hands may supply metadata from its saved tool definition, but cannot rename the selected operation
        // or substitute the caller's actual arguments with content from a question or page.
        if (matches) origin = { tool: 'webapp_run', input: { app: inner['app'] ?? '', tool: name ?? '', description: inner['description'] ?? '', sends: inner['sends'] === true, args: input['args'] ?? input } }
      }
    }
    const signature = JSON.stringify([question, options, origin])
    if (signature.length > 64000) throw new Error('Device question is too large.')
    const key = `${id}:${sequence}`
    const previous = this.questions.get(key)
    if (previous !== undefined) {
      if (previous.signature !== signature) throw new Error('That question id already belongs to different content.')
      return previous.answer
    }
    const answer = (async (): Promise<{ handled: true; answer: string | null }> => {
      if (question.startsWith('APPROVAL|')) {
        const rest = question.slice(9); const split = rest.indexOf('|')
        if (split < 0) throw new Error('Invalid approval question.')
        const yes = await active.ctx.approve(rest.slice(0, split), rest.slice(split + 1), undefined, origin)
        return { handled: true, answer: yes ? 'Approve' : 'Decline' }
      }
      return { handled: true, answer: await active.ctx.ask(question, options as string[], undefined, origin) }
    })()
    this.questions.set(key, { command: id, signature, answer })
    return answer
  }
}
