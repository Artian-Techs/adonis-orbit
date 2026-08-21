import logger from '@adonisjs/core/services/logger'
import { Job } from '@adonisjs/queue'
import type { JobOptions } from '@adonisjs/queue/types'

import { DateTime } from 'luxon'

import JobRun, { JobRunStatus } from '../models/job_run.js'

interface PruneJobRunsPayload {
  /** How long a job that succeeded stays readable, in days. */
  days: number
}

/**
 * Take out of the table the jobs that ended well.
 *
 * A job that succeeded says nothing after a few days, and the table would grow
 * with every mail of every day.
 *
 * A job that failed is never taken out. It waits for a person, however long
 * that takes.
 */
export default class PruneJobRuns extends Job<PruneJobRunsPayload> {
  static options: JobOptions = {
    queue: 'default',
    maxRetries: 1,
  }

  async execute() {
    const before = DateTime.now().minus({ days: this.payload.days })

    const removed = await JobRun.query()
      .where('status', JobRunStatus.COMPLETED)
      .where('finishedAt', '<', before.toJSDate())
      .delete()

    logger.info(`${removed} trace(s) of jobs removed.`)
  }
}
