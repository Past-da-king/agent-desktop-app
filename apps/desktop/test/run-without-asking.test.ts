/** "Run without asking": commands, code and files anywhere go through with no approval card. */
import { describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, type Settings } from '@agent/core'

import { sdkPermission } from '../src/main/runtime/sdk-permissions'

function gate(shell: Settings['shell']) {
  const asked: string[] = []
  const check = sdkPermission({
    settings: () => ({ ...DEFAULT_SETTINGS, shell, grantedFolders: ['C:\\Users\\sam\\Work'] }),
    approve: async (summary) => {
      asked.push(summary)
      return false
    },
    platform: 'win32',
  })
  return { check, asked }
}

describe('commands and files setting', () => {
  it('Run without asking lets commands, reads and changes through with no card', async () => {
    const { check, asked } = gate('always')
    expect(await check('PowerShell', { command: 'Get-ChildItem C:\\' })).toEqual({ allow: true })
    expect(await check('Read', { file_path: 'C:\\Windows\\win.ini' })).toEqual({ allow: true })
    expect(await check('Write', { file_path: 'C:\\Users\\sam\\Desktop\\a.txt' })).toEqual({ allow: true })
    expect(asked).toEqual([])
  })

  it('Ask first still asks for every command and files outside the folders', async () => {
    const { check, asked } = gate('ask')
    expect((await check('Bash', { command: 'echo hi' })).allow).toBe(false)
    expect((await check('Read', { file_path: 'C:\\Windows\\win.ini' })).allow).toBe(false)
    expect(asked).toHaveLength(2)
  })

  it('Never refuses commands without asking', async () => {
    const { check, asked } = gate('never')
    expect((await check('Bash', { command: 'echo hi' })).allow).toBe(false)
    expect(asked).toEqual([])
  })

  it('unknown tools stay refused even with Run without asking', async () => {
    const { check } = gate('always')
    expect((await check('Task', {})).allow).toBe(false)
  })
})
