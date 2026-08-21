import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

import type { OrbitConfig } from '../types.js'

/**
 * Ask the guard of the configuration who may read the page.
 *
 * A guard that says `false` and writes nothing leaves the page as a page that
 * does not exist: a machine that guards nothing shows nothing.
 */
export function dashboardAuth(config: OrbitConfig) {
  return async (ctx: HttpContext, next: NextFn) => {
    if (await config.authorize(ctx)) {
      return next()
    }

    if (!ctx.response.hasContent) {
      ctx.response.notFound({ success: false, error: 'Not found' })
    }
  }
}
