import { describe, expect, it } from 'vitest'
import { createKairos } from './kairos.js'
import { defineProjection } from './projection.js'
import { createMemoryEventStore } from '../testing/memory-store.js'

describe('Kairos projection runner', () => {
  it('dispatches events to subscribed projection handlers in order', async () => {
    const store = createMemoryEventStore()
    const seen: string[] = []
    const proj = defineProjection({
      name: 'seen',
      on: {
        A: async (event) => { seen.push(`A:${(event.data as { n: number }).n}`) },
        B: async (event) => { seen.push(`B:${(event.data as { n: number }).n}`) },
      },
    })

    const k = createKairos({ store, events: [], projections: [proj], pollIntervalMs: 5 })
    await store.append([
      { type: 'A', tags: {}, data: { n: 1 } },
      { type: 'C', tags: {}, data: { n: 2 } }, // not subscribed, skipped
      { type: 'B', tags: {}, data: { n: 3 } },
      { type: 'A', tags: {}, data: { n: 4 } },
    ])

    await k.start()
    await k.waitForProjection('seen', 4n, 1000)
    await k.stop()

    expect(seen).toEqual(['A:1', 'B:3', 'A:4'])
  })

  it('advances the cursor so restart does not reprocess events', async () => {
    const store = createMemoryEventStore()
    let count = 0
    const proj = defineProjection({
      name: 'counter',
      on: { A: async () => { count++ } },
    })

    const k = createKairos({ store, events: [], projections: [proj], pollIntervalMs: 5 })
    await store.append([{ type: 'A', tags: {}, data: {} }])
    await k.start()
    await k.waitForProjection('counter', 1n, 1000)
    await k.stop()

    expect(count).toBe(1)

    // restart — no new events; count should not grow
    await k.start()
    await new Promise(r => setTimeout(r, 50))
    await k.stop()
    expect(count).toBe(1)
  })

  it('waitForProjection resolves immediately once the cursor has passed the position', async () => {
    const store = createMemoryEventStore()
    const proj = defineProjection({
      name: 'p',
      on: { A: async () => {} },
    })
    const k = createKairos({ store, events: [], projections: [proj], pollIntervalMs: 5 })
    await store.append([{ type: 'A', tags: {}, data: {} }])
    await k.start()
    await k.waitForProjection('p', 1n, 1000)
    // Calling again should return fast
    const start = Date.now()
    await k.waitForProjection('p', 1n, 1000)
    expect(Date.now() - start).toBeLessThan(50)
    await k.stop()
  })

  it('waitForProjection rejects on timeout', async () => {
    const store = createMemoryEventStore()
    const proj = defineProjection({
      name: 'p',
      on: { A: async () => {} },
    })
    const k = createKairos({ store, events: [], projections: [proj], pollIntervalMs: 10 })
    await k.start()

    await expect(k.waitForProjection('p', 99n, 50)).rejects.toThrow(/timeout/i)
    await k.stop()
  })

  it('parks a projection when its handler throws', async () => {
    const store = createMemoryEventStore()
    const proj = defineProjection({
      name: 'broken',
      on: { A: async () => { throw new Error('boom') } },
    })
    const k = createKairos({ store, events: [], projections: [proj], pollIntervalMs: 5 })
    await store.append([{ type: 'A', tags: {}, data: {} }])
    await k.start()
    // wait for the runner to hit the error
    await new Promise(r => setTimeout(r, 50))
    const health = k.health()
    expect(health.projections.broken?.parked).toBe(true)
    expect(health.projections.broken?.lastError).toContain('boom')
    await k.stop()
  })

  it('rebuilds a projection by resetting its cursor and reprocessing events', async () => {
    const store = createMemoryEventStore()
    const seen: number[] = []
    const proj = defineProjection({
      name: 'rebuildable',
      on: { A: async (e) => { seen.push((e.data as { n: number }).n) } },
    })
    const k = createKairos({ store, events: [], projections: [proj], pollIntervalMs: 5 })
    await store.append([
      { type: 'A', tags: {}, data: { n: 1 } },
      { type: 'A', tags: {}, data: { n: 2 } },
    ])
    await k.start()
    await k.waitForProjection('rebuildable', 2n, 1000)

    expect(seen).toEqual([1, 2])

    await k.rebuild('rebuildable')
    await k.waitForProjection('rebuildable', 2n, 1000)
    await k.stop()

    expect(seen).toEqual([1, 2, 1, 2])
  })
})
