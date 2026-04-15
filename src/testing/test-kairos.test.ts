import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createTestKairos } from './index.js'
import { defineCommand } from '../core/command.js'
import { defineEvent } from '../core/event.js'
import { defineProjection } from '../core/projection.js'
import { BusinessRuleError } from '../core/errors.js'

const CourseCreated     = defineEvent('CourseCreated', z.object({ capacity: z.number().int().positive() }))
const StudentSubscribed = defineEvent('StudentSubscribed', z.object({}))

const subscribeStudent = defineCommand({
  name: 'SubscribeStudent',
  input: z.object({ courseId: z.string(), studentId: z.string() }),
  handler: async ({ courseId, studentId }, ctx) => {
    const { events, appendCondition } = await ctx.read({
      tags: [{ courseId }],
      eventTypes: ['CourseCreated', 'StudentSubscribed'],
    })
    let capacity = 0, enrolled = 0
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

describe('createTestKairos', () => {
  it('seeds events via given() and executes commands against them', async () => {
    const k = createTestKairos({ events: [CourseCreated, StudentSubscribed] })

    await k.given([
      { type: 'CourseCreated', tags: { courseId: 'c1' }, data: { capacity: 2 } },
    ])

    const { position } = await k.execute(subscribeStudent, { courseId: 'c1', studentId: 's1' })
    expect(position).toBe(2n)

    const matching = k.eventsMatching({ eventTypes: ['StudentSubscribed'] })
    expect(matching).toHaveLength(1)
  })

  it('runs projections synchronously — read model is current after execute returns', async () => {
    const enrollments: Array<{ courseId: string; studentId: string }> = []
    const proj = defineProjection({
      name: 'enrollments',
      on: {
        StudentSubscribed: async (event) => {
          enrollments.push({
            courseId: event.tags.courseId!,
            studentId: event.tags.studentId!,
          })
        },
      },
    })

    const k = createTestKairos({
      events: [CourseCreated, StudentSubscribed],
      projections: [proj],
    })

    await k.given([{ type: 'CourseCreated', tags: { courseId: 'c1' }, data: { capacity: 5 } }])
    await k.execute(subscribeStudent, { courseId: 'c1', studentId: 's1' })

    expect(enrollments).toEqual([{ courseId: 'c1', studentId: 's1' }])
  })

  it('enforces invariants — a full course rejects subscription', async () => {
    const k = createTestKairos({ events: [CourseCreated, StudentSubscribed] })

    await k.given([
      { type: 'CourseCreated',     tags: { courseId: 'c1' }, data: { capacity: 1 } },
      { type: 'StudentSubscribed', tags: { courseId: 'c1', studentId: 's1' }, data: {} },
    ])

    await expect(
      k.execute(subscribeStudent, { courseId: 'c1', studentId: 's2' }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })
})
