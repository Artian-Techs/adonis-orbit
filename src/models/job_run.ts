import { BaseModel, column } from '@adonisjs/lucid/orm'

import type { DateTime } from 'luxon'

/**
 * What the queue did with one job.
 *
 * `pending` and `running` are what the worker is about to do or does now.
 * `completed` and `failed` are what it did. `retrying` names a job that failed
 * a try and waits for the next one.
 */
export const JobRunStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  RETRYING: 'retrying',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const

export type JobRunStatusValue = (typeof JobRunStatus)[keyof typeof JobRunStatus]

export default class JobRun extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare jobId: string

  @column()
  declare name: string

  @column()
  declare queue: string

  @column()
  declare status: JobRunStatusValue

  @column()
  declare payload: Record<string, unknown>

  @column()
  declare attempts: number

  @column()
  declare error: string | null

  @column()
  declare duration: number | null

  @column.dateTime()
  declare dispatchedAt: DateTime | null

  @column.dateTime()
  declare startedAt: DateTime | null

  @column.dateTime()
  declare finishedAt: DateTime | null

  @column.dateTime()
  declare retriedAt: DateTime | null

  @column()
  declare retriedJobId: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime<true>

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
