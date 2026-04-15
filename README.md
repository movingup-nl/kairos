# Kairos

**A DCB-first CQRS/Event Sourcing framework for Next.js.**

> *Kairos (καιρός)* — Greek for *"the decisive moment."* In DCB, an append succeeds only if the moment is still valid: no events matching your query have landed since you read. The name is the mechanic.

Kairos gives Next.js applications a principled write model (events, commands, DCB-guarded appends) and a plain read model (Drizzle projection tables that RSC can query directly). It is designed for small teams who want the design benefits of CQRS/ES/DDD without the operational weight — and for codebases built collaboratively with AI agents, where named intents and explicit invariants are worth more than they look.

> ⚠️ **Status:** pre-alpha (`0.0.0`). Core is implemented and tested (in-memory event store, `Kairos.execute`, projection runner, `createTestKairos`, Next.js wrappers — 32 passing tests). The Drizzle/Postgres adapter and an example Next.js app are next. See [the design doc](docs/plans/2026-04-15-kairos-design.md) for v0.1 scope.

---

## Why Kairos?

Most Next.js apps reach for CRUD-over-Postgres because CQRS/ES feels heavy. But the weight was never the *idea* — it was the boilerplate. When AI writes the boilerplate, the trade flips: explicit intents, immutable history, and evolutionary read models become strictly superior.

Kairos leans into that shift:

- **Named, typed intents.** A `SubscribeStudent` command is a better interface than `POST /enrollments` — for humans reviewing code and for agents reasoning about it.
- **Dynamic Consistency Boundaries (DCB).** The hardest thing in classical DDD is deciding aggregate boundaries. DCB ([introduced in Axon 5](https://www.axoniq.io/blog/dcb-in-af-5)) replaces that with per-command declarative boundaries expressed as tag queries. Invariants that span "aggregates" stop being a design crisis.
- **Evolutionary by construction.** New features are new events and new projections. The write model stays stable while read models proliferate. Want to try a feature on a branch? New projection; no write-side risk.
- **Debuggable by replay.** When something is wrong, the events tell you what actually happened — not what a mutated row claims now.
- **Works with, not against, Next.js.** RSC reads projection tables directly. Server actions wrap commands in one line. The framework runs inside your Next.js process — no extra services to operate in v0.1.

---

## A glance at the API

```ts
import { defineCommand, defineEvent, BusinessRuleError } from 'kairos'
import { z } from 'zod'

// events
export const CourseCreated     = defineEvent('CourseCreated',     z.object({ capacity: z.number().int().positive() }))
export const StudentSubscribed = defineEvent('StudentSubscribed', z.object({}))

// command
export const subscribeStudent = defineCommand({
  name: 'SubscribeStudent',
  input: z.object({ courseId: z.string(), studentId: z.string() }),
  handler: async ({ courseId, studentId }, ctx) => {
    const { events, appendCondition } = await ctx.read({
      tags: [{ courseId }, { studentId }],
      eventTypes: ['CourseCreated', 'StudentSubscribed'],
    })

    let capacity = 0, enrolled = 0, studentCourses = 0
    for (const e of events) {
      if (e.type === 'CourseCreated')     capacity = (e.data as { capacity: number }).capacity
      if (e.type === 'StudentSubscribed') {
        if (e.tags.courseId  === courseId)  enrolled++
        if (e.tags.studentId === studentId) studentCourses++
      }
    }
    if (enrolled       >= capacity) throw new BusinessRuleError('Course full')
    if (studentCourses >= 5)        throw new BusinessRuleError('Student at limit')

    await ctx.append(
      [{ type: 'StudentSubscribed', tags: { courseId, studentId }, data: {} }],
      appendCondition,
    )
  },
})
```

Notice what isn't there: no aggregate class, no repository, no "where does this invariant live?" debate. The handler reads exactly what it needs, decides, appends. The tags *are* the boundary.

---

## Shape of the framework

| Submodule         | What it gives you                                                                 |
| ----------------- | --------------------------------------------------------------------------------- |
| `kairos`          | Core primitives: `defineCommand`, `defineEvent`, `defineProjection`, `createKairos`, errors, types |
| `kairos/drizzle`  | Postgres event store + schema (Drizzle)                                           |
| `kairos/testing`  | In-memory event store + `createTestKairos` with synchronous projections           |
| `kairos/next`     | `toServerAction`, `toRouteHandler` — thin adapters for Next.js invocation points  |

See [docs/concepts.md](docs/concepts.md) for the mental model and [docs/getting-started.md](docs/getting-started.md) for a full walkthrough.

---

## What's in v0.1

**In:**
- Event store interface + Drizzle/Postgres adapter with DCB append semantics
- `defineCommand` / `defineEvent` / `defineProjection`
- `execute` with input validation and `DCBConflictError` on concurrency
- In-process polling projection runner (cursor in Postgres)
- `waitForProjection(name, position)` for read-your-own-writes
- In-memory adapter + synchronous test harness
- Next.js server action / route handler wrappers
- Idempotency keys on `execute`

**Deliberately out of v0.1:** process managers/sagas, event upcasters, snapshots, multi-tenancy, sharded projection workers, observability beyond structured logs, the AI-workflow skill. See the design doc for reasoning.

---

## Documentation

- [**Concepts**](docs/concepts.md) — DCB, CQRS, events, projections explained in the context of Kairos.
- [**Getting started**](docs/getting-started.md) — build the course-subscription example end-to-end.
- [**API reference**](docs/api.md) — every exported function, type, and option.
- [**Design doc**](docs/plans/2026-04-15-kairos-design.md) — the rationale and v0.1 plan.

---

## License

MIT.
