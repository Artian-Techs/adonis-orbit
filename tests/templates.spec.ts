import { test } from '@japa/runner'

import edge from 'edge.js'

/** The frame that every page carries. */
const FRAME = {
  path: '/queue',
  logo: '<svg></svg>',
  theme: 'dark',
  favicon: 'data:image/svg+xml;base64,',
  csrfToken: 'a-token',
  menu: [
    { key: 'overview', label: 'Overview', href: '/queue', icon: '<rect/>', count: null },
    { key: 'failed', label: 'Failed', href: '/queue?status=failed', icon: '<circle/>', count: 2 },
  ],
}

test.group('Templates', () => {
  test('the list of the jobs is written', async ({ assert }) => {
    const html = await edge.render('orbit::index', {
      ...FRAME,
      title: 'Overview',
      active: 'overview',
      showStats: true,
      stats: { perMinute: 1, pastHour: 2, failedPastWeek: 3, running: 4 },
      status: '',
      rows: [
        {
          id: 1,
          jobId: 'a-job',
          name: 'SendMail',
          queue: 'mails',
          status: 'failed',
          statusLabel: 'Failed',
          attempts: 3,
          duration: 12.5,
          payload: '{}',
          error: 'The host said no',
          dispatchedAt: '01 Jan 2026 10:00:00',
          finishedAt: '01 Jan 2026 10:00:01',
          retriedAt: null,
          retriedJobId: null,
          retriedStatus: null,
          canRetry: true,
          isSilenced: false,
        },
      ],
      page: 1,
      lastPage: 2,
      total: 60,
    })

    assert.include(html, 'SendMail')
    assert.include(html, 'Jobs per minute')
    assert.include(html, '<link rel="icon" href="data:image/svg+xml;base64,')
    assert.include(html, '<div class="brand"><svg></svg>')
    assert.include(html, '/queue/runs/1/retry')
    assert.include(html, 'Next')
  })

  test('the list of the jobs says when it holds nothing', async ({ assert }) => {
    const html = await edge.render('orbit::index', {
      ...FRAME,
      title: 'Failed',
      active: 'failed',
      showStats: false,
      stats: null,
      status: 'failed',
      rows: [],
      page: 1,
      lastPage: 1,
      total: 0,
    })

    assert.include(html, 'No job yet.')
    assert.notInclude(html, 'Jobs per minute')
  })

  test('the classes that are silenced are written', async ({ assert }) => {
    const html = await edge.render('orbit::silenced', {
      ...FRAME,
      title: 'Silenced jobs',
      active: 'silenced',
      names: ['SendMail'],
    })

    assert.include(html, 'SendMail')
    assert.include(html, 'Show again')
  })

  test('the page of the silenced classes says when it holds nothing', async ({ assert }) => {
    const html = await edge.render('orbit::silenced', {
      ...FRAME,
      title: 'Silenced jobs',
      active: 'silenced',
      names: [],
    })

    assert.include(html, 'No job is silenced.')
  })

  test('what each class and each queue cost is written', async ({ assert }) => {
    const html = await edge.render('orbit::metrics', {
      ...FRAME,
      title: 'Metrics',
      active: 'metrics',
      hours: 24,
      byJob: [{ label: 'SendMail', total: 3, failed: 1, average: 20, longest: 30 }],
      byQueue: [{ label: 'mails', total: 3, failed: 1, average: null, longest: null }],
    })

    assert.include(html, 'SendMail')
    assert.include(html, '20 ms')
    assert.include(html, 'mails')
  })
})
