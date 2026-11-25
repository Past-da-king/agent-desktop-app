import { expect, it } from 'vitest'
import { DiskHealth } from '../src/main/disk-health'
it('warns once before exhaustion, stops new answers with hysteresis, and recovers after space is freed', () => {
 const guard = new DiskHealth()
 expect(guard.sample(21, 1000).changed).toBe(false)
 expect(guard.sample(12, 1000)).toMatchObject({ changed: true, blocked: false })
 expect(guard.sample(11, 1000).changed).toBe(false)
 expect(guard.sample(4, 1000)).toMatchObject({ changed: true, blocked: true })
 expect(guard.line()).toContain('not answering')
 expect(guard.sample(5.1, 1000).blocked).toBe(true)
 expect(guard.sample(21, 1000)).toMatchObject({ changed: true, blocked: false })
 expect(guard.line()).toBe('')
 expect(guard.sample(-1, 0).blocked).toBe(false)
})
