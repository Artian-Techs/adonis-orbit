import { randomUUID } from 'node:crypto'

import { tracingChannels } from '@adonisjs/queue'

import { test } from '@japa/runner'

import { recordJobRuns } from '../src/recorder.js'
import type { JobEvent, Sink } from '../src/types.js'
import { settle } from './helpers.js'

/** A sink that holds the events, and gives them back to the test. */
class Collector implements Sink {
  events: JobEvent[] = []

  async write(events: JobEvent[]) {
    this.events.push(...events)
  }
}

/** A sink that refuses every event. */
class Broken implements Sink {
  async write(): Promise<void> {
    throw new Error('This sink is down')
  }
}

/** A sink that answers after the job that gave it the event. */
class Slow extends Collector {
  async write(events: JobEvent[]) {
    await new Promise((resolve) => setTimeout(resolve, 60))

    this.events.push(...events)
  }
}

const everything = new Collector()
const nothing = new Collector()
const chosen = new Collector()
const beside = new Collector()

recordJobRuns({ path: '/queue', authorize: () => false, sinks: [everything] })
recordJobRuns({ path: '/queue', authorize: () => false, sinks: [nothing], payload: 'none' })
recordJobRuns({
  path: '/queue',
  authorize: () => false,
  sinks: [chosen],
  payload: (payload) => ({ to: payload.to }),
})
recordJobRuns({ path: '/queue', authorize: () => false, sinks: [new Broken(), beside] })

const slow = new Slow()
const late = recordJobRuns({ path: '/queue', authorize: () => false, sinks: [slow] })

/** Say that one job waits. */
function publish(id: string) {
  tracingChannels.dispatchChannel.asyncEnd.publish({
    jobs: [
      {
        id,
        name: 'SendMail',
        payload: { to: 'someone@example.com', password: 'a-secret' },
        attempts: 0,
      },
    ],
    queue: 'mails',
  } as never)
}

/** Say that one job waits, and leave the writes the time to land. */
async function dispatch(id: string) {
  publish(id)

  await settle()
}

function eventOf(sink: Collector, id: string) {
  return sink.events.find((event) => event.job.id === id)
}

test.group('Sinks', () => {
  test('every sink of the configuration reads the same event', async ({ assert }) => {
    const id = randomUUID()

    await dispatch(id)

    const event = eventOf(everything, id)

    assert.equal(event?.type, 'dispatched')
    assert.equal(event?.job.name, 'SendMail')
    assert.equal(event?.job.queue, 'mails')
    assert.equal(event?.job.attempts, 0)
    assert.exists(eventOf(chosen, id))
  })

  test('the whole payload travels when no rule says otherwise', async ({ assert }) => {
    const id = randomUUID()

    await dispatch(id)

    assert.deepEqual(eventOf(everything, id)?.job.payload, {
      to: 'someone@example.com',
      password: 'a-secret',
    })
  })

  test('a payload of "none" leaves nothing of what the job carried', async ({ assert }) => {
    const id = randomUUID()

    await dispatch(id)

    assert.deepEqual(eventOf(nothing, id)?.job.payload, {})
  })

  test('a rule keeps of the payload what it gives back', async ({ assert }) => {
    const id = randomUUID()

    await dispatch(id)

    assert.deepEqual(eventOf(chosen, id)?.job.payload, { to: 'someone@example.com' })
  })

  test('a sink that is down does not stop the others', async ({ assert }) => {
    const id = randomUUID()

    await dispatch(id)

    assert.exists(eventOf(beside, id))
  })
})

test.group('Flush', () => {
  test('flush waits for a write that a sink did not finish', async ({ assert }) => {
    const id = randomUUID()

    publish(id)
    assert.isUndefined(eventOf(slow, id))

    await late.flush()

    assert.exists(eventOf(slow, id))
  })

  test('flush gives back at once while no write is open', async ({ assert }) => {
    const started = Date.now()

    await late.flush()

    assert.isBelow(Date.now() - started, 50)
  })

  test('a sink that is down does not stop the flush', async ({ assert }) => {
    const broken = recordJobRuns({
      path: '/queue',
      authorize: () => false,
      sinks: [new Broken()],
    })

    publish(randomUUID())

    let refused = false
    await broken.flush().catch(() => {
      refused = true
    })

    assert.isFalse(refused)
  })
})
