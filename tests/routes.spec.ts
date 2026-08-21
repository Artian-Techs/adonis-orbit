import { test } from '@japa/runner'

import { registerRoutes } from '../src/routes.js'
import { getApp } from './helpers.js'

test.group('Routes', () => {
  test('the addresses of the page live under the path of the application', async ({ assert }) => {
    const router = await getApp().container.make('router')

    registerRoutes(router, {
      path: '/jobs',
      authorize: () => true,
      sinks: [],
    })
    router.commit()

    assert.equal(router.makeUrl('orbit.index'), '/jobs')
    assert.equal(router.makeUrl('orbit.silenced'), '/jobs/silenced')
    assert.equal(router.makeUrl('orbit.metrics'), '/jobs/metrics')
    assert.equal(router.makeUrl('orbit.retry', { id: 12 }), '/jobs/runs/12/retry')
    assert.equal(
      router.makeUrl('orbit.silence', { name: 'SendMail' }),
      '/jobs/jobs/SendMail/silence'
    )
  })
})
