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
 * A configuration that names no sink keeps nothing.
 */
export function recordJobRuns(config: OrbitConfig) {
  const sinks: Sink[] = config.sinks ?? []
  const rule = config.payload ?? 'full'

  function write(events: JobEvent[]) {
    for (const sink of sinks) {
      void sink.write(events).catch((error) => {
        logger.error({ err: error }, 'The trace of a job could not be written')
      })
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
}
