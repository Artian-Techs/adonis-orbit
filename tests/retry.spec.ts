import { randomUUID } from 'node:crypto'

import { Locator } from '@adonisjs/queue'

import { test } from '@japa/runner'

import { JobRunStatus } from '../src/models/job_run.js'
import { retryRun } from '../src/retry.js'
import { makeRun, truncate } from './helpers.js'

/** The identifier that the queue gives to the job that answers the request. */
const NEW_JOB = randomUUID()

/** A job class that answers the dispatch, with no queue behind it. */
class SendMail {
  static dispatches: { payload: unknown; queue: string }[] = []

  static dispatch(payload: unknown) {
    return {
      toQueue(queue: string) {
        return {
          async run() {
            SendMail.dispatches.push({ payload, queue })

            return { jobId: NEW_JOB }
          },
        }
      },
    }
  }
}

test.group('Retry', (group) => {
  group.each.setup(async () => {
    await truncate()

    SendMail.dispatches = []
    Locator.register('SendMail', SendMail as never)
  })

  group.each.teardown(() => Locator.clear())

  test('a job that the queue does not know is not asked again', async ({ assert }) => {
    Locator.clear()

    const run = await makeRun({ status: JobRunStatus.FAILED })

    await assert.rejects(() => retryRun(run), 'The job "SendMail" is not registered')
  })

  test('the job is asked again with what it carried', async ({ assert }) => {
    const run = await makeRun({
      status: JobRunStatus.FAILED,
      queue: 'mails',
      payload: { to: 'someone@example.com' },
    })

    const jobId = await retryRun(run)

    assert.equal(jobId, NEW_JOB)
    assert.deepEqual(SendMail.dispatches, [
      { payload: { to: 'someone@example.com' }, queue: 'mails' },
    ])
  })

  test('the row that answered stays where it is, and names the new job', async ({ assert }) => {
    const run = await makeRun({ status: JobRunStatus.FAILED })

    await retryRun(run)
    await run.refresh()

    assert.equal(run.status, JobRunStatus.FAILED)
    assert.equal(run.retriedJobId, NEW_JOB)
    assert.isNotNull(run.retriedAt)
  })
})
