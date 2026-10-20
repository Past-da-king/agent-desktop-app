import { describe, expect, it } from 'vitest'

import {
  NEEDS_OPT_IN,
  blockReason,
  check,
  isHttp,
  isLoopback,
} from '../src/http-policy'
import { ProviderException } from '../src/model'

describe('isHttp', () => {
  it('recognises plain http regardless of case or surrounding spaces', () => {
    expect(isHttp('http://example.test')).toBe(true)
    expect(isHttp('  HTTP://example.test  ')).toBe(true)
  })

  it('does not mistake https or another scheme for http', () => {
    expect(isHttp('https://example.test')).toBe(false)
    expect(isHttp('ftp://example.test')).toBe(false)
    expect(isHttp('not a url')).toBe(false)
  })
})

describe('isLoopback', () => {
  it.each([
    'http://localhost:8080',
    'http://127.0.0.1',
    'http://127.24.0.9/path',
    'http://[::1]:3000',
    ' https://LOCALHOST ',
  ])('accepts %s as this computer', (url) => {
    expect(isLoopback(url)).toBe(true)
  })

  it.each([
    'http://example.test',
    'http://192.168.1.10',
    'http://1270.0.0.1',
    'not a url',
  ])('rejects %s', (url) => {
    expect(isLoopback(url)).toBe(false)
  })
})

describe('blockReason', () => {
  it('allows https anywhere', () => {
    expect(blockReason('https://example.test/v1', false)).toBeNull()
  })

  it('allows plain http to this computer without an opt-in', () => {
    expect(blockReason('http://127.0.0.1:1234/v1', false)).toBeNull()
  })

  it('blocks plain http elsewhere until the person opts in', () => {
    expect(blockReason('http://example.test/v1', false)).toBe(NEEDS_OPT_IN)
    expect(blockReason('http://example.test/v1', true)).toBeNull()
  })

  it('explains a missing scheme', () => {
    expect(blockReason('example.test/v1', false)).toContain('https://')
    expect(blockReason('', false)).toContain('https://')
  })
})

describe('check', () => {
  it('throws a provider error the settings screen can show', () => {
    expect(() => check('http://example.test', false)).toThrow(ProviderException)
    expect(() => check('http://example.test', false)).toThrow(NEEDS_OPT_IN)
  })

  it('stays quiet for an allowed address', () => {
    expect(() => check('https://example.test', false)).not.toThrow()
    expect(() => check('http://localhost:8080', false)).not.toThrow()
  })
})
