import { NotImplementedError } from '../core/errors.js'
import type { EventStore } from '../core/types.js'

export type DrizzleAdapterConfig = {
  db: unknown
  schema?: { events?: unknown; projectionCursors?: unknown }
}

export function createDrizzleEventStore(_config: DrizzleAdapterConfig): EventStore {
  throw new NotImplementedError('createDrizzleEventStore')
}

export { events, projectionCursors } from './schema.js'
