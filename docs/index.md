---
title: Home
layout: home
nav_order: 0
---

# Kairos

**A CQRS/Event Sourcing framework for Next.js, built around Dynamic Consistency Boundaries.**

Kairos lets you build Next.js applications where state is a stream of immutable events and read models are generated on the side. Commands declare exactly the consistency they need — no aggregate design, no service coordination, no race conditions.

> *Kairos (καιρός)* — Greek for *"the decisive moment."* An append succeeds only if the moment is still valid: no events matching your query have landed since you read. The name is the mechanic.

> ⚠️ Pre-alpha (`0.0.0`). Core is implemented and tested (32 passing tests). The Drizzle/Postgres adapter and the example app are next.

---

## Start here

New to these ideas? [**Read the concepts page**](concepts.html) — it walks through a realistic scenario and introduces events, commands, projections, and DCB one at a time.

Ready to build? [**The getting-started guide**](getting-started.html) takes you through the canonical course-subscription feature end to end.

Looking up a function? [**API reference**](api.html).

Curious about the design decisions? [**v0.1 design doc**](plans/2026-04-15-kairos-design.html).

---

## A glance

```ts
export const subscribeStudent = defineCommand({
  name: 'SubscribeStudent',
  input: z.object({ courseId: z.string(), studentId: z.string() }),
  handler: async ({ courseId, studentId }, ctx) => {
    const { events, appendCondition } = await ctx.read({
      tags: [{ courseId }, { studentId }],
      eventTypes: ['CourseCreated', 'StudentSubscribed'],
    })
    // fold events, enforce invariants...
    await ctx.append(
      [{ type: 'StudentSubscribed', tags: { courseId, studentId }, data: {} }],
      appendCondition,
    )
  },
})
```

No aggregate class, no repository. The `tags` passed to `ctx.read` *are* the consistency boundary for this command — the framework guarantees nothing matching that query appears between your read and your append.

---

## Source

The code and the docs live in [movingup-nl/kairos](https://github.com/movingup-nl/kairos). MIT licensed.
