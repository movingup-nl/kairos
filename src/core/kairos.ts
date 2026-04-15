import type { ZodTypeAny, z } from 'zod'
import { KairosError, ValidationError } from './errors.js'
import type {
  AppendCondition,
  CommandContext,
  CommandDefinition,
  EventDefinition,
  EventEnvelope,
  EventStore,
  EventToAppend,
  ProjectionDefinition,
} from './types.js'

export type KairosConfig = {
  store: EventStore
  events: EventDefinition[]
  projections?: ProjectionDefinition[]
  pollIntervalMs?: number
  batchSize?: number
}

export type ExecuteResult = { position: bigint }

export type ExecuteOptions = {
  idempotencyKey?: string
}

type ProjectionState = {
  cursor: bigint
  parked: boolean
  lastError?: string
}

export class Kairos {
  private readonly idempotencyCache = new Map<string, ExecuteResult>()
  private readonly projectionStates = new Map<string, ProjectionState>()
  private readonly pollInterval: number
  private readonly batchSize: number
  private running = false
  private loopPromise: Promise<void> | null = null

  constructor(public readonly config: KairosConfig) {
    this.pollInterval = config.pollIntervalMs ?? 50
    this.batchSize = config.batchSize ?? 500
    for (const p of config.projections ?? []) {
      this.projectionStates.set(p.name, { cursor: 0n, parked: false })
    }
  }

  async execute<TSchema extends ZodTypeAny>(
    command: CommandDefinition<TSchema>,
    input: z.infer<TSchema>,
    options?: ExecuteOptions,
  ): Promise<ExecuteResult> {
    const parsed = command.input.safeParse(input)
    if (!parsed.success) {
      throw new ValidationError(`Invalid input for ${command.name}`, parsed.error.issues)
    }

    const cacheKey = options?.idempotencyKey
      ? `${command.name}:${options.idempotencyKey}`
      : null
    if (cacheKey) {
      const cached = this.idempotencyCache.get(cacheKey)
      if (cached) return cached
    }

    let lastPosition = 0n
    const ctx: CommandContext = {
      read: (query) => this.config.store.read(query),
      append: async (events: EventToAppend[], condition?: AppendCondition) => {
        const result = await this.config.store.append(events, condition)
        lastPosition = result.position
        return result
      },
    }

    await command.handler(parsed.data, ctx)

    const result: ExecuteResult = { position: lastPosition }
    if (cacheKey) this.idempotencyCache.set(cacheKey, result)
    return result
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.loopPromise = this.runLoop()
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.loopPromise) {
      await this.loopPromise
      this.loopPromise = null
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      let didWork = false
      for (const proj of this.config.projections ?? []) {
        const state = this.projectionStates.get(proj.name)!
        if (state.parked) continue
        const events = await this.config.store.readFrom(state.cursor, this.batchSize)
        if (events.length === 0) continue
        didWork = true
        for (const event of events) {
          try {
            await this.dispatch(proj, event)
            state.cursor = event.position
          } catch (err) {
            state.parked = true
            state.lastError = err instanceof Error ? err.message : String(err)
            break
          }
        }
      }
      if (!didWork) {
        await sleep(this.pollInterval)
      }
    }
  }

  private async dispatch(projection: ProjectionDefinition, event: EventEnvelope): Promise<void> {
    const handler = projection.on[event.type]
    if (handler) {
      await handler(event, undefined)
    }
  }

  async waitForProjection(name: string, position: bigint, timeoutMs = 5000): Promise<void> {
    const state = this.projectionStates.get(name)
    if (!state) throw new KairosError(`Unknown projection: ${name}`)
    const deadline = Date.now() + timeoutMs
    while (state.cursor < position) {
      if (Date.now() >= deadline) {
        throw new KairosError(`waitForProjection timeout: ${name} cursor=${state.cursor} position=${position}`)
      }
      if (state.parked) {
        throw new KairosError(`Projection '${name}' is parked: ${state.lastError ?? 'unknown error'}`)
      }
      await sleep(Math.min(this.pollInterval, 10))
    }
  }

  async rebuild(projectionName: string): Promise<void> {
    const state = this.projectionStates.get(projectionName)
    if (!state) throw new KairosError(`Unknown projection: ${projectionName}`)
    state.cursor = 0n
    state.parked = false
    delete state.lastError
  }

  health(): { projections: Record<string, { cursor: bigint; parked: boolean; lastError?: string }> } {
    const projections: Record<string, { cursor: bigint; parked: boolean; lastError?: string }> = {}
    for (const [name, state] of this.projectionStates) {
      projections[name] = {
        cursor: state.cursor,
        parked: state.parked,
        ...(state.lastError !== undefined ? { lastError: state.lastError } : {}),
      }
    }
    return { projections }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export function createKairos(config: KairosConfig): Kairos {
  return new Kairos(config)
}
