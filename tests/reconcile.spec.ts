import db from '@adonisjs/lucid/services/db'

import { test } from '@japa/runner'
import { DateTime } from 'luxon'

import JobRun, { JobRunStatus, type JobRunStatusValue } from '../src/models/job_run.js'
import { reconcileJobRuns } from '../src/reconcile.js'
import DatabaseSink from '../src/sinks/database_sink.js'
import type { JobEvent, OrbitConfig, Sink } from '../src/types.js'
import { makeRun, truncate } from './helpers.js'

/** A queue that answers what the test wrote in it. */
class Queue {
  records = new Map<string, { status: string; error?: string }>()

  say(id: string, record: { status: string; error?: string }) {
    this.records.set(id, record)
  }

  async getJob(id: string) {
    return this.records.get(id) ?? null
  }
}

/** A sink that holds the events, and gives them back to the test. */
class Collector implements Sink {
  events: JobEvent[] = []

  async write(events: JobEvent[]) {
    this.events.push(...events)
  }
}

function config(sinks: Sink[]): OrbitConfig {
  return { path: '/queue', authorize: () => false, sinks }
}

/** Say that a row waited, and for how long. */
function age(jobId: string, minutes: number) {
  return db.rawQuery(`update ${JobRun.table} set updated_at = ? where job_id = ?`, [
    DateTime.now().minus({ minutes }).toJSDate(),
    jobId,
  ])
}

/** One row that the table calls open, and that waited long enough to be read. */
async function open(status: JobRunStatusValue = JobRunStatus.PENDING) {
  const run = await makeRun({ status, dispatchedAt: DateTime.now().minus({ minutes: 30 }) })

  await age(run.jobId, 30)

  return run
}

test.group('Reconcile job runs', (group) => {
  group.each.setup(() => truncate())

  test('a job that the queue does not hold any more is lost', async ({ assert }) => {
    const run = await open()

    await reconcileJobRuns(config([new DatabaseSink()]), { queue: new Queue() })

    await run.refresh()

    assert.equal(run.status, JobRunStatus.LOST)
    assert.isNotNull(run.finishedAt)
    assert.include(run.error, 'No worker said how it ended')
  })

  test('a job that the queue still holds stays as it is', async ({ assert }) => {
    const run = await open()
    const queue = new Queue()

    queue.say(run.jobId, { status: 'pending' })

    await reconcileJobRuns(config([new DatabaseSink()]), { queue })

    await run.refresh()

    assert.equal(run.status, JobRunStatus.PENDING)
    assert.isNull(run.finishedAt)
  })

  test('a job that a worker holds stays as it is', async ({ assert }) => {
    const run = await open(JobRunStatus.RUNNING)
    const queue = new Queue()

    queue.say(run.jobId, { status: 'active' })

    await reconcileJobRuns(config([new DatabaseSink()]), { queue })

    await run.refresh()

    assert.equal(run.status, JobRunStatus.RUNNING)
  })

  test('a job that the queue calls failed takes the error of the queue', async ({ assert }) => {
    const run = await open()
    const queue = new Queue()

    queue.say(run.jobId, { status: 'failed', error: 'Job class "SendMail" is not registered' })

    await reconcileJobRuns(config([new DatabaseSink()]), { queue })

    await run.refresh()

    assert.equal(run.status, JobRunStatus.FAILED)
    assert.equal(run.error, 'Job class "SendMail" is not registered')
  })

  test('a job that the queue calls completed is written as completed', async ({ assert }) => {
    const run = await open(JobRunStatus.RUNNING)
    const queue = new Queue()

    queue.say(run.jobId, { status: 'completed' })

    await reconcileJobRuns(config([new DatabaseSink()]), { queue })

    await run.refresh()

    assert.equal(run.status, JobRunStatus.COMPLETED)
  })

  test('a job that waits for its next try stays while the queue holds it', async ({ assert }) => {
    const run = await open(JobRunStatus.RETRYING)
    const queue = new Queue()

    queue.say(run.jobId, { status: 'delayed' })

    await reconcileJobRuns(config([new DatabaseSink()]), { queue })

    await run.refresh()

    assert.equal(run.status, JobRunStatus.RETRYING)
  })

  test('a row that is young is not read', async ({ assert }) => {
    const run = await makeRun({ status: JobRunStatus.PENDING })

    const events = await reconcileJobRuns(config([new DatabaseSink()]), { queue: new Queue() })

    await run.refresh()

    assert.lengthOf(events, 0)
    assert.equal(run.status, JobRunStatus.PENDING)
  })

  test('a row that is closed is never read', async ({ assert }) => {
    const run = await makeRun({ status: JobRunStatus.COMPLETED })

    await age(run.jobId, 30)

    const events = await reconcileJobRuns(config([new DatabaseSink()]), { queue: new Queue() })

    assert.lengthOf(events, 0)
  })

  test('every sink of the configuration reads the answer', async ({ assert }) => {
    const run = await open()
    const collector = new Collector()

    await reconcileJobRuns(config([collector]), { queue: new Queue() })

    assert.lengthOf(collector.events, 1)

    const [event] = collector.events

    assert.equal(event.type, 'finished')
    assert.equal(event.job.id, run.jobId)
    assert.equal(event.job.name, 'SendMail')

    if (event.type === 'finished') {
      assert.equal(event.outcome, 'lost')
    }
  })

  test('a sink that is down does not stop the others', async ({ assert }) => {
    await open()

    const collector = new Collector()
    const broken: Sink = {
      async write() {
        throw new Error('This sink is down')
      },
    }

    await reconcileJobRuns(config([broken, collector]), { queue: new Queue() })

    assert.lengthOf(collector.events, 1)
  })

  test('one call reads no more rows than the limit', async ({ assert }) => {
    await open()
    await open()
    await open()

    const events = await reconcileJobRuns(config([new DatabaseSink()]), {
      queue: new Queue(),
      limit: 2,
    })

    assert.lengthOf(events, 2)
  })
})
