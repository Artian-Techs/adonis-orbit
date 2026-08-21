import { BaseModel, column } from '@adonisjs/lucid/orm'

import type { DateTime } from 'luxon'

/**
 * A job class that the page leaves out of its lists.
 *
 * The row names a class, not one job. Take it away, and everything that class
 * did comes back, including what it did while it was silent.
 */
export default class SilencedJob extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare name: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime<true>

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
