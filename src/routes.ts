import type { HttpRouterService } from '@adonisjs/core/types'

import { dashboardAuth } from './middleware/dashboard_auth.js'
import type { OrbitConfig } from './types.js'

const DashboardController = () => import('./controllers/dashboard_controller.js')

/**
 * The addresses of the page: the lists, the button that asks for a job again,
 * the button that silences a class, and the mode that a person reads in. They
 * live under the path that the application chose.
 */
export function registerRoutes(router: HttpRouterService, config: OrbitConfig) {
  router
    .group(() => {
      router.get('/', [DashboardController, 'index']).as('orbit.index')
      router.get('/silenced', [DashboardController, 'silenced']).as('orbit.silenced')
      router.get('/metrics', [DashboardController, 'metrics']).as('orbit.metrics')
      router.post('/runs/:id/retry', [DashboardController, 'retry']).as('orbit.retry')
      router.post('/jobs/:name/silence', [DashboardController, 'silence']).as('orbit.silence')
      router.post('/theme/:theme', [DashboardController, 'theme']).as('orbit.theme')
      router.post('/per-page/:count', [DashboardController, 'perPage']).as('orbit.perPage')
    })
    .prefix(config.path)
    .use(dashboardAuth(config))
}
