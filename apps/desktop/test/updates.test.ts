import { describe, expect, it } from 'vitest'

import { startUpdates, updateUrl } from '../src/main/updates'

describe('update URL', () => {
  it('is disabled when the environment does not name a server', () => {
    expect(updateUrl({})).toBeNull()
    expect(startUpdates({})).toEqual({ status: 'disabled', url: null })
  })

  it('accepts an https update server', () => {
    expect(updateUrl({ AGENT_UPDATE_URL: 'https://updates.example.test/agent' })).toBe(
      'https://updates.example.test/agent',
    )
  })

  it('accepts a loopback http server for local testing', () => {
    expect(updateUrl({ AGENT_UPDATE_URL: 'http://127.0.0.1:9000/updates' })).toBe(
      'http://127.0.0.1:9000/updates',
    )
  })

  it('ignores blank space and unknown schemes', () => {
    expect(updateUrl({ AGENT_UPDATE_URL: '   ' })).toBeNull()
    expect(updateUrl({ AGENT_UPDATE_URL: 'ftp://example.test/agent' })).toBeNull()
    expect(updateUrl({ AGENT_UPDATE_URL: 'not a url' })).toBeNull()
  })

  it('reports an idle updater only when a server was provided', () => {
    expect(startUpdates({ AGENT_UPDATE_URL: 'https://updates.example.test' })).toEqual({
      status: 'idle',
      url: 'https://updates.example.test/',
    })
  })
})

describe('update URL table', () => {
  it.each([
    ['', null],
    ['   ', null],
    ['https://updates.example.test', 'https://updates.example.test/'],
    ['https://updates.example.test/channel/latest', 'https://updates.example.test/channel/latest'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080/'],
    ['http://localhost:9000/feed', 'http://localhost:9000/feed'],
    ['file:///tmp/updates', null],
    ['javascript:alert(1)', null],
    ['ftp://updates.example.test', null],
    ['//updates.example.test', null],
  ])('turns %j into %j', (value, expected) => {
    expect(updateUrl({ AGENT_UPDATE_URL: value })).toBe(expected)
  })
})
