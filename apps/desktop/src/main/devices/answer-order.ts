/** A recovered preferred brain gets idle screens back even when a metered phone skips probes. */
export interface AnswerBrain { id: string; name: string }
export interface AnswerOrderDeps {
  selfId(): string
  brains(): AnswerBrain[]
  health(brain: AnswerBrain): Promise<boolean>
  busy(): boolean
  selfReady?(): boolean
  screens(): string[]
  handback(id: string): void
}
export class AnswerOrder {
  private checking = false
  private candidate = ''
  private healthy = 0
  private yielded = new Set<string>()
  private sentence = 'Checking which device should answer.'
  constructor(private readonly deps: AnswerOrderDeps) {}
  line(): string { return this.sentence }
  async tick(): Promise<void> {
    if (this.checking) return
    this.checking = true
    try {
      const brains = this.deps.brains()
      const self = brains.find(b => b.id === this.deps.selfId())
      const unavailable: string[] = []
      let best: AnswerBrain | undefined
      for (const brain of brains) {
        if (brain.id === this.deps.selfId()) { if (this.deps.selfReady?.() !== false) { best = brain; break }; unavailable.push(brain.name); continue }
        if (await this.deps.health(brain).catch(() => false)) { best = brain; break }
        unavailable.push(brain.name)
      }
      const preferred = best?.id ?? ''
      if (preferred !== this.candidate) { this.candidate = preferred; this.healthy = 0; this.yielded.clear() }
      if (best === undefined) { this.sentence = 'No device is ready to answer.'; return }
      if (preferred === this.deps.selfId()) {
        this.healthy = 0
        this.sentence = unavailable.length === 0 ? `${self?.name ?? 'This device'} is answering: first in order.` : `${self?.name ?? 'This device'} is answering: ${unavailable.join(', ')} is not reachable or not ready.`
        return
      }
      this.healthy++
      const reason = this.deps.busy() ? 'finishing the current turn before handing back' : 'idle screens reconnect in answer order'
      this.sentence = this.deps.screens().length > 0
        ? `${self?.name ?? 'This device'} is answering: ${best.name} recovered; ${reason}. ${best.name} is ready: first in order.`
        : `${best.name} is ready: first in order. No screen is connected here.`
      if (this.healthy < 2 || this.deps.busy()) return
      for (const id of this.deps.screens()) {
        // A phone unable to reach that brain may return here. Do not make a reconnect loop.
        if (this.yielded.has(id)) continue
        this.yielded.add(id)
        this.deps.handback(id)
      }
    } finally { this.checking = false }
  }
}
