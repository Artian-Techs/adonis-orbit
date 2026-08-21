import { randomUUID } from 'node:crypto'

import { HttpContextFactory, RequestFactory } from '@adonisjs/core/factories/http'
import { Locator } from '@adonisjs/queue'

import { test } from '@japa/runner'
import { DateTime } from 'luxon'

import DashboardController from '../src/controllers/dashboard_controller.js'
import JobRun, { JobRunStatus } from '../src/models/job_run.js'
import SilencedJob from '../src/models/silenced_job.js'
import { makeRun, truncate } from './helpers.js'

/** A job class that answers the dispatch, with no queue behind it. */
class SendMail {
  static dispatches = 0

  static dispatch(_payload: unknown) {
    return {
      toQueue(_queue: string) {
        return {
          async run() {
            SendMail.dispatches += 1

            return { jobId: randomUUID() }
          },
        }
      },
    }
  }
}

/** One request of the page, and the answer that a new controller writes. */
async function visit(action: 'index' | 'silenced' | 'metrics', url = '/queue', cookie?: string) {
  const request = new RequestFactory().merge({ url, method: 'GET' }).create()

  if (cookie) {
    request.request.headers.cookie = cookie
  }

  const ctx = new HttpContextFactory().merge({ request }).create()

  await new DashboardController()[action](ctx)

  return String(ctx.response.getBody())
}

/** One request that changes something, and the answer that follows it. */
async function send(action: 'retry' | 'silence' | 'theme', params: Record<string, unknown>) {
  const request = new RequestFactory().merge({ url: '/queue', method: 'POST' }).create()
  const ctx = new HttpContextFactory().merge({ request }).create()

  ctx.params = params

  await new DashboardController()[action](ctx)

  return ctx.response
}

/** What the side menu says of one status. */
function countOf(html: string, label: string) {
  const found = html.match(new RegExp(`${label}\\s*<span class="count">(\\d+)</span>`))

  return found ? Number(found[1]) : null
}

test.group('Dashboard', (group) => {
  group.each.setup(async () => {
    await truncate()

    SendMail.dispatches = 0
    Locator.register('SendMail', SendMail as never)
  })

  group.each.teardown(() => Locator.clear())

  test('the list shows what the queue did', async ({ assert }) => {
    await makeRun({ name: 'SendMail' })
    await makeRun({ name: 'SendInvoice' })

    const html = await visit('index')

    assert.include(html, 'SendMail')
    assert.include(html, 'SendInvoice')
    assert.include(html, 'Jobs per minute')
  })

  test('the list leaves the silenced classes out', async ({ assert }) => {
    await makeRun({ name: 'SendMail' })
    await makeRun({ name: 'Noisy' })
    await SilencedJob.create({ name: 'Noisy' })

    const html = await visit('index')

    assert.include(html, 'SendMail')
    assert.notInclude(html, 'Noisy')
  })

  test('a status shows the jobs of that status alone', async ({ assert }) => {
    await makeRun({ name: 'SendMail', status: JobRunStatus.FAILED })
    await makeRun({ name: 'SendInvoice', status: JobRunStatus.COMPLETED })

    const html = await visit('index', '/queue?status=failed')

    assert.include(html, 'SendMail')
    assert.notInclude(html, 'SendInvoice')
    assert.notInclude(html, 'Jobs per minute')
  })

  test('the counts of the menu leave the silenced classes out', async ({ assert }) => {
    await makeRun({ name: 'Noisy', status: JobRunStatus.FAILED })
    await makeRun({ name: 'Noisy', status: JobRunStatus.FAILED })
    await makeRun({ name: 'SendMail', status: JobRunStatus.FAILED })
    await SilencedJob.create({ name: 'Noisy' })

    const html = await visit('index')

    assert.equal(countOf(html, 'Failed'), 1)
    assert.equal(countOf(html, 'Completed'), 0)
  })

  test('the page of the silenced classes names them', async ({ assert }) => {
    await SilencedJob.create({ name: 'Noisy' })

    const html = await visit('silenced')

    assert.include(html, 'Noisy')
    assert.include(html, 'Show again')
  })

  test('a class is taken out of the lists, and put back', async ({ assert }) => {
    await send('silence', { name: 'Noisy' })

    assert.isNotNull(await SilencedJob.findBy('name', 'Noisy'))

    await send('silence', { name: 'Noisy' })

    assert.isNull(await SilencedJob.findBy('name', 'Noisy'))
  })

  test('the trace of a silenced class stays in the table', async ({ assert }) => {
    const run = await makeRun({ name: 'Noisy' })

    await send('silence', { name: 'Noisy' })

    assert.isNotNull(await JobRun.find(run.id))
  })

  test('a job that failed is asked again from the page', async ({ assert }) => {
    const run = await makeRun({ status: JobRunStatus.FAILED, name: 'SendMail' })

    const response = await send('retry', { id: run.id })

    await run.refresh()

    assert.equal(SendMail.dispatches, 1)
    assert.equal(response.getStatus(), 302)
    assert.isNotNull(run.retriedJobId)
  })

  test('a row that was asked again leads to the job that answered', async ({ assert }) => {
    const answer = await makeRun({ name: 'SendMail', status: JobRunStatus.COMPLETED })

    await makeRun({
      name: 'SendMail',
      status: JobRunStatus.FAILED,
      retriedJobId: answer.jobId,
      retriedAt: DateTime.now(),
    })

    const html = await visit('index', '/queue?status=failed')

    assert.include(html, `/queue?job=${answer.jobId}`)
    assert.include(html, 'asked again — Completed')
    assert.notInclude(html, '>Retry</button>')
  })

  test('one job answers alone, and the numbers stay out', async ({ assert }) => {
    const wanted = await makeRun({ name: 'SendMail' })

    await makeRun({ name: 'SendInvoice' })

    const html = await visit('index', `/queue?job=${wanted.jobId}`)

    assert.include(html, wanted.jobId)
    assert.notInclude(html, 'SendInvoice')
    assert.notInclude(html, 'Jobs per minute')
  })

  test('a job of a silenced class answers when a person asks for it', async ({ assert }) => {
    const wanted = await makeRun({ name: 'Noisy' })

    await SilencedJob.create({ name: 'Noisy' })

    const html = await visit('index', `/queue?job=${wanted.jobId}`)

    assert.include(html, wanted.jobId)
  })

  test('what each class and each queue cost is counted', async ({ assert }) => {
    const finishedAt = DateTime.now().minus({ minutes: 5 })

    await makeRun({ name: 'SendMail', queue: 'mails', duration: 10, finishedAt })
    await makeRun({ name: 'SendMail', queue: 'mails', duration: 20, finishedAt })
    await makeRun({
      name: 'SendMail',
      queue: 'mails',
      duration: 30,
      finishedAt,
      status: JobRunStatus.FAILED,
    })
    await makeRun({ name: 'SendInvoice', queue: 'default', duration: 5, finishedAt })

    const page = await visit('metrics')
    const html = page.replace(/\s+/g, ' ')

    assert.include(
      html,
      '<td><b>SendMail</b></td> <td>3</td> <td>1</td> <td>20 ms</td> <td>30 ms</td>'
    )
    assert.include(
      html,
      '<td><b>mails</b></td> <td>3</td> <td>1</td> <td>20 ms</td> <td>30 ms</td>'
    )
    assert.include(
      html,
      '<td><b>default</b></td> <td>1</td> <td>0</td> <td>5 ms</td> <td>5 ms</td>'
    )
  })

  test('a job that ended long ago is left out of the counts', async ({ assert }) => {
    await makeRun({ duration: 10, finishedAt: DateTime.now().minus({ days: 2 }) })

    const html = await visit('metrics')

    assert.include(html, 'No job ended in this window.')
  })
})

test.group('Dashboard theme', () => {
  test('a page that nobody chose for carries no mode', async ({ assert }) => {
    const html = await visit('index')

    assert.include(html, '<html lang="en">')
  })

  test('the mode of the cookie is written on the page', async ({ assert }) => {
    const response = await send('theme', { theme: 'light' })
    const cookie = String(response.getHeader('set-cookie')).split(';')[0]

    assert.equal(response.getStatus(), 302)

    const html = await visit('index', '/queue', cookie)

    assert.include(html, '<html lang="en" data-theme="light">')
  })

  test('the dark mode travels the same way', async ({ assert }) => {
    const response = await send('theme', { theme: 'dark' })
    const cookie = String(response.getHeader('set-cookie')).split(';')[0]
    const html = await visit('index', '/queue', cookie)

    assert.include(html, '<html lang="en" data-theme="dark">')
  })

  test('a mode that does not exist answers "not found"', async ({ assert }) => {
    const response = await send('theme', { theme: 'purple' })

    assert.equal(response.getStatus(), 404)
    assert.isUndefined(response.getHeader('set-cookie'))
  })

  test('the two buttons of the mode are written on the page', async ({ assert }) => {
    const html = await visit('index')

    assert.include(html, '/queue/theme/dark')
    assert.include(html, '/queue/theme/light')
  })
})
