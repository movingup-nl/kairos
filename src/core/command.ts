import type { ZodTypeAny } from 'zod'
import type { CommandDefinition } from './types.js'

export function defineCommand<TSchema extends ZodTypeAny>(
  def: CommandDefinition<TSchema>,
): CommandDefinition<TSchema> {
  return def
}
