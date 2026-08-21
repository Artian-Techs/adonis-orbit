import db from '@adonisjs/lucid/services/db'

import JobRun, { JobRunStatus } from '../models/job_run.js'
import type { JobEvent, JobOutcome, Sink } from '../types.js'

/** What one status of the queue is called in the table. */
const STATUS: Record<JobOutcome, string> = {
  completed: JobRunStatus.COMPLETED,
  failed: JobRunStatus.FAILED,
  retrying: JobRunStatus.RETRYING,
}

/**
 * Keep the trace of the jobs in the table of the application.
 *
 * The two inserts are written in SQL because they need `on conflict`, which
 * Lucid does not carry. The model would read the row before writing it, and
 * two processes that write together would then undo each other.
 *
 * The row that the dispatch writes and the row that the worker writes are the
 * same row. Either of the two can arrive first, thus the first one writes and
 * the second one completes.
 */
export default class DatabaseSink implements Sink {
  async write(events: JobEvent[]) {
    const dispatched = events.filter((event) => event.type === 'dispatched')

    if (dispatched.length > 0) {
      await this.#open(dispatched)
    }

    for (const event of events) {
      if (event.type === 'started') {
        await this.#take(event)
      }

      if (event.type === 'finished') {
        await this.#close(event)
      }
    }
  }

  /** Write the row of every job that waits for a worker. */
  #open(events: Extract<JobEvent, { type: 'dispatched' }>[]) {
    const rows = events.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
    const values = events.flatMap(({ job, at }) => [
      job.id,
      job.name,
      job.queue,
      JobRunStatus.PENDING,
      JSON.stringify(job.payload),
      job.attempts,
      at,
      at,
      at,
    ])

    return db.rawQuery(
      `insert into ${JobRun.table}
         (job_id, name, queue, status, payload, attempts, dispatched_at, created_at, updated_at)
       values ${rows}
       on conflict (job_id) do nothing`,
      values
    )
  }

  /** Write the row of the job that a worker holds, or complete it. */
  #take({ job, at }: Extract<JobEvent, { type: 'started' }>) {
    return db.rawQuery(
      `insert into ${JobRun.table}
         (job_id, name, queue, status, payload, attempts, started_at, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (job_id) do update set
         status = excluded.status,
         attempts = excluded.attempts,
         started_at = excluded.started_at,
         updated_at = excluded.updated_at`,
      [
        job.id,
        job.name,
        job.queue,
        JobRunStatus.RUNNING,
        JSON.stringify(job.payload),
        job.attempts,
        at,
        at,
        at,
      ]
    )
  }

  /** Say how the try of a job ended. */
  #close({ job, at, outcome, duration, error }: Extract<JobEvent, { type: 'finished' }>) {
    const ended = outcome === 'completed' || outcome === 'failed'

    return JobRun.query()
      .where('jobId', job.id)
      .update({
        status: STATUS[outcome],
        duration,
        error,
        finishedAt: ended ? at : null,
        updatedAt: at,
      })
  }
}
