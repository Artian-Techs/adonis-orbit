import type { HttpContext } from '@adonisjs/core/http'

/**
 * Who may read the page.
 *
 * The answer is `true`, and the request goes on. The answer is `false`, and
 * the page says "not found" — a guard that wants to say something else writes
 * its own answer before it says `false`.
 */
export type Authorize = (ctx: HttpContext) => boolean | Promise<boolean>

/**
 * What names one job, in every event that it gives.
 *
 * The three events carry the same identity. A sink that reads one event alone
 * thus knows the job, and needs none of the events that came before.
 */
export interface JobIdentity {
  /** The identifier that the queue gives to the job. */
  id: string

  /** The name of the class that does the work. */
  name: string

  /** The queue that holds the job. */
  queue: string

  /** What the job carries. The configuration says how much of it is kept. */
  payload: Record<string, unknown>

  /** How many times a worker took the job. */
  attempts: number
}

/** How a try of a job ended. */
export type JobOutcome = 'completed' | 'failed' | 'retrying'

/**
 * One step of one job.
 *
 * The words are those of a queue, and of no framework: a sink writes them in a
 * table, or sends them to a machine that reads them.
 */
export type JobEvent =
  | { type: 'dispatched'; at: Date; job: JobIdentity }
  | { type: 'started'; at: Date; job: JobIdentity }
  | {
      type: 'finished'
      at: Date
      job: JobIdentity
      outcome: JobOutcome

      /** How long the try took, in milliseconds. */
      duration: number | null

      /** The error that stopped the job, and the error that caused it. */
      error: string | null
    }

/**
 * Where the trace of the jobs goes.
 *
 * The recorder gives the events of one step together. A sink that writes
 * several rows at once thus writes them in one call.
 */
export interface Sink {
  write(events: JobEvent[]): Promise<void>
}

/**
 * How much of what a job carries is kept.
 *
 * `full` keeps everything. `none` keeps nothing. A function keeps what it
 * gives back, thus an application takes out the values that it does not want
 * to read again.
 */
export type PayloadRule =
  | 'full'
  | 'none'
  | ((
      payload: Record<string, unknown>,
      job: Omit<JobIdentity, 'payload'>
    ) => Record<string, unknown>)

/**
 * What the application tells Orbit.
 */
export interface OrbitConfig {
  /** Where the page answers. */
  path: string

  /**
   * Who may read the page. The package carries `basicAuth`, and an application
   * writes its own guard when it reads a name of a person instead.
   */
  authorize: Authorize

  /**
   * Where the trace of the jobs goes.
   *
   * Nothing is kept that this list does not name. An application that wants
   * the table of `job_runs` and the page that reads it thus names
   * `DatabaseSink` here.
   */
  sinks: Sink[]

  /** How much of what a job carries is kept. Without a rule, everything. */
  payload?: PayloadRule
}
