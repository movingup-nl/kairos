---
title: API reference
nav_order: 3
---

# API reference

All exports are typed. This page lists the public surface of each submodule.

---

## `kairos`

### `defineEvent(type, schema)`

```ts
function defineEvent<TType extends string, TSchema extends ZodTypeAny>(
  type: TType,
  schema: TSchema,
): EventDefinition<TType, TSchema>
```

Declares an event type with a Zod schema for its `data` payload.

### `defineCommand(def)`

```ts
function defineCommand<TSchema extends ZodTypeAny>(def: {
  name: string
  input: TSchema
  handler: (input: z.infer<TSchema>, ctx: CommandContext) => Promise<void>
}): CommandDefinition<TSchema>
```

Declares a command. The handler receives validated input and a `CommandContext`.

### `defineProjection(def)`

```ts
function defineProjection(def: {
  name: string
  on: Record<string, (event: EventEnvelope, tx: any) => Promise<void>>
}): ProjectionDefinition
```

Declares a projection. `on` maps event `type` → handler. Handlers receive the event and a Drizzle transaction.

### `createKairos(config)`

```ts
function createKairos(config: {
  store: EventStore
  events: EventDefinition[]
  projections?: ProjectionDefinition[]
  pollIntervalMs?: number
}): Kairos
```

Wires up a Kairos instance. Typically called once at module scope.

### `Kairos`

```ts
class Kairos {
  execute<TSchema>(command: CommandDefinition<TSchema>, input: z.infer<TSchema>, options?: ExecuteOptions): Promise<{ position: bigint }>
  waitForProjection(name: string, position: bigint, timeoutMs?: number): Promise<void>
  rebuild(projectionName: string): Promise<void>
  start(): Promise<void>   // starts the projection runner
  stop(): Promise<void>
  health(): { projections: Record<string, { cursor: bigint; parked: boolean; lastError?: string }> }
}
```

### `CommandContext`

Passed to every command handler.

```ts
interface CommandContext {
  read(query: { tags?: Tag[]; eventTypes?: string[] }): Promise<{
    events: EventEnvelope[]
    appendCondition: AppendCondition
  }>
  append(events: EventToAppend[], condition: AppendCondition): Promise<{ position: bigint }>
}
```

### Errors

- `KairosError` — base class for all framework errors.
- `BusinessRuleError` — thrown by handlers to signal domain rule violations. Callers translate to user-facing messages.
- `DCBConflictError` — thrown by `ctx.append` when an event matching the read query has landed since the read. Callers may retry the command.
- `ValidationError` — thrown by `execute` when input fails Zod validation.
- `NotImplementedError` — placeholder while the framework is pre-alpha.

### Types

`Tag`, `EventEnvelope`, `EventToAppend`, `DCBQuery`, `AppendCondition`, `ReadResult`, `EventStore`, `CommandDefinition`, `EventDefinition`, `ProjectionDefinition`, `ProjectionHandler`, `KairosConfig`, `ExecuteOptions`, `ExecuteResult`.

---

## `kairos/drizzle`

### `createDrizzleEventStore(config)`

```ts
function createDrizzleEventStore(config: {
  db: unknown  // Drizzle instance
  schema?: { events?: unknown; projectionCursors?: unknown }
}): EventStore
```

Postgres-backed implementation of `EventStore`. DCB append is implemented via a serializable check within one transaction.

### Exported schemas

- `events` — the events table (`kairos_events`)
- `projectionCursors` — the cursor tracking table (`kairos_projection_cursors`)

Run your usual Drizzle migration flow to create these.

---

## `kairos/testing`

### `createTestKairos(config)`

```ts
function createTestKairos(config: {
  events: EventDefinition[]
  projections?: ProjectionDefinition[]
  clock?: () => Date
  idGenerator?: () => string
}): TestKairos
```

Returns an in-memory Kairos for tests. Projections run **synchronously** after each `execute` — `waitForProjection` resolves immediately.

### `TestKairos`

```ts
interface TestKairos {
  given(events: EventToAppend[]): Promise<void>       // seed events, bypass handlers
  execute(command, input): Promise<{ position: bigint }>
  eventsMatching(query: DCBQuery): EventEnvelope[]
  projection<T>(name: string): T                      // direct read-model access
  store: EventStore
}
```

### `createMemoryEventStore()`

Returns a standalone in-memory `EventStore` for tests that don't need the full harness.

---

## `kairos/next`

### `toServerAction(command, options)`

```ts
function toServerAction<TSchema, TResult>(
  command: CommandDefinition<TSchema>,
  options: {
    kairos: Kairos
    waitFor?: string | string[]
    onError?: (error: unknown) => TResult
  },
): (input: z.infer<TSchema>) => Promise<TResult | { ok: true; position: bigint }>
```

Wraps a command as a Next.js server action. If `waitFor` is given, the action awaits `waitForProjection` for each named projection before returning.

### `toRouteHandler(command, options)`

```ts
function toRouteHandler<TSchema>(
  command: CommandDefinition<TSchema>,
  options: { kairos: Kairos; waitFor?: string | string[] },
): (req: Request) => Promise<Response>
```

Wraps a command as a Next.js route handler. Maps errors to HTTP status codes:

| Error               | Status |
| ------------------- | ------ |
| `ValidationError`   | 400    |
| `BusinessRuleError` | 422    |
| `DCBConflictError`  | 409    |
| other               | 500    |
