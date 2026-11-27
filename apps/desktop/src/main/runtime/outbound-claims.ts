import { DatabaseSync } from 'node:sqlite'

export type Claim = { state: 'granted'; owner: string } | { state: 'sent'; result: string } | { state: 'in_progress' } | { state: 'unknown' }
export type Finish = { state: 'sent'; result: string } | { state: 'failed' } | { state: 'unknown' }

/** All callers must address one authority; SQLite's unique key arbitrates across its processes. */
export class OutboundClaims {
  private readonly db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec("CREATE TABLE IF NOT EXISTS send_claims (key TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL, result TEXT, updated_at INTEGER NOT NULL)")
  }
  claim(key: string, owner: string): Claim {
    const now = Date.now()
    const change = this.db.prepare("INSERT INTO send_claims (key,owner,state,updated_at) VALUES (?,?,'claimed',?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,state='claimed',result=NULL,updated_at=excluded.updated_at WHERE send_claims.state='failed'").run(key, owner, now)
    if (Number(change.changes) === 1) return { state: 'granted', owner }
    const row = this.db.prepare('SELECT state,result FROM send_claims WHERE key=?').get(key)
    if (row?.['state'] === 'sent') return { state: 'sent', result: String(row['result']) }
    if (row?.['state'] === 'claimed') return { state: 'in_progress' }
    return { state: 'unknown' }
  }
  finish(key: string, owner: string, outcome: Finish): boolean {
    const changed = this.db.prepare("UPDATE send_claims SET state=?,result=?,updated_at=? WHERE key=? AND owner=? AND state='claimed'").run(outcome.state, outcome.state === 'sent' ? outcome.result : null, Date.now(), key, owner)
    return Number(changed.changes) === 1
  }
  close(): void { this.db.close() }
}
