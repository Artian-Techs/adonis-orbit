import { randomUUID } from 'node:crypto'

import { tracingChannels } from '@adonisjs/queue'

import { test } from '@japa/runner'

import JobRun, { JobRunStatus } from '../src/models/job_run.js'
import { recordJobRuns } from '../src/recorder.js'
import DatabaseSink from '../src/sinks/database_sink.js'
import { settle, truncate, waitFor } from './helpers.js'

/** The recorder listens once, as the provider makes it listen once. */
recordJobRuns({ path: '/queue', authorize: () => false, sinks: [new DatabaseSink()] })

function jobData(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    name: 'SendMail',
    payload: { to: 'someone@example.com' },
    attempts: 0,
    ...overrides,
  }
}

function dispatch(message: Record<string, unknown>) {
  tracingChannels.dispatchChannel.asyncEnd.publish(message as never)
}

function execute(step: 'start' | 'asyncEnd', message: Record<string, unknown>) {
  tracingChannels.executeChannel[step].publish(message as never)
}

function find(id: string) {
  return JobRun.findBy('jobId', id)
}

test.group('Recorder', (group) => {
  group.each.setup(() => truncate())

  test('the dispatch writes one row of each job that waits', async ({ assert }) => {
    const first = jobData()
    const second = jobData({ name: 'SendInvoice' })

    dispatch({ jobs: [first, second], queue: 'mails' })

    const run = await waitFor(() => find(first.id))

    assert.equal(run.name, 'SendMail')
    assert.equal(run.queue, 'mails')
    assert.equal(run.status, JobRunStatus.PENDING)
    assert.deepEqual(run.payload, { to: 'someone@example.com' })
    assert.equal(run.attempts, 0)
    assert.isNotNull(run.dispatchedAt)
    assert.isNull(run.startedAt)

    assert.exists(await waitFor(() => find(second.id)))
  })

  test('a dispatch that failed opens no row', async ({ assert }) => {
    const job = jobData()

    dispatch({ jobs: [job], queue: 'default', error: new Error('Redis is down') })

    await settle()

    assert.isNull(await find(job.id))
  })

  test('a dispatch that the window of dedup held opens no row', async ({ assert }) => {
    const job = jobData()

    dispatch({ jobs: [job], queue: 'default', dedupOutcome: 'skipped' })

    await settle()

    assert.isNull(await find(job.id))
  })

  test('the worker writes the row when the dispatch did not arrive', async ({ assert }) => {
    const job = jobData({ attempts: 1 })

    execute('start', { job: { ...job, acquiredAt: Date.now() }, queue: 'default' })

    const run = await waitFor(() => find(job.id))

    assert.equal(run.status, JobRunStatus.RUNNING)
    assert.equal(run.attempts, 1)
    assert.isNotNull(run.startedAt)
    assert.isNull(run.dispatchedAt)
  })

  test('the worker completes the row that the dispatch opened', async ({ assert }) => {
    const job = jobData()

    dispatch({ jobs: [job], queue: 'default' })

    const pending = await waitFor(() => find(job.id))

    execute('start', { job: { ...job, attempts: 2, acquiredAt: Date.now() }, queue: 'default' })

    const run = await waitFor(async () => {
      const row = await find(job.id)

      return row?.status === JobRunStatus.RUNNING ? row : null
    })

    assert.equal(run.id, pending.id)
    assert.equal(run.attempts, 2)
    assert.isNotNull(run.dispatchedAt)
    assert.isNotNull(run.startedAt)
  })

  test('a dispatch that arrives after the worker does not undo the row', async ({ assert }) => {
    const job = jobData()

    execute('start', { job: { ...job, acquiredAt: Date.now() }, queue: 'default' })

    await waitFor(() => find(job.id))

    dispatch({ jobs: [job], queue: 'default' })

    await settle()

    const rows = await JobRun.query().where('jobId', job.id)

    assert.lengthOf(rows, 1)
    assert.equal(rows[0].status, JobRunStatus.RUNNING)
  })

  test('the end of a job that succeeded closes the row', async ({ assert }) => {
    const job = jobData()

    execute('start', { job: { ...job, acquiredAt: Date.now() }, queue: 'default' })

    await waitFor(() => find(job.id))

    execute('asyncEnd', {
      job: { ...job, acquiredAt: Date.now() },
      queue: 'default',
      status: 'completed',
      duration: 42.5,
    })

    const run = await waitFor(async () => {
      const row = await find(job.id)

      return row?.status === JobRunStatus.COMPLETED ? row : null
    })

    assert.equal(run.duration, 42.5)
    assert.isNotNull(run.finishedAt)
    assert.isNull(run.error)
  })

  test('the end of a job that failed keeps the error and its cause', async ({ assert }) => {
    const job = jobData()
    const error = new Error('Every try fell', { cause: new Error('The host said no') })

    execute('start', { job: { ...job, acquiredAt: Date.now() }, queue: 'default' })

    await waitFor(() => find(job.id))

    execute('asyncEnd', {
      job: { ...job, acquiredAt: Date.now() },
      queue: 'default',
      status: 'failed',
      error,
    })

    const run = await waitFor(async () => {
      const row = await find(job.id)

      return row?.status === JobRunStatus.FAILED ? row : null
    })

    assert.include(run.error, 'Every try fell')
    assert.include(run.error, 'The host said no')
    assert.isNotNull(run.finishedAt)
  })

  test('a job that waits for another try is not finished', async ({ assert }) => {
    const job = jobData()

    execute('start', { job: { ...job, acquiredAt: Date.now() }, queue: 'default' })

    await waitFor(() => find(job.id))

    execute('asyncEnd', {
      job: { ...job, acquiredAt: Date.now() },
      queue: 'default',
      status: 'retrying',
      error: new Error('The host said no'),
    })

    const run = await waitFor(async () => {
      const row = await find(job.id)

      return row?.status === JobRunStatus.RETRYING ? row : null
    })

    assert.isNull(run.finishedAt)
    assert.include(run.error, 'The host said no')
  })
})
