import { randomUUID } from 'node:crypto'

import { DateTime } from 'luxon'

import { test } from '@japa/runner'

import JobRun, { JobRunStatus } from '../src/models/job_run.js'
import DatabaseSink from '../src/sinks/database_sink.js'
import type { JobEvent, JobIdentity, JobOutcome } from '../src/types.js'
import { makeRun, truncate } from './helpers.js'

const sink = new DatabaseSink()

function identity(overrides: Partial<JobIdentity> = {}): JobIdentity {
  return {
    id: randomUUID(),
    name: 'SendMail',
    queue: 'default',
    payload: { to: 'someone@example.com' },
    attempts: 1,
    ...overrides,
  }
}

function started(job: JobIdentity, at = new Date()): JobEvent {
  return { type: 'started', at, job }
}

function finished(job: JobIdentity, outcome: JobOutcome, at = new Date()): JobEvent {
  return {
    type: 'finished',
    at,
    job,
    outcome,
    duration: outcome === 'lost' ? null : 12,
    error: outcome === 'completed' ? null : `The job is ${outcome}`,
  }
}

function find(id: string) {
  return JobRun.findByOrFail('jobId', id)
}

test.group('DatabaseSink', (group) => {
  group.each.setup(() => truncate())

  test('the end writes the row when the start did not arrive', async ({ assert }) => {
    const job = identity()

    await sink.write([finished(job, 'completed')])

    const run = await find(job.id)

    assert.equal(run.status, JobRunStatus.COMPLETED)
    assert.equal(run.name, 'SendMail')
    assert.equal(run.attempts, 1)
    assert.equal(run.duration, 12)
    assert.isNotNull(run.finishedAt)
    assert.isNull(run.startedAt)
  })

  test('a start that lands after the end fills the time of the start alone', async ({ assert }) => {
    const job = identity()
    const at = new Date('2026-11-12T04:37:00Z')

    await sink.write([finished(job, 'completed')])
    await sink.write([started(job, at)])

    const run = await find(job.id)

    assert.equal(run.status, JobRunStatus.COMPLETED)
    assert.equal(run.startedAt?.toMillis(), at.getTime())
    assert.equal(run.duration, 12)
    assert.isNotNull(run.finishedAt)
  })

  test('a start that lands after the end keeps the time of the start that the row has', async ({
    assert,
  }) => {
    const first = DateTime.fromISO('2026-11-12T04:37:00Z')
    const run = await makeRun({ status: JobRunStatus.FAILED, startedAt: first })

    await sink.write([started(identity({ id: run.jobId }), new Date('2026-11-12T04:38:00Z'))])

    await run.refresh()

    assert.equal(run.status, JobRunStatus.FAILED)
    assert.equal(run.startedAt?.toMillis(), first.toMillis())
  })

  test('a start takes an open row', async ({ assert }) => {
    const run = await makeRun({
      status: JobRunStatus.RETRYING,
      attempts: 1,
      startedAt: DateTime.fromISO('2026-11-12T04:37:00Z'),
    })
    const at = new Date('2026-11-12T04:38:00Z')

    await sink.write([started(identity({ id: run.jobId, attempts: 2 }), at)])

    await run.refresh()

    assert.equal(run.status, JobRunStatus.RUNNING)
    assert.equal(run.attempts, 2)
    assert.equal(run.startedAt?.toMillis(), at.getTime())
  })

  test('a lost closes an open row', async ({ assert }) => {
    const run = await makeRun({ status: JobRunStatus.RUNNING })

    await sink.write([finished(identity({ id: run.jobId }), 'lost')])

    await run.refresh()

    assert.equal(run.status, JobRunStatus.LOST)
    assert.include(run.error, 'lost')
    assert.isNotNull(run.finishedAt)
  })

  test('a lost changes nothing on a row that has its answer', async ({ assert }) => {
    const run = await makeRun({ status: JobRunStatus.COMPLETED, duration: 12 })

    await sink.write([finished(identity({ id: run.jobId }), 'lost')])

    await run.refresh()

    assert.equal(run.status, JobRunStatus.COMPLETED)
    assert.equal(run.duration, 12)
    assert.isNull(run.error)
  })

  test('the end closes a row that a lost closed first', async ({ assert }) => {
    const run = await makeRun({ status: JobRunStatus.LOST })

    await sink.write([finished(identity({ id: run.jobId }), 'completed')])

    await run.refresh()

    assert.equal(run.status, JobRunStatus.COMPLETED)
    assert.isNull(run.error)
  })
})
