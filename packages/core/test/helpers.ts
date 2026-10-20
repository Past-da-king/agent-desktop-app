/**
 * Test helpers: starts the real fake sync service from scripts/fake-sync-server.mjs (a local HTTP
 * server, not a mocked fetch) and provides small waiting utilities.
 */
export interface FakeSyncServer {
  url: string
  stats: { requests: number; pushes: number; pulls: number }
  close(): Promise<void>
}

interface FakeSyncModule {
  startFakeSyncServer(options?: { port?: number }): Promise<FakeSyncServer>
}

export async function startFakeSyncServer(options: { port?: number } = {}): Promise<FakeSyncServer> {
  const href = new URL('../../../scripts/fake-sync-server.mjs', import.meta.url).href
  const module = (await import(href)) as FakeSyncModule
  return module.startFakeSyncServer(options)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Poll until check() returns a truthy value, or throw after [timeoutMs]. */
export async function waitFor<T>(
  check: () => T | Promise<T>,
  timeoutMs = 2_000,
  stepMs = 25,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value as NonNullable<T>
    if (Date.now() >= deadline) throw new Error(`waitFor timed out after ${timeoutMs} ms`)
    await sleep(stepMs)
  }
}

export function portOf(url: string): number {
  return Number(new URL(url).port)
}
