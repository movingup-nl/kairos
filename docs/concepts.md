---
title: Concepts
nav_order: 2
---

# Concepts

Kairos is built on four ideas. You can use the framework knowing only the first two, but understanding all four tells you *why* the API looks the way it does.

1. **Events as the source of truth**
2. **Commands as intent**
3. **Projections as derived state**
4. **Dynamic Consistency Boundaries (DCB) as the atomicity model**

---

## 1. Events as the source of truth

An **event** is a fact about something that happened, recorded past-tense: `CourseCreated`, `StudentSubscribed`, `CourseCapacityChanged`. Once written, events are immutable.

Your application's authoritative state is the **ordered sequence of events**, not the contents of any table. All other state — SQL rows, caches, search indexes — is derived.

This has two consequences that shape everything else:

- **History is free.** You never "lose" information to an `UPDATE`. Why the state is what it is, is always answerable.
- **Read models are evolutionary.** Add a new way to read the data without touching writes. Rebuild from scratch when you change your mind.

Every event in Kairos has four parts:

| Part        | Example                                         | Purpose                                    |
| ----------- | ----------------------------------------------- | ------------------------------------------ |
| `type`      | `"StudentSubscribed"`                           | What kind of fact this is                  |
| `data`      | `{ seatNumber: 12 }`                            | Payload specific to this event type        |
| `tags`      | `{ courseId: "c1", studentId: "s1" }`           | The *boundaries* this event belongs to (DCB) |
| `position`  | `4217` (assigned by store)                      | Global monotonic order                     |

---

## 2. Commands as intent

A **command** is a request to change state: `SubscribeStudent`, `ChangeCourseCapacity`. Commands are imperative, present-tense, and *may fail* — they're attempts, not facts.

In Kairos a command is a function:

```ts
defineCommand({
  name: 'SubscribeStudent',
  input: z.object({ courseId: z.string(), studentId: z.string() }),
  handler: async (input, ctx) => { /* read → decide → append */ },
})
```

The handler does three things, in order:

1. **Read** the events relevant to this decision via `ctx.read({ tags, eventTypes })`.
2. **Decide** — fold the events into whatever state you need, enforce invariants, produce new events.
3. **Append** those new events via `ctx.append(events, appendCondition)`.

If the invariants are violated, throw `BusinessRuleError`. If another command appended conflicting events between your read and append, `ctx.append` throws `DCBConflictError` — more on that below.

**There is no aggregate class.** The command handler is the decider. What used to live on an aggregate lives in the handler, scoped to exactly this decision.

---

## 3. Projections as derived state

A **projection** is a read model derived from the event log. In Kairos, a projection is a named function that reacts to specific event types and maintains a Drizzle table.

```ts
defineProjection({
  name: 'enrollments',
  on: {
    StudentSubscribed: async (event, tx) => {
      await tx.insert(enrollmentsTable).values({
        courseId:  event.tags.courseId,
        studentId: event.tags.studentId,
      })
    },
  },
})
```

Projections run asynchronously in a background loop inside the Next.js server. Each projection tracks its own cursor (the last event position it processed), stored in Postgres alongside the events.

**Your RSC code queries projection tables directly as Drizzle tables.** The framework does not stand between your pages and your read model. That's deliberate — a custom query layer would be a cost without a benefit.

### Read-your-own-writes

Projections are eventually consistent. After `execute(command)` you get back a `position`. If the same request needs to read what it just wrote:

```ts
const { position } = await kairos.execute(subscribeStudent, input)
await kairos.waitForProjection('enrollments', position)
// projection is now guaranteed caught up past the command's events
```

Server actions can wait automatically via `toServerAction(command, { waitFor: 'enrollments' })`.

### Rebuilds

`kairos.rebuild('enrollments')` truncates the projection table, resets its cursor to zero, and re-runs every event through the handler. This is the answer to "I changed my read model" — no migrations, just rebuild.

---

## 4. Dynamic Consistency Boundaries (DCB)

This is the part worth understanding deeply because it's what makes Kairos different from most ES frameworks.

### The classical problem

Classical DDD says: group related state into an *aggregate*, make the aggregate the unit of consistency, and enforce that one transaction touches exactly one aggregate. Every consistency concern must fit inside one aggregate boundary.

This breaks down in reality. Consider:

> A student can subscribe to a course only if (a) the course isn't full and (b) the student isn't already in 5 courses.

Where does that invariant live? On `Course`? On `Student`? Neither owns both facts. You end up with domain services, eventual consistency between aggregates, or aggregates that grow too large. None of it is satisfying.

### What DCB does

**Dynamic Consistency Boundaries** (introduced in [Axon Framework 5](https://www.axoniq.io/blog/dcb-in-af-5)) inverts the model: instead of defining aggregates up front, each command *declares its own consistency boundary* as a query over events.

The query says: *"these are the events whose state I need to read, and these are the events whose presence would invalidate my decision."*

The append says: *"write these new events, but only if no new events matching my query have appeared since I read."*

```ts
const { events, appendCondition } = await ctx.read({
  tags: [{ courseId }, { studentId }],
  eventTypes: ['CourseCreated', 'StudentSubscribed'],
})
// ...decide...
await ctx.append(newEvents, appendCondition)
//                            ↑ guards against concurrent appends matching the same query
```

The `appendCondition` is an opaque record of `(query, maxReadPosition)`. Postgres checks atomically: is there any event with `position > maxReadPosition` that matches `query`? If yes, throw `DCBConflictError`. If no, insert.

### Why this is better

- **Boundaries span what they need to span.** The subscribe example above is trivial: tag the events with both `courseId` and `studentId`, query on both. Done.
- **No aggregate refactors.** Change what a command considers consistent by changing its query. No schema change, no moving methods between classes.
- **Smaller blast radius.** Two commands operating on unrelated tag sets don't conflict, even if they touch the same event types. Concurrency improves without coordination.
- **Explicit is better than implicit.** The boundary appears literally in the handler that needs it. No hunting for "which aggregate owns this rule."

### Tags

Tags are flat `Record<string, string>`. They are your domain vocabulary: `{ courseId: 'c1' }`, `{ studentId: 's1' }`, `{ organizationId: 'org42', projectId: 'p7' }`.

A DCB query `{ tags: [{ courseId }, { studentId }] }` matches events that contain *either* `{ courseId: '...' }` *or* `{ studentId: '...' }` in their tags (OR between objects, AND within).

Choose tag keys the way you'd choose foreign keys: they're the join points of your domain.

---

## Summary

| Concept     | In one line                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------- |
| Event       | A recorded, immutable, tagged fact about something that happened.                           |
| Command     | A function that reads relevant events, decides, and appends new ones — guarded by DCB.      |
| Projection  | A named, async, rebuildable read model materialized into a Drizzle table.                   |
| DCB         | "Append these events iff no events matching my query appeared since I read." Per-command.   |

Read [getting-started.md](getting-started.md) next for a full worked example.
