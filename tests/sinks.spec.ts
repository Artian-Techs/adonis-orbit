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

/** Say that one job waits, and leave the writes the time to land. */
async function dispatch(id: string) {
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
    assert.isNotNull(eventOf(chosen, id))
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

    assert.isNotNull(eventOf(beside, id))
  })
})
