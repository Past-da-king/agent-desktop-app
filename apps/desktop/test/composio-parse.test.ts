/** Composio Connect replies that strict JSON would refuse still read correctly. */
import { describe, expect, it } from 'vitest'

import { parse } from '../src/main/apps/composio'

describe('Composio reply parsing', () => {
  it('reads the JSON answer when a plain note follows it', () => {
    const text = '{"successful":true,"data":{"toolkit_connection_statuses":[{"toolkit":"fathom"}]}}\nNo exact fit? Any HTTP or SSE endpoint can be connected.'
    expect(parse(text)).toEqual({ successful: true, data: { toolkit_connection_statuses: [{ toolkit: 'fathom' }] } })
  })

  it('reads strings with raw line breaks inside', () => {
    expect(parse('{"a":"line one\nline two\tend"}')).toEqual({ a: 'line one\nline two\tend' })
  })

  it('still returns null for text that is not JSON at all', () => {
    expect(parse('Error: nope')).toBeNull()
  })
})
