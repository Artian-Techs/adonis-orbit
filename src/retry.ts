import { type Job, Locator } from '@adonisjs/queue'

import { DateTime } from 'luxon'

import type JobRun from './models/job_run.js'

/**
 * Ask the queue for a job that already ran.
 *
 * The row is never replaced: the new job takes a new identifier and opens its
 * own row, and the old one names it. A job asked for twice is thus read twice
 * in the table, with the two answers it gave.
 */
export async function retryRun(run: JobRun) {
  const JobClass = Locator.get(run.name) as unknown as typeof Job | undefined

  if (!JobClass) {
    throw new Error(`The job "${run.name}" is not registered`)
  }

  const { jobId } = await JobClass.dispatch(run.payload).toQueue(run.queue).run()

  await run.merge({ retriedAt: DateTime.now(), retriedJobId: jobId }).save()

  return jobId
}
