import { timingSafeEqual } from 'node:crypto'

import type { Authorize } from '../types.js'

/**
 * Compare the two words in a time that does not change with the number of
 * letters that agree.
 */
function matches(given: string | undefined, expected: string) {
  if (!given) {
    return false
  }

  const a = Buffer.from(given)
  const b = Buffer.from(expected)

  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Read the page with a name and a word, and no session.
 *
 * The page belongs to the team that runs the machine, not to the users of the
 * application. It shows nothing at all while one of the two is missing, thus a
 * machine that carries neither shows nothing.
 */
export function basicAuth(credentials: { user?: string; password?: string }): Authorize {
  return ({ request, response }) => {
    const { user, password } = credentials

    if (!user || !password) {
      return false
    }

    const [scheme, given] = (request.header('authorization') ?? '').split(' ')
    const expected = Buffer.from(`${user}:${password}`).toString('base64')

    if (scheme !== 'Basic' || !matches(given, expected)) {
      response.header('www-authenticate', 'Basic realm="Queue"')
      response.unauthorized({ success: false, error: 'Authentication is required' })

      return false
    }

    return true
  }
}
