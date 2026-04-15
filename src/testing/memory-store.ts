import { DCBConflictError } from '../core/errors.js'
import type {
  AppendCondition,
  DCBQuery,
  EventEnvelope,
  EventStore,
  EventToAppend,
  ReadResult,
  Tag,
} from '../core/types.js'

export type MemoryEventStoreOptions = {
  clock?: () => Date
  idGenerator?: () => string
}

function defaultId(): string {
  return `evt_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

function tagObjectMatches(eventTags: Tag, queryTag: Tag): boolean {
  for (const key in queryTag) {
    if (eventTags[key] !== queryTag[key]) return false
  }
  return true
}

function matchesQuery(event: EventEnvelope, query: DCBQuery): boolean {
  if (query.eventTypes && query.eventTypes.length > 0) {
    if (!query.eventTypes.includes(event.type)) return false
  }
  if (query.tags && query.tags.length > 0) {
    const anyMatch = query.tags.some(t => tagObjectMatches(event.tags, t))
    if (!anyMatch) return false
  }
  return true
}

export interface InspectableEventStore extends EventStore {
  inspect(query?: DCBQuery): EventEnvelope[]
}

export function createMemoryEventStore(options: MemoryEventStoreOptions = {}): InspectableEventStore {
  const clock = options.clock ?? (() => new Date())
  const idGenerator = options.idGenerator ?? defaultId
  const log: EventEnvelope[] = []
  let nextPosition = 1n

  const store: InspectableEventStore = {
    inspect(query?: DCBQuery): EventEnvelope[] {
      return query ? log.filter(e => matchesQuery(e, query)) : [...log]
    },
    async read(query) {
      const events = log.filter(e => matchesQuery(e, query))
      const maxReadPosition = log.length > 0 ? log[log.length - 1]!.position : 0n
      const result: ReadResult = {
        events,
        appendCondition: { query, maxReadPosition },
      }
      return result
    },

    async append(events: EventToAppend[], condition?: AppendCondition) {
      if (condition) {
        const conflict = log.some(
          e => e.position > condition.maxReadPosition && matchesQuery(e, condition.query),
        )
        if (conflict) {
          throw new DCBConflictError()
        }
      }
      let lastPosition = 0n
      for (const e of events) {
        const envelope: EventEnvelope = {
          id: idGenerator(),
          position: nextPosition,
          type: e.type,
          data: e.data,
          tags: { ...e.tags },
          recordedAt: clock(),
        }
        log.push(envelope)
        lastPosition = nextPosition
        nextPosition = nextPosition + 1n
      }
      return { position: lastPosition }
    },

    async readFrom(position: bigint, limit: number) {
      return log.filter(e => e.position > position).slice(0, limit)
    },
  }

  return store
}
