import type { ZodTypeAny, z } from 'zod'
import type { CommandDefinition } from '../core/types.js'
import type { Kairos } from '../core/kairos.js'
import {
  BusinessRuleError,
  DCBConflictError,
  KairosError,
  ValidationError,
} from '../core/errors.js'

export type ServerActionSuccess = { ok: true; position: bigint }

export type ToServerActionOptions<TResult = unknown> = {
  kairos: Kairos
  waitFor?: string | string[]
  onError?: (error: unknown) => TResult
}

function toArray(x: string | string[] | undefined): string[] {
  if (!x) return []
  return Array.isArray(x) ? x : [x]
}

export function toServerAction<TSchema extends ZodTypeAny, TErrorResult = never>(
  command: CommandDefinition<TSchema>,
  options: ToServerActionOptions<TErrorResult>,
): (input: z.infer<TSchema>) => Promise<ServerActionSuccess | TErrorResult> {
  const waitFor = toArray(options.waitFor)
  return async (input) => {
    try {
      const result = await options.kairos.execute(command, input)
      for (const name of waitFor) {
        await options.kairos.waitForProjection(name, result.position)
      }
      return { ok: true, position: result.position }
    } catch (err) {
      if (options.onError) return options.onError(err)
      throw err
    }
  }
}

export type ToRouteHandlerOptions = {
  kairos: Kairos
  waitFor?: string | string[]
}

export function toRouteHandler<TSchema extends ZodTypeAny>(
  command: CommandDefinition<TSchema>,
  options: ToRouteHandlerOptions,
): (req: Request) => Promise<Response> {
  const waitFor = toArray(options.waitFor)
  return async (req: Request) => {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return json({ error: 'Invalid JSON body' }, 400)
    }
    try {
      const result = await options.kairos.execute(command, body as z.infer<TSchema>)
      for (const name of waitFor) {
        await options.kairos.waitForProjection(name, result.position)
      }
      return json({ position: result.position.toString() }, 200)
    } catch (err) {
      if (err instanceof ValidationError) {
        return json({ error: err.message, issues: err.issues }, 400)
      }
      if (err instanceof BusinessRuleError) {
        return json({ error: err.message }, 422)
      }
      if (err instanceof DCBConflictError) {
        return json({ error: err.message }, 409)
      }
      if (err instanceof KairosError) {
        return json({ error: err.message }, 500)
      }
      return json({ error: 'Internal error' }, 500)
    }
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
