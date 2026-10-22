/**
 * Where a chat runs, for the chip beside it. A project chat another brain was asked to run has a claim row in the
 * `job` table (`chat-<id>`, main/runtime/offload.ts placeChat); the chip names that brain, so a chat working on the
 * server is never invisible. Pure, so it is unit tested directly.
 */
import type { DeviceRow, JobRow } from '@agent/core'

/** Chat id to the name of the device running it, for every chat placed on another device. */
export function chatPlaces(jobs: JobRow[], devices: DeviceRow[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const job of jobs) {
    if (job.kind !== 'claim' || job.op !== 'chat' || job.status === 'off' || !job.id.startsWith('chat-') || job.device === '') continue
    const name = devices.find((device) => device.id === job.device)?.name ?? ''
    if (name !== '') out.set(job.id.slice('chat-'.length), name)
  }
  return out
}
