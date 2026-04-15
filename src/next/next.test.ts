import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { toRouteHandler, toServerAction } from './index.js'
import { defineCommand } from '../core/command.js'
import { defineEvent } from '../core/event.js'
import { defineProjection } from '../core/projection.js'
import { BusinessRuleError } from '../core/errors.js'
import { createKairos } from '../core/kairos.js'
import { createMemoryEventStore } from '../testing/memory-store.js'

const CourseCreated     = defineEvent('CourseCreated', z.object({ capacity: z.number() }))
const StudentSubscribed = defineEvent('StudentSubscribed', z.object({}))

const subscribe = defineCommand({
  name: 'SubscribeStudent',
  input: z.object({ courseId: z.string(), studentId: z.string() }),
  handler: async ({ courseId, studentId }, ctx) => {
    const { events, appendCondition } = await ctx.read({ tags: [{ courseId }], eventTypes: ['CourseCreated', 'StudentSubscribed'] })
    let capacity = 0, enrolled = 0
    for (const e of events) {
      if (e.type === 'CourseCreated') capacity = (e.data as { capacity: number }).capacity
      if (e.type === 'StudentSubscribed' && e.tags.courseId === courseId) enrolled++
    }
    if (enrolled >= capacity) throw new BusinessRuleError('full')
    await ctx.append([{ type: 'StudentSubscribed', tags: { courseId, studentId }, data: {} }], appendCondition)
  },
})

function makeKairos() {
  const store = createMemoryEventStore()
  const k = createKairos({ store, events: [CourseCreated, StudentSubscribed] })
  return { k, store }
}

describe('toServerAction', () => {
  it('returns { ok: true, position } on success', async () => {
    const { k, store } = makeKairos()
    await store.append([{ type: 'CourseCreated', tags: { courseId: 'c1' }, data: { capacity: 2 } }])
    const action = toServerAction(subscribe, { kairos: k })
    const res = await action({ courseId: 'c1', studentId: 's1' })
    expect(res).toEqual({ ok: true, position: 2n })
  })

  it('invokes onError when the command throws', async () => {
    const { k, store } = makeKairos()
    await store.append([
      { type: 'CourseCreated',     tags: { courseId: 'c1' }, data: { capacity: 1 } },
      { type: 'StudentSubscribed', tags: { courseId: 'c1', studentId: 'x' }, data: {} },
    ])
    const action = toServerAction(subscribe, {
      kairos: k,
      onError: (e) => ({ ok: false as const, message: (e as Error).message }),
    })
    const res = await action({ courseId: 'c1', studentId: 's1' })
    expect(res).toEqual({ ok: false, message: 'full' })
  })

  it('waits for a named projection before returning', async () => {
    const store = createMemoryEventStore()
    let seenPosition = 0n
    const proj = defineProjection({
      name: 'p',
      on: { StudentSubscribed: async (e) => { seenPosition = e.position } },
    })
    const k = createKairos({ store, events: [], projections: [proj], pollIntervalMs: 5 })
    await store.append([{ type: 'CourseCreated', tags: { courseId: 'c1' }, data: { capacity: 1 } }])
    await k.start()
    try {
      const action = toServerAction(subscribe, { kairos: k, waitFor: 'p' })
      const res = await action({ courseId: 'c1', studentId: 's1' })
      expect(seenPosition).toBe((res as { position: bigint }).position)
    } finally {
      await k.stop()
    }
  })
})

describe('toRouteHandler', () => {
  it('returns 200 with position on success', async () => {
    const { k, store } = makeKairos()
    await store.append([{ type: 'CourseCreated', tags: { courseId: 'c1' }, data: { capacity: 2 } }])
    const handler = toRouteHandler(subscribe, { kairos: k })
    const req = new Request('http://x/subscribe', {
      method: 'POST',
      body: JSON.stringify({ courseId: 'c1', studentId: 's1' }),
    })
    const res = await handler(req)
    expect(res.status).toBe(200)
    const body = await res.json() as { position: string }
    expect(body.position).toBe('2')
  })

  it('returns 400 on ValidationError', async () => {
    const { k } = makeKairos()
    const handler = toRouteHandler(subscribe, { kairos: k })
    const req = new Request('http://x/subscribe', {
      method: 'POST',
      body: JSON.stringify({ courseId: 123 }),
    })
    const res = await handler(req)
    expect(res.status).toBe(400)
  })

  it('returns 422 on BusinessRuleError', async () => {
    const { k, store } = makeKairos()
    await store.append([
      { type: 'CourseCreated',     tags: { courseId: 'c1' }, data: { capacity: 1 } },
      { type: 'StudentSubscribed', tags: { courseId: 'c1', studentId: 'x' }, data: {} },
    ])
    const handler = toRouteHandler(subscribe, { kairos: k })
    const req = new Request('http://x/subscribe', {
      method: 'POST',
      body: JSON.stringify({ courseId: 'c1', studentId: 's1' }),
    })
    const res = await handler(req)
    expect(res.status).toBe(422)
  })
})
