import logger from '@adonisjs/core/services/logger'
import { tracingChannels } from '@adonisjs/queue'

import type { JobEvent, JobIdentity, OrbitConfig, PayloadRule, Sink } from './types.js'

/** The steps of a job that this package does not read. */
const IGNORED = {
  end: () => {},
  asyncStart: () => {},
  error: () => {},
}

/**
 * What the reader of the trace needs to understand the failure.
 *
 * A job that reached its last try fails with an error that names the count,
 * and carries the real one as its cause.
 */
function describe(error?: Error) {
  if (!error) {
    return null
  }

  const cause = error.cause instanceof Error ? `\n${error.cause.stack ?? error.cause.message}` : ''

  return `${error.stack ?? error.message}${cause}`
}

/**
 * What one job carries, as much of it as the configuration keeps.
 *
 * A payload holds what a person wrote: an address, a name, a number. An
 * application that sends its trace to another machine says here what leaves
 * its own.
 */
function keep(rule: PayloadRule, job: Omit<JobIdentity, 'payload'>, payload: unknown) {
  const values = (payload ?? {}) as Record<string, unknown>

  if (rule === 'none') {
    return {}
  }

  if (typeof rule === 'function') {
    return rule(values, job)
  }

  return values
}

/**
 * Keep what the queue does with its jobs.
 *
 * The queue holds its jobs in Redis and removes them when they end. The trace
 * holds what a job carried, how many tries it took, and the error that stopped
 * it.
 *
 * The channels of the queue answer at once, thus the events are written apart.
 * A sink that refuses an event must never stop the job that runs.
 *
 * The start and the end of a short job come in the same tick, and a sink
 * answers each write apart. The end would land before the start, and the row
 * would stay open. The events of one job thus go to one sink one after the
 * other, in the order that the queue gave them. Two jobs do not wait for each
 * other, and two sinks do not wait for each other.
 *
 * A configuration that names no sink keeps nothing.
 *
 * The recorder gives back a `flush`. It waits for the writes that are open,
 * and the application calls it before it closes what the sinks use.
 */
export function recordJobRuns(config: OrbitConfig) {
  const sinks: Sink[] = config.sinks ?? []
  const rule = config.payload ?? 'full'

  /** The writes that are started, and that no sink finished yet. */
  const pending = new Set<Promise<void>>()

  /** The last write of each job that a sink did not finish yet, by sink. */
  const lanes = new Map(sinks.map((sink) => [sink, new Map<string, Promise<void>>()]))

  function write(events: JobEvent[]) {
    const ids = [...new Set(events.map((event) => event.job.id))]

    for (const sink of sinks) {
      const lane = lanes.get(sink)!
      const before = Promise.all(ids.map((id) => lane.get(id)))

      const done = before
        .then(() => sink.write(events))
        .catch((error) => {
          logger.error({ err: error }, 'The trace of a job could not be written')
        })

      for (const id of ids) {
        lane.set(id, done)
      }

      pending.add(done)

      void done.finally(() => {
        pending.delete(done)

        for (const id of ids) {
          if (lane.get(id) === done) {
            lane.delete(id)
          }
        }
      })
    }
  }

  /**
   * Wait for every write that is open.
   *
   * A command puts a job in the queue and stops at once. The writes of the
   * sinks are still open at that moment, and the application closes its
   * database after this call. A write that a sink starts while this one waits
   * is waited for too.
   */
  async function flush() {
    while (pending.size > 0) {
      await Promise.all(pending)
    }
  }

  function identify(
    job: { id: string; name: string; payload?: unknown; attempts?: number },
    queue: string
  ) {
    const identity = { id: job.id, name: job.name, queue, attempts: job.attempts ?? 0 }

    return { ...identity, payload: keep(rule, identity, job.payload) }
  }

  tracingChannels.dispatchChannel.subscribe({
    ...IGNORED,
    start: () => {},

    asyncEnd(message) {
      /**
       * A dispatch that the window of `dedup` held opens no job, thus it gives
       * no event either.
       */
      if (message.error || (message.dedupOutcome && message.dedupOutcome !== 'added')) {
        return
      }

      const at = new Date()

      write(
        message.jobs.map((job) => ({
          type: 'dispatched' as const,
          at,
          job: identify(job, message.queue),
        }))
      )
    },
  })

  tracingChannels.executeChannel.subscribe({
    ...IGNORED,

    start(message) {
      write([{ type: 'started', at: new Date(), job: identify(message.job, message.queue) }])
    },

    asyncEnd(message) {
      write([
        {
          type: 'finished',
          at: new Date(),
          job: identify(message.job, message.queue),
          outcome: message.status ?? 'retrying',
          duration: message.duration ?? null,
          error: describe(message.error),
        },
      ])
    },
  })

  return { flush }
}
