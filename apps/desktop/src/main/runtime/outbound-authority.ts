import { DatabaseSync } from 'node:sqlite'

/** A definite rejection proves no message was accepted by the provider. */
export class DefiniteSendFailure extends Error {}
export type Reconciliation = { status: 'sent'; result: string } | { status: 'absent' } | { status: 'unknown' }

/** Local to the designated authority. A claimed record is never automatically retried after a crash. */
export class OutboundAuthority {
  private readonly db: DatabaseSync
  private readonly running = new Map<string, Promise<string>>()
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path)
    this.db.exec("CREATE TABLE IF NOT EXISTS outbound_claims (key TEXT PRIMARY KEY, state TEXT NOT NULL, result TEXT, updated_at INTEGER NOT NULL)")
  }
  async send(key: string, send: () => Promise<string>, reconcile?: () => Promise<Reconciliation>): Promise<string> {
    const pending = this.running.get(key)
    if (pending !== undefined) return pending
    const job = this.execute(key, send, reconcile).finally(() => this.running.delete(key))
    this.running.set(key, job)
    return job
  }
  private async execute(key: string, send: () => Promise<string>, reconcile?: () => Promise<Reconciliation>): Promise<string> {
    const row = this.db.prepare('SELECT state, result FROM outbound_claims WHERE key = ?').get(key)
    if (row?.['state'] === 'sent') return String(row['result'])
    if (row?.['state'] === 'claimed') throw new Error('Send is already claimed; outcome unknown')
    if (row?.['state'] === 'unknown') {
      if (reconcile === undefined) throw new Error('Unknown send outcome: reconciliation required')
      const outcome = await reconcile()
      if (outcome.status === 'unknown') throw new Error('Unknown send outcome: reconciliation required')
      if (outcome.status === 'sent') {
        this.db.prepare("UPDATE outbound_claims SET state='sent', result=?, updated_at=? WHERE key=?").run(outcome.result, Date.now(), key)
        return outcome.result
      }
      this.db.prepare("UPDATE outbound_claims SET state='failed', updated_at=? WHERE key=? AND state='unknown'").run(Date.now(), key)
      // A claimed row could still be active in another process: never release it here.
    }
    const claim = this.db.prepare("INSERT INTO outbound_claims (key,state,updated_at) VALUES (?, 'claimed', ?) ON CONFLICT(key) DO UPDATE SET state='claimed', result=NULL, updated_at=excluded.updated_at WHERE state='failed'").run(key, Date.now())
    if (Number(claim.changes) !== 1) throw new Error('Send is already claimed or requires reconciliation')
    try {
      const result = await send()
      this.db.prepare("UPDATE outbound_claims SET state='sent', result=?, updated_at=? WHERE key=?").run(result, Date.now(), key)
      return result
    } catch (error) {
      const state = error instanceof DefiniteSendFailure ? 'failed' : 'unknown'
      this.db.prepare('UPDATE outbound_claims SET state=?, updated_at=? WHERE key=?').run(state, Date.now(), key)
      throw error
    }
  }
  close(): void { this.db.close() }
}
