import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

import { Locator } from '@adonisjs/queue'

import { DateTime } from 'luxon'
import pg from 'pg'

import { basicAuth } from '../src/auth/basic_auth.js'
import JobRun, { JobRunStatus } from '../src/models/job_run.js'
import SilencedJob from '../src/models/silenced_job.js'
import { registerRoutes } from '../src/routes.js'
import type { OrbitConfig } from '../src/types.js'
import { getApp, startApp } from '../tests/helpers.js'

const PORT = Number(process.env.PORT ?? 3333)

/**
 * The preview reads a database of its own.
 *
 * The tests take their tables away when they end, thus a preview that reads
 * the same database answers with an error after the first `pnpm test`.
 */
process.env.PG_DATABASE ??= 'orbit_preview'

/** Make the database of the preview, once. */
async function makeDatabase() {
  const name = process.env.PG_DATABASE!

  const client = new pg.Client({
    host: process.env.PG_HOST ?? '127.0.0.1',
    port: Number(process.env.PG_PORT ?? 5432),
    user: process.env.PG_USER ?? 'postgres',
    password: process.env.PG_PASSWORD ?? 'postgres',
    database: 'postgres',
  })

  await client.connect()

  const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [name])

  if (rowCount === 0) {
    await client.query(`create database "${name}"`)
  }

  await client.end()
}

const CREDENTIALS = {
  user: process.env.ORBIT_DASHBOARD_USER ?? 'orbit',
  password: process.env.ORBIT_DASHBOARD_PASSWORD ?? 'orbit',
}

const CONFIG: OrbitConfig = {
  path: '/queue',
  authorize: basicAuth(CREDENTIALS),
  sinks: [],
}

/** A job class that answers the button, with no queue behind it. */
class SendMail {
  static dispatch() {
    return {
      toQueue() {
        return {
          async run() {
            return { jobId: randomUUID() }
          },
        }
      },
    }
  }
}

const ERROR = `Error: The host said no
    at SendMail.execute (app/jobs/send_mail.ts:24:11)
    at Worker.run (node_modules/@boringnode/queue/build/index.js:1204:7)
Caused by: Error: connect ETIMEDOUT 10.0.0.4:587`

/** What a row carries when the queue lets the job go and says nothing. */
const LOST = 'The queue does not hold this job any more. No worker said how it ended.'

/** The statuses of a job that a worker will not take again. */
const ENDED: string[] = [JobRunStatus.COMPLETED, JobRunStatus.FAILED, JobRunStatus.LOST]

/** Jobs of every status, and of two queues, to read on the page. */
async function seed() {
  const now = DateTime.now()

  const rows = [
    { name: 'SendMail', queue: 'mails', status: JobRunStatus.COMPLETED, duration: 128.4 },
    { name: 'SendMail', queue: 'mails', status: JobRunStatus.COMPLETED, duration: 96.1 },
    { name: 'SendMail', queue: 'mails', status: JobRunStatus.FAILED, duration: 5012.7 },
    { name: 'BuildInvoice', queue: 'default', status: JobRunStatus.COMPLETED, duration: 842.5 },
    { name: 'BuildInvoice', queue: 'default', status: JobRunStatus.RETRYING, duration: 311 },
    { name: 'SyncCatalog', queue: 'default', status: JobRunStatus.RUNNING, duration: null },
    { name: 'SyncCatalog', queue: 'default', status: JobRunStatus.PENDING, duration: null },
    { name: 'HeartBeat', queue: 'default', status: JobRunStatus.COMPLETED, duration: 3.2 },
    { name: 'SendMail', queue: 'mails', status: JobRunStatus.LOST, duration: null },
  ]

  for (const [index, row] of rows.entries()) {
    const ended = ENDED.includes(row.status)

    await JobRun.create({
      ...row,
      jobId: randomUUID(),
      attempts: row.status === JobRunStatus.FAILED ? 3 : 1,
      payload: { to: 'someone@example.com', subject: 'Your order', tries: index },
      error:
        row.status === JobRunStatus.FAILED ? ERROR : row.status === JobRunStatus.LOST ? LOST : null,
      dispatchedAt: now.minus({ minutes: index * 7 + 2 }),
      startedAt: row.status === JobRunStatus.PENDING ? null : now.minus({ minutes: index * 7 + 1 }),
      finishedAt: ended ? now.minus({ minutes: index * 7 }) : null,
    })
  }

  /** A job that a person asked again, and the job that answered. */
  const answer = await JobRun.create({
    jobId: randomUUID(),
    name: 'BuildInvoice',
    queue: 'default',
    status: JobRunStatus.COMPLETED,
    attempts: 1,
    payload: { invoice: 4471 },
    duration: 764.2,
    dispatchedAt: now.minus({ minutes: 30 }),
    startedAt: now.minus({ minutes: 30 }),
    finishedAt: now.minus({ minutes: 29 }),
  })

  await JobRun.create({
    jobId: randomUUID(),
    name: 'BuildInvoice',
    queue: 'default',
    status: JobRunStatus.FAILED,
    attempts: 3,
    payload: { invoice: 4471 },
    duration: 2104.9,
    error: ERROR,
    dispatchedAt: now.minus({ hours: 2 }),
    startedAt: now.minus({ hours: 2 }),
    finishedAt: now.minus({ hours: 2 }),
    retriedAt: now.minus({ minutes: 31 }),
    retriedJobId: answer.jobId,
  })

  await SilencedJob.create({ name: 'HeartBeat' })
}

await makeDatabase()
await startApp()
await seed()

Locator.register('SendMail', SendMail as never)

const app = getApp()
const router = await app.container.make('router')
const server = await app.container.make('server')

registerRoutes(router, CONFIG)

const node = createServer(server.handle.bind(server))

server.setNodeServer(node)
await server.boot()

node.listen(PORT, () => {
  const { user, password } = CREDENTIALS

  console.log(`The page reads on http://localhost:${PORT}${CONFIG.path}`)
  console.log(`The name is "${user}", and the word is "${password}".`)
})
