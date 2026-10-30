/**
 * A copy of the app that is not the installed one (a test build, an unpacked folder) must never open the person's
 * own data, and never register itself with Windows (30 Oct 2026).
 *
 * What happened: the Start menu's Agent shortcut had come to point at a test copy in C:\temp. After a hang the
 * person started the app from the Start menu, the test copy opened with no data folder of its own, so it took his
 * real one (and its single-instance lock), and when that test folder was cleaned up his live app lost its files.
 *
 * Now, on Windows, a packaged copy with no uninstaller beside it (the installer always writes one) and no data
 * folder of its own (AGENT_USER_DATA or --user-data-dir) does not start: it hands over to the installed app when
 * there is one, or says why. AGENT_ALLOW_DEFAULT_DATA=1 lets it through on purpose. Such a copy also never sets
 * "launch at login", which would point Windows at it.
 */
import { dirname, join } from 'node:path'

export interface CopyFacts {
  platform: string
  packaged: boolean
  /** This copy's .exe. */
  exe: string
  productName: string
  /** AGENT_USER_DATA, '' when unset. */
  userDataOverride: string
  /** --user-data-dir was given. */
  userDataSwitch: boolean
  /** AGENT_ALLOW_DEFAULT_DATA=1. */
  allowDefault: boolean
  /** Where the installer puts the app for this user. */
  installedExe: string
  exists: (path: string) => boolean
}

export function uninstallerOf(exe: string, productName: string): string {
  return join(dirname(exe), `Uninstall ${productName}.exe`)
}

/** Is this the installed app (or not Windows, or development)? */
export function isInstalledCopy(facts: Pick<CopyFacts, 'platform' | 'packaged' | 'exe' | 'productName' | 'exists'>): boolean {
  if (facts.platform !== 'win32' || !facts.packaged) return true
  return facts.exists(uninstallerOf(facts.exe, facts.productName))
}

export interface CopyVerdict {
  /** Start normally. */
  ok: boolean
  /** The installed app to hand over to, or '' when there is none. */
  handTo: string
  why: string
}

export function copyVerdict(facts: CopyFacts): CopyVerdict {
  const fine: CopyVerdict = { ok: true, handTo: '', why: '' }
  if (isInstalledCopy(facts)) return fine
  if (facts.userDataOverride.trim() !== '' || facts.userDataSwitch || facts.allowDefault) return fine
  const same = facts.installedExe.toLowerCase() === facts.exe.toLowerCase()
  const handTo = !same && facts.installedExe !== '' && facts.exists(facts.installedExe) ? facts.installedExe : ''
  return {
    ok: false,
    handTo,
    why: `This copy of ${facts.productName} (${dirname(facts.exe)}) is not the installed app and has no data folder of its own, so it will not open your data.`,
  }
}

/** The installer's default place for this user: %LOCALAPPDATA%\Programs\<productName>\<productName>.exe. */
export function defaultInstalledExe(env: Record<string, string | undefined>, productName: string): string {
  const local = env['LOCALAPPDATA'] ?? ''
  return local === '' ? '' : join(local, 'Programs', productName, `${productName}.exe`)
}
