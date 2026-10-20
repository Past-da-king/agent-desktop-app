import type { SystemInfo } from '@agent/core'

/** Plain-language name for `process.platform`, including the browser mock. */
export function platformLabel(platform: string): string {
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return 'macOS'
  if (platform === 'linux') return 'Linux'
  if (platform === 'web') return 'Browser preview'
  return platform
}

/** "Windows arm64, DESKTOP-7" for the machine line. */
export function machineSummary(info: SystemInfo): string {
  const host = info.hostname.trim()
  const os = `${platformLabel(info.platform)} ${info.arch}`.trim()
  return host === '' ? os : `${os}, ${host}`
}

/** The one-line result shown after the user asks for a fresh scan of this computer. */
export function scanSummary(report: { shells: Array<{ found: boolean }>; runtimes: Array<{ found: boolean }>; aiTools: Array<{ found: boolean }> }): string {
  const all = [...report.shells, ...report.runtimes, ...report.aiTools]
  const found = all.filter((item) => item.found).length
  return `Scan done. Found ${found} of ${all.length} tools.`
}
