import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createKairos } from './kairos.js'
import { defineCommand } from './command.js'
import { defineEvent } from './event.js'
import { BusinessRuleError, DCBConflictError, ValidationError } from './errors.js'
import { createMemoryEventStore } from '../testing/memory-store.js'

const CourseCreated = defineEvent('CourseCreated', z.object({ capacity: z.number().int().positive() }))
const StudentSubscribed = defineEvent('StudentSubscribed', z.object({}))

const subscribeStudent = defineCommand({
  name: 'SubscribeStudent',
  input: z.object({ courseId: z.string(), studentId: z.string() }),
  handler: async ({ courseId, studentId }, ctx) => {
    const { events, appendCondition } = await ctx.read({
      tags: [{ courseId }],
      eventTypes: ['CourseCreated', 'StudentSubscribed'],
    })
    let capacity = 0
    let enrolled = 0
    for (const e of events) {
      if (e.type === 'CourseCreated') capacity = (e.data as { capacity: number }).capacity
      if (e.type === 'StudentSubscribed' && e.tags.courseId === courseId) enrolled++
    }
    if (enrolled >= capacity) throw new BusinessRuleError('Course is full')
    await ctx.append(
      [{ type: 'StudentSubscribed', tags: { courseId, studentId }, data: {} }],
      appendCondition,
    )
  },
})

function makeKairos() {
  return createKairos({
    store: createMemoryEventStore(),
    events: [CourseCreated, StudentSubscribed],
  })
}

describe('Kairos.execute', () => {
  it('throws ValidationError when input fails schema validation', async () => {
    const k = makeKairos()
    await expect(
      // @ts-expect-error intentionally wrong shape
      k.execute(subscribeStudent, { courseId: 42, studentId: 's1' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('runs the handler and returns the position of the last appended event', async () => {
    const k = makeKairos()
    // seed via raw store
    const store = (k as unknown as { config: { store: ReturnType<typeof createMemoryEventStore> } }).config.store
    await store.append([{ type: 'CourseCreated', tags: { courseId: 'c1' }, data: { capacity: 2 } }])

    const { position } = await k.execute(subscribeStudent, { courseId: 'c1', studentId: 's1' })
    expect(position).toBe(2n)
  })

  it('propagates BusinessRuleError from handlers', async () => {
    const k = makeKairos()
    const store = (k as unknown as { config: { store: ReturnType<typeof createMemoryEventStore> } }).config.store
    await store.append([
      { type: 'CourseCreated',     tags: { courseId: 'c1' }, data: { capacity: 1 } },
      { type: 'StudentSubscribed', tags: { courseId: 'c1', studentId: 's1' }, data: {} },
    ])

    await expect(
      k.execute(subscribeStudent, { courseId: 'c1', studentId: 's2' }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('propagates DCBConflictError when an append condition is violated', async () => {
    const k = makeKairos()
    const store = (k as unknown as { config: { store: ReturnType<typeof createMemoryEventStore> } }).config.store
    await store.append([{ type: 'CourseCreated', tags: { courseId: 'c1' }, data: { capacity: 10 } }])

    // command that reads, then we inject a matching event, then command tries to append
    const slowCommand = defineCommand({
      name: 'SlowSubscribe',
      input: z.object({ courseId: z.string() }),
      handler: async ({ courseId }, ctx) => {
        const { appendCondition } = await ctx.read({
          tags: [{ courseId }],
          eventTypes: ['StudentSubscribed'],
        })
        // inject a conflicting event using the raw store
        await store.append([
          { type: 'StudentSubscribed', tags: { courseId, studentId: 'injected' }, data: {} },
        ])
        await ctx.append(
          [{ type: 'StudentSubscribed', tags: { courseId, studentId: 'me' }, data: {} }],
          appendCondition,
        )
      },
    })

    await expect(
      k.execute(slowCommand, { courseId: 'c1' }),
    ).rejects.toBeInstanceOf(DCBConflictError)
  })

  it('short-circuits on repeat invocation with same idempotency key', async () => {
    const k = makeKairos()
    const store = (k as unknown as { config: { store: ReturnType<typeof createMemoryEventStore> } }).config.store
    await store.append([{ type: 'CourseCreated', tags: { courseId: 'c1' }, data: { capacity: 2 } }])

    const first = await k.execute(
      subscribeStudent,
      { courseId: 'c1', studentId: 's1' },
      { idempotencyKey: 'req-1' },
    )
    const second = await k.execute(
      subscribeStudent,
      { courseId: 'c1', studentId: 's1' },
      { idempotencyKey: 'req-1' },
    )
    expect(second.position).toBe(first.position)

    // only one StudentSubscribed should exist
    const events = await store.readFrom(0n, 100)
    const subs = events.filter(e => e.type === 'StudentSubscribed')
    expect(subs).toHaveLength(1)
  })
})
