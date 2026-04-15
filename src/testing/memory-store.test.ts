import { describe, expect, it } from 'vitest'
import { createMemoryEventStore } from './index.js'
import { DCBConflictError } from '../core/errors.js'

describe('MemoryEventStore', () => {
  it('returns no events from an empty store', async () => {
    const store = createMemoryEventStore()
    const events = await store.readFrom(0n, 100)
    expect(events).toEqual([])
  })

  it('appends an event and reads it back', async () => {
    const store = createMemoryEventStore()
    const { position } = await store.append([
      { type: 'Seeded', tags: { aggregate: 'x' }, data: { n: 1 } },
    ])
    expect(position).toBe(1n)

    const events = await store.readFrom(0n, 100)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('Seeded')
    expect(events[0]?.data).toEqual({ n: 1 })
    expect(events[0]?.tags).toEqual({ aggregate: 'x' })
    expect(events[0]?.position).toBe(1n)
    expect(events[0]?.id).toBeTypeOf('string')
    expect(events[0]?.recordedAt).toBeInstanceOf(Date)
  })

  it('assigns monotonic positions across appends', async () => {
    const store = createMemoryEventStore()
    const a = await store.append([{ type: 'A', tags: {}, data: {} }])
    const b = await store.append([{ type: 'B', tags: {}, data: {} }])
    const c = await store.append([
      { type: 'C1', tags: {}, data: {} },
      { type: 'C2', tags: {}, data: {} },
    ])
    expect(a.position).toBe(1n)
    expect(b.position).toBe(2n)
    expect(c.position).toBe(4n)

    const all = await store.readFrom(0n, 100)
    expect(all.map(e => e.type)).toEqual(['A', 'B', 'C1', 'C2'])
    expect(all.map(e => e.position)).toEqual([1n, 2n, 3n, 4n])
  })

  describe('read() with DCB queries', () => {
    it('filters by eventTypes', async () => {
      const store = createMemoryEventStore()
      await store.append([
        { type: 'A', tags: {}, data: {} },
        { type: 'B', tags: {}, data: {} },
        { type: 'A', tags: {}, data: {} },
      ])
      const { events } = await store.read({ eventTypes: ['A'] })
      expect(events.map(e => e.type)).toEqual(['A', 'A'])
    })

    it('filters by tags (AND within object)', async () => {
      const store = createMemoryEventStore()
      await store.append([
        { type: 'X', tags: { courseId: 'c1', studentId: 's1' }, data: {} },
        { type: 'X', tags: { courseId: 'c1', studentId: 's2' }, data: {} },
        { type: 'X', tags: { courseId: 'c2', studentId: 's1' }, data: {} },
      ])
      const { events } = await store.read({
        tags: [{ courseId: 'c1', studentId: 's1' }],
      })
      expect(events).toHaveLength(1)
      expect(events[0]?.tags).toEqual({ courseId: 'c1', studentId: 's1' })
    })

    it('filters by tags (OR across array)', async () => {
      const store = createMemoryEventStore()
      await store.append([
        { type: 'X', tags: { courseId: 'c1' }, data: {} },
        { type: 'X', tags: { courseId: 'c2' }, data: {} },
        { type: 'X', tags: { studentId: 's1' }, data: {} },
        { type: 'X', tags: { other: 'z' }, data: {} },
      ])
      const { events } = await store.read({
        tags: [{ courseId: 'c1' }, { studentId: 's1' }],
      })
      expect(events).toHaveLength(2)
    })

    it('combines tags and eventTypes with AND', async () => {
      const store = createMemoryEventStore()
      await store.append([
        { type: 'A', tags: { courseId: 'c1' }, data: {} },
        { type: 'B', tags: { courseId: 'c1' }, data: {} },
        { type: 'A', tags: { courseId: 'c2' }, data: {} },
      ])
      const { events } = await store.read({
        tags: [{ courseId: 'c1' }],
        eventTypes: ['A'],
      })
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('A')
      expect(events[0]?.tags).toEqual({ courseId: 'c1' })
    })

    it('returns all events when query is empty', async () => {
      const store = createMemoryEventStore()
      await store.append([
        { type: 'A', tags: {}, data: {} },
        { type: 'B', tags: {}, data: {} },
      ])
      const { events } = await store.read({})
      expect(events).toHaveLength(2)
    })

    it('returns an appendCondition carrying the query and maxReadPosition', async () => {
      const store = createMemoryEventStore()
      await store.append([{ type: 'A', tags: {}, data: {} }])
      await store.append([{ type: 'A', tags: {}, data: {} }])
      const { appendCondition } = await store.read({ eventTypes: ['A'] })
      expect(appendCondition.maxReadPosition).toBe(2n)
      expect(appendCondition.query).toEqual({ eventTypes: ['A'] })
    })
  })

  describe('DCB-guarded append', () => {
    it('succeeds when no conflicting events appeared since read', async () => {
      const store = createMemoryEventStore()
      await store.append([{ type: 'Seeded', tags: { courseId: 'c1' }, data: {} }])

      const { appendCondition } = await store.read({
        tags: [{ courseId: 'c1' }],
        eventTypes: ['Seeded', 'StudentSubscribed'],
      })

      const { position } = await store.append(
        [{ type: 'StudentSubscribed', tags: { courseId: 'c1', studentId: 's1' }, data: {} }],
        appendCondition,
      )
      expect(position).toBe(2n)
    })

    it('throws DCBConflictError when a matching event appeared since read', async () => {
      const store = createMemoryEventStore()
      await store.append([{ type: 'Seeded', tags: { courseId: 'c1' }, data: {} }])

      const { appendCondition } = await store.read({
        tags: [{ courseId: 'c1' }],
        eventTypes: ['Seeded', 'StudentSubscribed'],
      })

      // concurrent write matching the query
      await store.append([
        { type: 'StudentSubscribed', tags: { courseId: 'c1', studentId: 'other' }, data: {} },
      ])

      await expect(
        store.append(
          [{ type: 'StudentSubscribed', tags: { courseId: 'c1', studentId: 's1' }, data: {} }],
          appendCondition,
        ),
      ).rejects.toBeInstanceOf(DCBConflictError)
    })

    it('allows appends when the intervening event does not match the query', async () => {
      const store = createMemoryEventStore()
      await store.append([{ type: 'Seeded', tags: { courseId: 'c1' }, data: {} }])

      const { appendCondition } = await store.read({
        tags: [{ courseId: 'c1' }],
        eventTypes: ['StudentSubscribed'],
      })

      // intervening event is in a DIFFERENT course — shouldn't conflict
      await store.append([
        { type: 'StudentSubscribed', tags: { courseId: 'c2', studentId: 'x' }, data: {} },
      ])

      const { position } = await store.append(
        [{ type: 'StudentSubscribed', tags: { courseId: 'c1', studentId: 's1' }, data: {} }],
        appendCondition,
      )
      expect(position).toBe(3n)
    })
  })
})
