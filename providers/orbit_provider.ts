import type { ApplicationService } from '@adonisjs/core/types'
import { Locator } from '@adonisjs/queue'

import edge from 'edge.js'

import PruneJobRuns from '../src/jobs/prune_job_runs.js'
import type { OrbitConfig } from '../src/types.js'

const DEFAULTS: OrbitConfig = { path: '/queue', authorize: () => false, sinks: [] }

/**
 * Watch what the queue does, and keep it.
 *
 * The provider listens to the channels of the queue, writes each job in the
 * table, and opens the page that reads it. The application gives it a path and
 * the two words that guard the page, and nothing else.
 */
export default class OrbitProvider {
  constructor(protected app: ApplicationService) {}

  async boot() {
    const config = this.app.config.get<OrbitConfig>('orbit', DEFAULTS)

    /**
     * The page of Orbit lives with Orbit, thus the application carries no
     * view for it.
     */
    edge.mount('orbit', new URL('../templates/', import.meta.url))

    /**
     * The application looks for its jobs in its own folders, and this one
     * lives here. It names itself to the queue.
     */
    Locator.register(PruneJobRuns.name, PruneJobRuns)

    const { recordJobRuns } = await import('../src/recorder.js')
    recordJobRuns(config)

    const router = await this.app.container.make('router')
    const { registerRoutes } = await import('../src/routes.js')

    registerRoutes(router, config)
  }
}
