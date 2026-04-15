---
title: Home
layout: home
nav_order: 0
---

# Kairos

**A DCB-first CQRS/Event Sourcing framework for Next.js.**

> *Kairos (καιρός)* — Greek for *"the decisive moment."* In DCB, an append succeeds only if the moment is still valid: no events matching your query have landed since you read. The name is the mechanic.

Kairos gives Next.js applications a principled write model (events, commands, DCB-guarded appends) and a plain read model (Drizzle projection tables that RSC can query directly). It's designed for small teams who want the design benefits of CQRS/ES/DDD without the operational weight — and for codebases built collaboratively with AI agents, where named intents and explicit invariants are worth more than they look.

> ⚠️ **Status:** pre-alpha (`0.0.0`). Core is implemented and tested; Drizzle adapter and example project are next.

---

## Start here

- [**Concepts**](concepts.html) — the mental model: events, commands, projections, and DCB.
- [**Getting started**](getting-started.html) — build the canonical course-subscription example end-to-end.
- [**API reference**](api.html) — every exported function and type.
- [**Design doc**](plans/2026-04-15-kairos-design.html) — v0.1 rationale and scope.

---

## Why Kairos?

Most Next.js apps reach for CRUD-over-Postgres because CQRS/ES feels heavy. The weight was never the *idea* — it was the boilerplate. When AI writes the boilerplate, the trade flips: explicit intents, immutable history, and evolutionary read models become strictly superior.

- **Named, typed intents.** A `SubscribeStudent` command is a better interface than `POST /enrollments`.
- **Dynamic Consistency Boundaries** ([Axon 5](https://www.axoniq.io/blog/dcb-in-af-5)) replace aggregate-design debates with per-command declarative boundaries.
- **Evolutionary by construction.** New features are new events and new projections; the write model stays stable.
- **Debuggable by replay.** The events tell you what actually happened.
- **Works with Next.js, not against it.** RSC reads projection tables directly; server actions wrap commands in one line.

---

## A glance at the API

```ts
import { defineCommand, defineEvent, BusinessRuleError } from 'kairos'
import { z } from 'zod'

export const StudentSubscribed = defineEvent('StudentSubscribed', z.object({}))

export const subscribeStudent = defineCommand({
  name: 'SubscribeStudent',
  input: z.object({ courseId: z.string(), studentId: z.string() }),
  handler: async ({ courseId, studentId }, ctx) => {
    const { events, appendCondition } = await ctx.read({
      tags: [{ courseId }, { studentId }],
      eventTypes: ['CourseCreated', 'StudentSubscribed'],
    })
    // ...fold events, enforce invariants...
    await ctx.append(
      [{ type: 'StudentSubscribed', tags: { courseId, studentId }, data: {} }],
      appendCondition,
    )
  },
})
```

No aggregate class, no repository, no "where does this invariant live?" debate. The tags *are* the boundary.
