import type { ZodTypeAny, z } from 'zod'
import type {
  CommandDefinition,
  DCBQuery,
  EventDefinition,
  EventEnvelope,
  EventStore,
  EventToAppend,
  ProjectionDefinition,
} from '../core/types.js'
import { createKairos, Kairos, type ExecuteResult } from '../core/kairos.js'
import { createMemoryEventStore } from './memory-store.js'

export { createMemoryEventStore } from './memory-store.js'
export type { MemoryEventStoreOptions } from './memory-store.js'

export type TestKairosConfig = {
  events: EventDefinition[]
  projections?: ProjectionDefinition[]
  clock?: () => Date
  idGenerator?: () => string
}

export interface TestKairos {
  given(events: EventToAppend[]): Promise<void>
  execute<TSchema extends ZodTypeAny>(
    command: CommandDefinition<TSchema>,
    input: z.infer<TSchema>,
  ): Promise<ExecuteResult>
  eventsMatching(query: DCBQuery): EventEnvelope[]
  projection<T>(name: string): T
  store: EventStore
  kairos: Kairos
}

export function createTestKairos(config: TestKairosConfig): TestKairos {
  const store = createMemoryEventStore({
    ...(config.clock ? { clock: config.clock } : {}),
    ...(config.idGenerator ? { idGenerator: config.idGenerator } : {}),
  })

  const projections = config.projections ?? []
  const cursors = new Map<string, bigint>()
  for (const p of projections) cursors.set(p.name, 0n)

  async function drainProjections(): Promise<void> {
    for (const p of projections) {
      const cursor = cursors.get(p.name)!
      const events = await store.readFrom(cursor, 10_000)
      for (const event of events) {
        const handler = p.on[event.type]
        if (handler) await handler(event, undefined)
        cursors.set(p.name, event.position)
      }
    }
  }

  const kairos = createKairos({
    store,
    events: config.events,
    projections,
  })

  const projectionRegistry = new Map<string, unknown>()

  return {
    store,
    kairos,
    async given(events) {
      await store.append(events)
      await drainProjections()
    },
    async execute(command, input) {
      const result = await kairos.execute(command, input)
      await drainProjections()
      return result
    },
    eventsMatching(query) {
      return store.inspect(query)
    },
    projection<T>(name: string): T {
      return projectionRegistry.get(name) as T
    },
  }
}
