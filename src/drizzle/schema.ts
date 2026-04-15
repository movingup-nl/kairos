import { bigserial, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const events = pgTable('kairos_events', {
  position: bigserial('position', { mode: 'bigint' }).primaryKey(),
  id: uuid('id').notNull().unique(),
  type: text('type').notNull(),
  data: jsonb('data').notNull(),
  tags: jsonb('tags').$type<Record<string, string>>().notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
})

export const projectionCursors = pgTable('kairos_projection_cursors', {
  name: text('name').primaryKey(),
  cursor: bigserial('cursor', { mode: 'bigint' }).notNull(),
  parked: text('parked'),
  lastError: text('last_error'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
