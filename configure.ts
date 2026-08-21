import type Configure from '@adonisjs/core/commands/configure'

import { stubsRoot } from './stubs/main.js'

/**
 * Put Orbit in an application.
 *
 * The table belongs to the application, thus the migration is published there
 * and read like the others.
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods()

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@artian-techs/adonis-orbit/orbit_provider')
  })

  await codemods.makeUsingStub(stubsRoot, 'config/orbit.stub', {})

  const now = new Date().getTime()

  await codemods.makeUsingStub(stubsRoot, 'migrations/create_job_runs_table.stub', {
    migration: {
      folder: 'database/migrations',
      fileName: `${now}_create_job_runs_table.ts`,
    },
  })

  await codemods.makeUsingStub(stubsRoot, 'migrations/create_silenced_jobs_table.stub', {
    migration: {
      folder: 'database/migrations',
      fileName: `${now + 1}_create_silenced_jobs_table.ts`,
    },
  })

  await codemods.defineEnvVariables({
    ORBIT_DASHBOARD_USER: '',
    ORBIT_DASHBOARD_PASSWORD: '',
  })

  await codemods.defineEnvValidations({
    variables: {
      ORBIT_DASHBOARD_USER: 'Env.schema.string.optional()',
      ORBIT_DASHBOARD_PASSWORD: 'Env.schema.string.optional()',
    },
    leadingComment: 'Variables for the page of the queue',
  })
}
