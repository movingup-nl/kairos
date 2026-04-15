import type { ZodTypeAny, z } from 'zod'

export type Tag = Record<string, string>

export type EventEnvelope<TType extends string = string, TData = unknown> = {
  id: string
  position: bigint
  type: TType
  data: TData
  tags: Tag
  recordedAt: Date
}

export type EventToAppend<TType extends string = string, TData = unknown> = {
  type: TType
  data: TData
  tags: Tag
}

export type DCBQuery = {
  tags?: Tag[]
  eventTypes?: string[]
}

export type AppendCondition = {
  query: DCBQuery
  maxReadPosition: bigint
}

export type ReadResult = {
  events: EventEnvelope[]
  appendCondition: AppendCondition
}

export type CommandContext = {
  read(query: DCBQuery): Promise<ReadResult>
  append(events: EventToAppend[], condition?: AppendCondition): Promise<{ position: bigint }>
}

export type CommandDefinition<TSchema extends ZodTypeAny = ZodTypeAny> = {
  name: string
  input: TSchema
  handler: (input: z.infer<TSchema>, ctx: CommandContext) => Promise<void>
}

export type EventDefinition<TType extends string = string, TSchema extends ZodTypeAny = ZodTypeAny> = {
  type: TType
  data: TSchema
}

export type ProjectionHandler<TTable = unknown> = (
  event: EventEnvelope,
  tx: TTable,
) => Promise<void>

export type ProjectionDefinition = {
  name: string
  on: Record<string, ProjectionHandler>
}

export interface EventStore {
  read(query: DCBQuery): Promise<ReadResult>
  append(events: EventToAppend[], condition?: AppendCondition): Promise<{ position: bigint }>
  readFrom(position: bigint, limit: number): Promise<EventEnvelope[]>
}
