import { describe, expect, it, vi } from 'vitest'

import { sdkPermission } from '../src/main/runtime/sdk-permissions'
import { codeTools } from '../src/main/tools/code'
import { shellTools } from '../src/main/tools/shell'
import { settingsView, testContext, toolNamed } from './support'

const BAD = '[System.Windows.Forms.SendKeys]::SendWait("hello")'

describe('real input is refused everywhere a command can run', () => {
  it('shell_run refuses without asking and points to screen_act', async () => {
    const approve = vi.fn(async () => true)
    const tool = toolNamed(shellTools({ settings: settingsView({ shell: 'always' }), platform: 'linux' }), 'shell_run')
    const out = await tool.run({ command: 'powershell -c ' + JSON.stringify(BAD) }, testContext({ approve }))
    expect(out).toContain('screen_act')
    expect(approve).not.toHaveBeenCalled()
  })

  it('run_code refuses it too', async () => {
    const tool = toolNamed(codeTools({ settings: settingsView({ shell: 'always' }), platform: 'linux' }), 'run_code')
    const out = await tool.run({ language: 'python', code: 'import pyautogui\npyautogui.click(1, 1)' }, testContext())
    expect(out).toContain('screen_act')
  })

  it('the plan engine hook refuses it, even on Run without asking', async () => {
    const allow = sdkPermission({ settings: () => ({ shell: 'always', grantedFolders: [] }) as never, approve: async () => true })
    for (const name of ['Bash', 'PowerShell']) {
      const out = await allow(name, { command: 'powershell -c "SetCursorPos(1,1)"' })
      expect(out).toMatchObject({ allow: false })
    }
    expect(await allow('Bash', { command: 'git status' })).toEqual({ allow: true })
  })
})
