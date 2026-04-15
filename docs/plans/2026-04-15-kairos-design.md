---
title: v0.1 design doc
parent: Plans
nav_order: 1
---

# Kairos — v0.1 design

**Date:** 2026-04-15
**Status:** Approved for scaffolding. Runtime implementation pending.

---

## Motivation

Most Next.js applications reach for CRUD because CQRS/Event Sourcing feels operationally heavy. The weight has historically come from the *boilerplate*, not the *ideas*. When AI agents write the boilerplate, the trade-off flips: explicit intents, immutable history, and evolutionary read models are strictly superior to mutable-row CRUD for collaborative AI-assisted development.

Kairos is a CQRS/ES framework for Next.js that adopts **Dynamic Consistency Boundaries** (DCB, [Axon 5](https://www.axoniq.io/blog/dcb-in-af-5)) as its atomicity model, replacing classical aggregates. Target user: solo and small-team Next.js projects running on a single Postgres.

---

## Scope

**In v0.1:**

- Single package `kairos` with subpath exports (`kairos`, `kairos/drizzle`, `kairos/testing`, `kairos/next`).
- Drizzle/Postgres event store as the single production adapter.
- `defineCommand`, `defineEvent`, `defineProjection` — function + Zod style.
- `execute(command, input)` with Zod input validation and `DCBConflictError` surfacing.
- Explicit `ctx.read` / `ctx.append` primitives (no decider abstraction yet — revisit after lived experience).
- Tags as flat `Record<string, string>`.
- Async projection runner (in-process polling, cursor in Postgres), with `waitForProjection(name, position)` for read-your-own-writes.
- In-memory adapter and `createTestKairos` with synchronous projections for fast tests.
- Thin Next.js integration: `toServerAction`, `toRouteHandler`. RSC reads projection tables directly as Drizzle.
- Idempotency keys on `execute`.
- Projection rebuilds via `kairos.rebuild(name)`.

**Out of v0.1 (deliberately):**

- Process managers / sagas. Workarounds: call `execute` from projection handlers if truly needed.
- Event upcasters. Convention: version event types (`StudentSubscribed.v2`), handle both in consumers.
- Snapshots. DCB queries are bounded by tags, not stream length, so snapshots are less load-bearing than in classical ES.
- Decider abstraction. The explicit `read`/`append` makes DCB mechanics visible while users are still learning them. Add a decider helper on top once the primitive feels natural.
- Multi-tenancy / sharding / multi-process projection workers.
- Observability beyond structured logs.
- The AI-workflow skill. Build it after living in the framework through a few real features so conventions are earned, not guessed.

---

## Architecture overview

### Data flow for a command

1. Caller invokes `execute(cmd, input)` (from server action, route handler, cron, or test).
2. Framework validates input with the command's Zod schema → `ValidationError` on failure.
3. Handler runs with `ctx.read` / `ctx.append`.
4. `ctx.read({ tags, eventTypes })` queries matching events up to current max position, returns events + opaque `appendCondition`.
5. Handler folds events, enforces invariants, calls `ctx.append(events, appendCondition)`.
6. Append either succeeds atomically, or throws `DCBConflictError` when the DCB guard detects conflicting new events.
7. `execute` returns `{ position }`. Caller may then `await kairos.waitForProjection(name, position)`.

### Event store (Postgres via Drizzle)

```sql
CREATE TABLE kairos_events (
  position     bigserial PRIMARY KEY,
  id           uuid NOT NULL UNIQUE,
  type         text NOT NULL,
  data         jsonb NOT NULL,
  tags         jsonb NOT NULL,              -- flat {key: string}
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kairos_events_tags_gin ON kairos_events USING gin (tags);
CREATE INDEX kairos_events_type_pos ON kairos_events (type, position);

CREATE TABLE kairos_projection_cursors (
  name       text PRIMARY KEY,
  cursor     bigint NOT NULL DEFAULT 0,
  parked     boolean NOT NULL DEFAULT false,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

### DCB query semantics

A query is `{ tags?: Tag[]; eventTypes?: string[] }`. An event matches if:

- its `tags` JSONB *contains* any of the query's tag objects (OR across the array, AND within each object), AND
- its `type` is in `eventTypes` (if `eventTypes` is provided).

`ctx.read(query)` returns events + `appendCondition = { query, maxReadPosition }`.

`ctx.append(events, condition)` runs in one transaction:

1. `SELECT pg_advisory_xact_lock($GUARD_KEY)` or single-row lock to serialize the check.
2. Run the DCB guard query: *is there any event with `position > maxReadPosition` matching `query`?*
3. If yes → `DCBConflictError`. If no → insert the new events.

No auto-retry. Callers decide (typically: re-run the command from the top; commands are idempotent via their `id`).

### Projection runner

- One in-process loop, started on server boot via Next.js `instrumentation.ts`.
- For each projection: read events where `position > cursor`, batched (default 500); for each event, if `on[type]` exists, run it inside a transaction that also advances the cursor.
- Atomic cursor advance = at-least-once semantics; because cursor moves in the same tx as the projection write, effectively exactly-once per projection.
- On handler throw: log, set `parked = true`, stop advancing this projection's cursor. Other projections continue. Visible via `kairos.health()`.
- Polling, not `LISTEN/NOTIFY`, for v0.1 (simpler, no connection lifecycle to manage). Default poll interval 50ms.

### `waitForProjection(name, position, timeoutMs=5000)`

Polls the cursor row; resolves when `cursor >= position`. Throws on timeout.

### Testing

- In-memory adapter implements the same `EventStore` interface as Drizzle.
- `createTestKairos({ events, projections, clock?, idGenerator? })` returns a harness where projections run synchronously after each `execute`.
- `k.given(events)` seeds events directly, bypassing handlers (intended for "arrange" steps).
- DCB semantics in memory mirror Postgres closely; drift is the main long-term risk (mitigated later by a conformance suite, deferred).

---

## Key decisions recorded

| Decision                                   | Chosen                                    | Alternatives considered                                   | Reason                                                                                  |
| ------------------------------------------ | ----------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Target user                                | Solo/small-team Next.js + single Postgres | Serious-production; hybrid                                | Scope discipline; can evolve                                                            |
| Persistence                                | Postgres only, Drizzle, hand-rolled       | Wrap existing ES lib; pluggable from day one              | DCB semantics don't graft onto stream-oriented libs                                     |
| Command API style                          | Function + Zod (`defineCommand`)          | Decorator classes; plain server actions                   | Fits modern TS, strong inference, no `reflect-metadata`                                 |
| DCB API                                    | Explicit `ctx.read` / `ctx.append`        | Decider helper; both                                      | Explicit primitive while users are learning DCB; deciders are easy to add on top later  |
| Projection consistency                     | Async only, with `waitForProjection`      | Sync-in-transaction; hybrid                               | Sync couples write to projection lifecycle; CQRS purity + one mental model              |
| V0.1 slice                                 | Commands + projections + tests            | Commands only; commands + AI skill                        | Projections are where "CQRS pays off in Next.js" materializes                           |
| Test fidelity                              | In-memory only                            | Real Postgres; both                                       | v0.1 simplicity; add conformance suite later                                            |
| Command invocation surface                 | Bare `execute` + thin Next.js wrappers    | Server actions only; route handlers only                  | `execute` is the real primitive; wrappers are conveniences                              |
| Framework name                             | **Kairos**                                | Ledger (crypto vibe); Tenet; Axiom; Praxis                | Greek for "decisive moment" — encodes DCB mechanic                                      |

---

## Risks

- **DCB is new.** Few prior art references. Expect to discover patterns as they emerge. Mitigated by keeping the primitive explicit (no decider abstraction yet) so users see the mechanics.
- **In-memory/Postgres drift.** Conformance suite deferred. Acceptable while there is exactly one production adapter.
- **Event schema evolution.** No upcasters in v0.1. Use event type versioning (`Foo.v2`). Revisit once a real migration bites.
- **Projections in-process.** A busy Next.js server and a busy projector share event loop. Acceptable for scope 1; scope 2 worker separation later.

---

## Next steps

1. Implement `createDrizzleEventStore` with DCB append semantics. Conformance: idempotent inserts (unique `id`), correct guard query, transactional cursor advance.
2. Implement `createMemoryEventStore` with matching semantics.
3. Implement `Kairos.execute` (validation, handler invocation, idempotency key).
4. Implement projection runner + `waitForProjection` + `rebuild`.
5. Implement `toServerAction` + `toRouteHandler`.
6. Build the course-subscription example end-to-end in a separate `examples/` directory as the first integration test.
7. Revisit: decider helper, conformance suite, AI-workflow skill.
