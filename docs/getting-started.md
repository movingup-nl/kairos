---
title: Getting started
nav_order: 1
---

# Getting started

> ⚠️ Kairos is pre-alpha. Runtime implementations are stubs. This guide shows the intended shape of a Kairos application; the code will not yet execute.

This guide walks through the canonical Kairos example: a course-subscription feature with two invariants that span what would classically be two aggregates.

**Invariants:**

- A course has a fixed capacity. It can't be exceeded.
- A student can be subscribed to at most 5 courses.

---

## 1. Install

```bash
npm install kairos drizzle-orm zod
# peer deps (if using the Next.js wrappers)
npm install next react
```

---

## 2. Define events

Events are the vocabulary of your domain. They should read like past-tense sentences.

```ts
// src/domain/course/events.ts
import { defineEvent } from 'kairos'
import { z } from 'zod'

export const CourseCreated = defineEvent(
  'CourseCreated',
  z.object({ title: z.string(), capacity: z.number().int().positive() }),
)

export const CourseCapacityChanged = defineEvent(
  'CourseCapacityChanged',
  z.object({ capacity: z.number().int().positive() }),
)

export const StudentSubscribed = defineEvent('StudentSubscribed', z.object({}))
```

Choose tag keys now, even though they're not in the event definition — they're the foreign keys of your domain.

- `CourseCreated` → tagged `{ courseId }`
- `CourseCapacityChanged` → tagged `{ courseId }`
- `StudentSubscribed` → tagged `{ courseId, studentId }`

---

## 3. Define the command

```ts
// src/domain/course/subscribe-student.ts
import { defineCommand, BusinessRuleError } from 'kairos'
import { z } from 'zod'

export const subscribeStudent = defineCommand({
  name: 'SubscribeStudent',
  input: z.object({ courseId: z.string(), studentId: z.string() }),
  handler: async ({ courseId, studentId }, ctx) => {
    const { events, appendCondition } = await ctx.read({
      tags: [{ courseId }, { studentId }],
      eventTypes: ['CourseCreated', 'CourseCapacityChanged', 'StudentSubscribed'],
    })

    let capacity = 0
    let enrolledInCourse = 0
    let studentCourseCount = 0

    for (const e of events) {
      if (e.type === 'CourseCreated')         capacity = (e.data as { capacity: number }).capacity
      if (e.type === 'CourseCapacityChanged') capacity = (e.data as { capacity: number }).capacity
      if (e.type === 'StudentSubscribed') {
        if (e.tags.courseId  === courseId)  enrolledInCourse++
        if (e.tags.studentId === studentId) studentCourseCount++
      }
    }

    if (enrolledInCourse   >= capacity) throw new BusinessRuleError('Course is full')
    if (studentCourseCount >= 5)        throw new BusinessRuleError('Student is at course limit')

    await ctx.append(
      [{ type: 'StudentSubscribed', tags: { courseId, studentId }, data: {} }],
      appendCondition,
    )
  },
})
```

**What's happening:**

- The `read` query scopes to events tagged with *either* this course or this student.
- The fold computes the three numbers we need.
- The invariants are enforced with `BusinessRuleError`.
- The append is guarded by `appendCondition`. If another request subscribed the same student or filled the course between our read and append, the append fails with `DCBConflictError`.

---

## 4. Define a projection

Projections turn events into read models your UI can query.

```ts
// src/domain/course/projections.ts
import { defineProjection } from 'kairos'
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const enrollments = pgTable('enrollments', {
  courseId:  text('course_id').notNull(),
  studentId: text('student_id').notNull(),
  at:        timestamp('at', { withTimezone: true }).notNull(),
})

export const enrollmentsProjection = defineProjection({
  name: 'enrollments',
  on: {
    StudentSubscribed: async (event, tx: any) => {
      await tx.insert(enrollments).values({
        courseId:  event.tags.courseId,
        studentId: event.tags.studentId,
        at:        event.recordedAt,
      })
    },
  },
})
```

---

## 5. Wire up Kairos

```ts
// src/kairos.ts
import { createKairos } from 'kairos'
import { createDrizzleEventStore } from 'kairos/drizzle'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

import { CourseCreated, CourseCapacityChanged, StudentSubscribed } from './domain/course/events.js'
import { enrollmentsProjection } from './domain/course/projections.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
export const db = drizzle(pool)

export const kairos = createKairos({
  store: createDrizzleEventStore({ db }),
  events: [CourseCreated, CourseCapacityChanged, StudentSubscribed],
  projections: [enrollmentsProjection],
})
```

Start the projection runner when the Next.js server boots:

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { kairos } = await import('./src/kairos.js')
    await kairos.start()
  }
}
```

---

## 6. Invoke from Next.js

### As a server action

```ts
// app/courses/[id]/actions.ts
'use server'
import { toServerAction } from 'kairos/next'
import { subscribeStudent } from '@/src/domain/course/subscribe-student'
import { kairos } from '@/src/kairos'

export const subscribe = toServerAction(subscribeStudent, {
  kairos,
  waitFor: 'enrollments', // block until the enrollments projection catches up
})
```

```tsx
// app/courses/[id]/page.tsx
import { db } from '@/src/kairos'
import { enrollments } from '@/src/domain/course/projections'
import { eq } from 'drizzle-orm'
import { subscribe } from './actions'

export default async function CoursePage({ params }: { params: { id: string } }) {
  const rows = await db.select().from(enrollments).where(eq(enrollments.courseId, params.id))
  return (
    <>
      <ul>{rows.map(r => <li key={r.studentId}>{r.studentId}</li>)}</ul>
      <form action={async (fd) => {
        'use server'
        await subscribe({ courseId: params.id, studentId: String(fd.get('studentId')) })
      }}>
        <input name="studentId" />
        <button>Subscribe</button>
      </form>
    </>
  )
}
```

Notice the RSC query is plain Drizzle — Kairos doesn't sit between your pages and your read model.

### As a route handler

```ts
// app/api/subscribe/route.ts
import { toRouteHandler } from 'kairos/next'
import { subscribeStudent } from '@/src/domain/course/subscribe-student'
import { kairos } from '@/src/kairos'

export const POST = toRouteHandler(subscribeStudent, { kairos })
```

---

## 7. Test it

```ts
// src/domain/course/subscribe-student.test.ts
import { createTestKairos } from 'kairos/testing'
import { BusinessRuleError } from 'kairos'
import { describe, it, expect } from 'vitest'
import { subscribeStudent } from './subscribe-student.js'
import { CourseCreated, StudentSubscribed } from './events.js'
import { enrollmentsProjection } from './projections.js'

describe('SubscribeStudent', () => {
  it('rejects when course is full', async () => {
    const k = createTestKairos({
      events: [CourseCreated, StudentSubscribed],
      projections: [enrollmentsProjection],
    })

    await k.given([
      { type: 'CourseCreated',     tags: { courseId: 'c1' }, data: { title: 'DDD 101', capacity: 1 } },
      { type: 'StudentSubscribed', tags: { courseId: 'c1', studentId: 's1' }, data: {} },
    ])

    await expect(
      k.execute(subscribeStudent, { courseId: 'c1', studentId: 's2' }),
    ).rejects.toThrow(BusinessRuleError)
  })
})
```

Tests run against the in-memory adapter. Projections run synchronously. No Postgres required.

---

## Next steps

- Read [concepts.md](concepts.md) if you haven't yet — DCB in particular repays understanding.
- Read the [design doc](plans/2026-04-15-kairos-design.md) for what's in v0.1 and what's deferred.
- Browse the [API reference](api.md).
