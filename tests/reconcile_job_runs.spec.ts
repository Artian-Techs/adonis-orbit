import { test } from '@japa/runner'

import ReconcileJobRuns from '../src/jobs/reconcile_job_runs.js'
import JobRun, { JobRunStatus } from '../src/models/job_run.js'
import { makeRun, truncate } from './helpers.js'

/** Run the job as the worker runs it, with the number of minutes that it reads. */
function reconcile(minutes?: number) {
  const job = new ReconcileJobRuns()

  job.$hydrate(
    { minutes },
    {
      jobId: 'the-job',
      name: 'ReconcileJobRuns',
      attempt: 1,
      queue: 'default',
      priority: 0,
      acquiredAt: new Date(),
      stalledCount: 0,
    }
  )

  return job.execute()
}

test.group('Reconcile job runs job', (group) => {
  group.each.setup(() => truncate())

  /**
   * The queue answers about the rows that stayed open, and about nothing else.
   * A table that holds no open row thus asks the queue nothing, and the job
   * ends even where no queue answers.
   */
  test('a table with no open row leaves the queue alone', async ({ assert }) => {
    await makeRun({ status: JobRunStatus.COMPLETED })
    const run = await makeRun({ status: JobRunStatus.PENDING })

    await reconcile()

    await run.refresh()

    assert.equal(run.status, JobRunStatus.PENDING)
    assert.lengthOf(await JobRun.all(), 2)
  })
})
