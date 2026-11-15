import db from '@adonisjs/lucid/services/db'

import JobRun, { JobRunStatus } from '../models/job_run.js'
import type { JobEvent, JobOutcome, Sink } from '../types.js'

/** What one status of the queue is called in the table. */
const STATUS: Record<JobOutcome, string> = {
  completed: JobRunStatus.COMPLETED,
  failed: JobRunStatus.FAILED,
  retrying: JobRunStatus.RETRYING,
  lost: JobRunStatus.LOST,
}

/** The statuses of a row that waits for an answer. */
const OPEN = [JobRunStatus.PENDING, JobRunStatus.RUNNING, JobRunStatus.RETRYING]

/** `job_runs.status in (?, ?, ?)`, with one mark for each open status. */
const IS_OPEN = `${JobRun.table}.status in (${OPEN.map(() => '?').join(', ')})`

/**
 * Keep the trace of the jobs in the table of the application.
 *
 * The three writes are written in SQL because they need `on conflict`, which
 * Lucid does not carry. The model would read the row before writing it, and
 * two processes that write together would then undo each other.
 *
 * The three events of one job write the same row, and each one can land
 * first: the dispatch and the worker run in two processes, and a worker that
 * stops before its writes end leaves the row to the reconciler. The first
 * event writes the row, and the next ones complete it.
 *
 * A row that is closed stays closed. A start that lands after the end fills
 * what the end did not know, and changes nothing else. A `lost` that lands
 * after the end changes nothing: the row has its answer.
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

  /**
   * Write the row of the job that a worker holds, or complete it.
   *
   * An open row takes the start: the status, the count of the tries and the
   * time of this try. A closed row keeps its status, and takes the time of the
   * start only while it has none.
   */
  #take({ job, at }: Extract<JobEvent, { type: 'started' }>) {
    return db.rawQuery(
      `insert into ${JobRun.table}
         (job_id, name, queue, status, payload, attempts, started_at, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (job_id) do update set
         status = case when ${IS_OPEN} then excluded.status else ${JobRun.table}.status end,
         attempts = greatest(${JobRun.table}.attempts, excluded.attempts),
         started_at = case when ${IS_OPEN}
           then excluded.started_at
           else coalesce(${JobRun.table}.started_at, excluded.started_at)
         end,
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
        ...OPEN,
        ...OPEN,
      ]
    )
  }

  /**
   * Say how the try of a job ended.
   *
   * The end can land before the start, thus it writes the row when there is
   * none. A `lost` says that nobody answered, thus it writes nothing on a row
   * that has an answer.
   */
  #close({ job, at, outcome, duration, error }: Extract<JobEvent, { type: 'finished' }>) {
    const ended = outcome !== 'retrying'

    return db.rawQuery(
      `insert into ${JobRun.table}
         (job_id, name, queue, status, payload, attempts, duration, error, finished_at, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (job_id) do update set
         status = excluded.status,
         attempts = greatest(${JobRun.table}.attempts, excluded.attempts),
         duration = excluded.duration,
         error = excluded.error,
         finished_at = excluded.finished_at,
         updated_at = excluded.updated_at
       where excluded.status <> ? or ${IS_OPEN}`,
      [
        job.id,
        job.name,
        job.queue,
        STATUS[outcome],
        JSON.stringify(job.payload),
        job.attempts,
        duration,
        error,
        ended ? at : null,
        at,
        at,
        JobRunStatus.LOST,
        ...OPEN,
      ]
    )
  }
}
