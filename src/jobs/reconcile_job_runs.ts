import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import { Job } from '@adonisjs/queue'
import type { JobOptions } from '@adonisjs/queue/types'

import { reconcileJobRuns } from '../reconcile.js'
import type { OrbitConfig } from '../types.js'

interface ReconcileJobRunsPayload {
  /** How long a row stays open before the queue is asked about it, in minutes. */
  minutes?: number
}

/**
 * Close the rows that wait for an answer that never comes.
 *
 * A worker that refuses a job before it starts publishes nothing. The row of
 * that job stays open, and the page shows it as a job that waits. This asks
 * the queue about every row that stayed open, and writes what the queue says.
 */
export default class ReconcileJobRuns extends Job<ReconcileJobRunsPayload> {
  static options: JobOptions = {
    queue: 'default',
    maxRetries: 1,
  }

  async execute() {
    const config = app.config.get<OrbitConfig>('orbit', {
      path: '/queue',
      authorize: () => false,
      sinks: [],
    })

    const events = await reconcileJobRuns(config, { minutes: this.payload.minutes })

    logger.info(`${events.length} trace(s) of jobs closed.`)
  }
}
