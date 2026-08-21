import { test } from '@japa/runner'
import { DateTime } from 'luxon'

import PruneJobRuns from '../src/jobs/prune_job_runs.js'
import JobRun, { JobRunStatus } from '../src/models/job_run.js'
import { makeRun, truncate } from './helpers.js'

/** Run the job as the worker runs it, with the number of days that it reads. */
function prune(days: number) {
  const job = new PruneJobRuns()

  job.$hydrate(
    { days },
    {
      jobId: 'the-job',
      name: 'PruneJobRuns',
      attempt: 1,
      queue: 'default',
      priority: 0,
      acquiredAt: new Date(),
      stalledCount: 0,
    }
  )

  return job.execute()
}

test.group('Prune job runs', (group) => {
  group.each.setup(() => truncate())

  test('a job that ended well long ago is taken out', async ({ assert }) => {
    await makeRun({
      status: JobRunStatus.COMPLETED,
      finishedAt: DateTime.now().minus({ days: 8 }),
    })

    await prune(7)

    assert.lengthOf(await JobRun.all(), 0)
  })

  test('a job that ended well today stays', async ({ assert }) => {
    await makeRun({
      status: JobRunStatus.COMPLETED,
      finishedAt: DateTime.now().minus({ hours: 2 }),
    })

    await prune(7)

    assert.lengthOf(await JobRun.all(), 1)
  })

  test('a job that failed is never taken out', async ({ assert }) => {
    await makeRun({
      status: JobRunStatus.FAILED,
      finishedAt: DateTime.now().minus({ days: 30 }),
    })

    await prune(7)

    assert.lengthOf(await JobRun.all(), 1)
  })
})
