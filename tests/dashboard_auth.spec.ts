import { HttpContextFactory, RequestFactory } from '@adonisjs/core/factories/http'
import type { HttpContext } from '@adonisjs/core/http'

import { test } from '@japa/runner'

import { basicAuth } from '../src/auth/basic_auth.js'
import { dashboardAuth } from '../src/middleware/dashboard_auth.js'
import type { Authorize } from '../src/types.js'

/** A request that carries the word of Basic auth, or none. */
function context(credentials?: string) {
  const request = new RequestFactory().create()

  if (credentials) {
    request.request.headers.authorization = credentials
  }

  return new HttpContextFactory().merge({ request }).create()
}

function basic(user: string, password: string) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
}

/** Read the page, and say whether it opened. */
async function pass(ctx: HttpContext, authorize: Authorize) {
  let opened = false

  await dashboardAuth({ path: '/queue', authorize, sinks: [] })(ctx, async () => {
    opened = true
  })

  return opened
}

const GUARD = basicAuth({ user: 'team', password: 'secret' })

test.group('Dashboard auth', () => {
  test('a page with no name answers "not found"', async ({ assert }) => {
    const ctx = context(basic('team', 'secret'))

    assert.isFalse(await pass(ctx, basicAuth({ password: 'secret' })))
    assert.equal(ctx.response.getStatus(), 404)
  })

  test('a page with no word answers "not found"', async ({ assert }) => {
    const ctx = context(basic('team', 'secret'))

    assert.isFalse(await pass(ctx, basicAuth({ user: 'team' })))
    assert.equal(ctx.response.getStatus(), 404)
  })

  test('a request with no word is asked for one', async ({ assert }) => {
    const ctx = context()

    assert.isFalse(await pass(ctx, GUARD))
    assert.equal(ctx.response.getStatus(), 401)
    assert.equal(ctx.response.getHeader('www-authenticate'), 'Basic realm="Queue"')
  })

  test('another scheme than Basic is turned away', async ({ assert }) => {
    const ctx = context('Bearer a-token')

    assert.isFalse(await pass(ctx, GUARD))
    assert.equal(ctx.response.getStatus(), 401)
  })

  test('a word that does not agree is turned away', async ({ assert }) => {
    const ctx = context(basic('team', 'another'))

    assert.isFalse(await pass(ctx, GUARD))
    assert.equal(ctx.response.getStatus(), 401)
  })

  test('a word of another length is turned away', async ({ assert }) => {
    const ctx = context(basic('team', 'a'))

    assert.isFalse(await pass(ctx, GUARD))
    assert.equal(ctx.response.getStatus(), 401)
  })

  test('the two words that agree open the page', async ({ assert }) => {
    const ctx = context(basic('team', 'secret'))

    assert.isTrue(await pass(ctx, GUARD))
  })

  test('a guard of the application opens the page', async ({ assert }) => {
    assert.isTrue(await pass(context(), () => true))
  })

  test('a guard that reads the request answers on what it reads', async ({ assert }) => {
    const guard: Authorize = ({ request }) => request.header('x-team') === 'the-one'
    const ctx = context()

    ctx.request.request.headers['x-team'] = 'the-one'

    assert.isTrue(await pass(ctx, guard))
    assert.isFalse(await pass(context(), guard))
  })

  test('a guard that says no and writes nothing hides the page', async ({ assert }) => {
    const ctx = context()

    assert.isFalse(await pass(ctx, () => false))
    assert.equal(ctx.response.getStatus(), 404)
  })

  test('a guard that writes its own answer keeps it', async ({ assert }) => {
    const ctx = context()

    const guard: Authorize = ({ response }) => {
      response.forbidden({ error: 'This team may not read the page' })

      return false
    }

    assert.isFalse(await pass(ctx, guard))
    assert.equal(ctx.response.getStatus(), 403)
  })

  test('a guard that takes its time is waited for', async ({ assert }) => {
    const guard: Authorize = async () => true

    assert.isTrue(await pass(context(), guard))
  })
})
