import type { ZodTypeAny } from 'zod'
import type { EventDefinition } from './types.js'

export function defineEvent<TType extends string, TSchema extends ZodTypeAny>(
  type: TType,
  data: TSchema,
): EventDefinition<TType, TSchema> {
  return { type, data }
}
