/**
 * The app installs an update of itself (main/self-update.ts): checks the installer, waits for the turn that asked to
 * end, starts a detached launcher that runs the installer silently and reopens the app, quits; on the next start the
 * agent hears in the same chat that the update finished.
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SelfUpdater, compareVersions, launcherScript, resumeNote, versionOfInstaller, type SelfUpdateDeps } from '../src/main/self-update'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup(patch: Partial<SelfUpdateDeps> = {}): { updater: SelfUpdater; dir: string; launched: Array<{ command: string; args: string[] }>; quits: number[]; busy: { on: boolean } } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-upd-'))
  dirs.push(dir)
  const launched: Array<{ command: string; args: string[] }> = []
  const quits: number[] = []
  const busy = { on: true }
  const updater = new SelfUpdater({
    userData: dir,
    currentVersion: '0.2.52',
    productName: 'Agent',
    execPath: join(dir, 'app', 'Agent.exe'),
    platform: 'win32',
    packaged: true,
    busy: () => busy.on,
    launch: (command, args) => void launched.push({ command, args }),
    quit: () => void quits.push(Date.now()),
    pollMs: 5,
    ...patch,
  })
  return { updater, dir, launched, quits, busy }
}

function installer(dir: string, name: string): string {
  const path = join(dir, name)
  writeFileSync(path, 'MZ')
  return path
}

describe('self update', () => {
  it('reads the version from the installer name and compares versions', () => {
    expect(versionOfInstaller('C:\\x\\Agent-0.2.53-setup.exe', 'Agent')).toBe('0.2.53')
    expect(versionOfInstaller('/x/Agent-1.0.0-beta.2-setup.exe', 'Agent')).toBe('1.0.0-beta.2')
    expect(versionOfInstaller('/x/Other-0.2.53-setup.exe', 'Agent')).toBeNull()
    expect(compareVersions('0.2.53', '0.2.52')).toBe(1)
    expect(compareVersions('0.2.9', '0.2.10')).toBe(-1)
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(-1)
    expect(compareVersions('0.2.52', '0.2.52')).toBe(0)
  })

  it('the launcher waits for the app, runs the installer silently into its folder and reopens it (/D= last)', () => {
    const script = launcherScript(4242, "C:\\Down's\\Agent-0.2.53-setup.exe", 'C:\\Apps\\Agent')
    expect(script).toContain('Wait-Process -Id 4242')
    expect(script).toContain("'C:\\Down''s\\Agent-0.2.53-setup.exe'")
    expect(script).toMatch(/'\/S --updated --force-run \/D=C:\\Apps\\Agent'/)
  })

  it('refuses what it cannot install, without touching anything', async () => {
    const { updater, dir, launched } = setup()
    expect((await updater.install(join(dir, 'missing.exe'), 'main')).text).toMatch(/no file/)
    expect((await updater.install(installer(dir, 'Thing-1.0.0-setup.exe'), 'main')).text).toMatch(/not an installer of this app/)
    expect((await updater.install(installer(dir, 'Agent-0.2.40-setup.exe'), 'main')).text).toMatch(/older/)
    expect((await setup({ packaged: false }).updater.install(installer(dir, 'Agent-0.2.53-setup.exe'), 'main')).text).toMatch(/development run/)
    expect((await setup({ platform: 'linux' }).updater.install(installer(dir, 'Agent-0.2.53-setup.exe'), 'main')).text).toMatch(/Windows only/)
    expect(launched).toEqual([])
    expect(existsSync(join(dir, 'update-pending.json'))).toBe(false)
  })

  it('waits for the turn to end, then launches the installer and quits; the next start tells the same chat', async () => {
    const { updater, dir, launched, quits, busy } = setup()
    const path = installer(dir, 'Agent-0.2.53-setup.exe')
    const result = await updater.install(path, 'chat_42')
    expect(result.ok).toBe(true)
    expect(result.text).toContain('0.2.52 -> 0.2.53')
    expect((await updater.install(path, 'chat_42')).text).toMatch(/already waiting/)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(launched).toEqual([])
    busy.on = false
    for (let i = 0; i < 100 && quits.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(quits.length).toBe(1)
    expect(launched[0]?.command).toBe('powershell.exe')
    expect(launched[0]?.args.join(' ')).toContain('/S --updated --force-run')

    const after = setup({ userData: dir, currentVersion: '0.2.53' }).updater.resume()
    expect(after).toMatchObject({ from: '0.2.52', to: '0.2.53', now: '0.2.53', chat: 'chat_42', ok: true })
    expect(resumeNote(after!)).toContain('App update finished: 0.2.52 -> 0.2.53')
    // Read once.
    expect(setup({ userData: dir }).updater.resume()).toBeNull()
  })

  it('says so when the update did not take', () => {
    const { dir } = setup()
    writeFileSync(join(dir, 'update-pending.json'), JSON.stringify({ from: '0.2.52', to: '0.2.53', chat: '', installer: 'Agent-0.2.53-setup.exe', at: 1 }))
    const after = setup({ userData: dir, currentVersion: '0.2.52' }).updater.resume()
    expect(after).toMatchObject({ ok: false, chat: 'main' })
    expect(resumeNote(after!)).toMatch(/did not take/)
  })
})
