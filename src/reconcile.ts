import logger from '@adonisjs/core/services/logger'
import { QueueManager } from '@adonisjs/queue'

import { DateTime } from 'luxon'

import JobRun, { JobRunStatus } from './models/job_run.js'
import type { JobEvent, JobOutcome, OrbitConfig } from './types.js'

/** The statuses of a row that waits for an answer. */
const OPEN = [JobRunStatus.PENDING, JobRunStatus.RUNNING, JobRunStatus.RETRYING]

/** The statuses that the queue gives to a job that it still holds. */
const HELD = ['pending', 'active', 'delayed']

/** What a row carries when the queue lets the job go and says nothing. */
const LOST = 'The queue does not hold this job any more. No worker said how it ended.'

/** How long a row stays open before the queue is asked about it, in minutes. */
const GRACE = 5

/** How many rows one call reads. */
const LIMIT = 500

/**
 * Who answers about one job.
 *
 * The queue of the application answers this, and so does a queue of a test.
 * The words are those of a queue, and of no framework.
 */
export interface QueueLookup {
  getJob(id: string, queue: string): Promise<{ status: string; error?: string } | null>
}

export interface ReconcileOptions {
  /** How long a row stays open before the queue is asked about it, in minutes. */
  minutes?: number

  /** How many rows one call reads. */
  limit?: number

  /** Who answers about a job. Without one, the queue of the application. */
  queue?: QueueLookup
}

/**
 * Ask the queue about the jobs that the table still calls open.
 *
 * A worker publishes what it does, and the recorder reads it. A worker that
 * refuses a job before it starts publishes nothing: it fails the job in the
 * queue and takes the next one. The row of that job then waits for an answer
 * that never comes.
 *
 * This reads the rows that stayed open, and asks the queue about each one:
 *
 * - the queue holds the job, thus the row is right and stays as it is;
 * - the queue holds the answer, thus the row takes it;
 * - the queue holds nothing, thus the job is `lost`.
 *
 * The grace leaves the events of the worker the time to land. A row that a
 * worker closed a second ago is not read here.
 *
 * The rows are read from the table, thus this needs `DatabaseSink`. The
 * answers go to every sink of the configuration.
 */
export async function reconcileJobRuns(config: OrbitConfig, options: ReconcileOptions = {}) {
  const before = DateTime.now().minus({ minutes: options.minutes ?? GRACE })

  const open = await JobRun.query()
    .whereIn('status', [...OPEN])
    .where('updatedAt', '<', before.toJSDate())
    .orderBy('id', 'asc')
    .limit(options.limit ?? LIMIT)

  if (open.length === 0) {
    return []
  }

  const queue = options.queue ?? QueueManager.use()
  const at = new Date()
  const events: JobEvent[] = []

  for (const run of open) {
    const record = await queue.getJob(run.jobId, run.queue)

    if (record && HELD.includes(record.status)) {
      continue
    }

    const outcome: JobOutcome = record ? (record.status as JobOutcome) : 'lost'

    events.push({
      type: 'finished',
      at,
      job: {
        id: run.jobId,
        name: run.name,
        queue: run.queue,
        payload: run.payload ?? {},
        attempts: run.attempts,
      },
      outcome,
      duration: null,
      error: record ? record.error || null : LOST,
    })
  }

  if (events.length === 0) {
    return []
  }

  for (const sink of config.sinks ?? []) {
    try {
      await sink.write(events)
    } catch (error) {
      logger.error({ err: error }, 'The trace of a job could not be written')
    }
  }

  return events
}
