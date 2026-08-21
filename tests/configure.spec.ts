import { access } from 'node:fs/promises'
import { join } from 'node:path'

import type Configure from '@adonisjs/core/commands/configure'

import { test } from '@japa/runner'

import { configure } from '../configure.js'
import { stubsRoot } from '../stubs/main.js'

interface Written {
  providers: string[]
  stubs: { name: string; data: Record<string, unknown> }[]
  variables: Record<string, unknown>
  validations: Record<string, string>
  comment?: string
}

/**
 * Run the configure step, and hold what it asks the application to write.
 *
 * The codemods belong to the framework and they are read elsewhere. What this
 * package answers for is the list below: the provider, the stubs, and the two
 * variables of the environment.
 */
async function run() {
  const written: Written = { providers: [], stubs: [], variables: {}, validations: {} }

  const codemods = {
    updateRcFile(update: (rcFile: { addProvider(name: string): void }) => void) {
      update({ addProvider: (name) => written.providers.push(name) })
    },

    makeUsingStub(_root: string, name: string, data: Record<string, unknown>) {
      written.stubs.push({ name, data })
    },

    defineEnvVariables(variables: Record<string, unknown>) {
      written.variables = variables
    },

    defineEnvValidations(options: { variables: Record<string, string>; leadingComment: string }) {
      written.validations = options.variables
      written.comment = options.leadingComment
    },
  }

  await configure({ createCodemods: async () => codemods } as unknown as Configure)

  return written
}

/** The name of the file that one stub carries, if it names one. */
function fileNameOf(stub: { data: Record<string, unknown> }) {
  const migration = stub.data.migration as { folder: string; fileName: string } | undefined

  return migration?.fileName ?? null
}

test.group('Configure', () => {
  test('the provider is written in adonisrc.ts', async ({ assert }) => {
    const written = await run()

    assert.deepEqual(written.providers, ['@artian-techs/adonis-orbit/orbit_provider'])
  })

  test('the configuration and the two migrations are published', async ({ assert }) => {
    const written = await run()

    assert.deepEqual(
      written.stubs.map((stub) => stub.name),
      [
        'config/orbit.stub',
        'migrations/create_job_runs_table.stub',
        'migrations/create_silenced_jobs_table.stub',
      ]
    )
  })

  test('every stub that the configure step names is on the disk', async ({ assert }) => {
    const written = await run()

    for (const stub of written.stubs) {
      await assert.doesNotReject(() => access(join(stubsRoot, stub.name)))
    }
  })

  test('the two migrations take a folder and two names of their own', async ({ assert }) => {
    const written = await run()

    const [jobRuns, silencedJobs] = written.stubs.slice(1)

    assert.equal((jobRuns.data.migration as { folder: string }).folder, 'database/migrations')
    assert.match(fileNameOf(jobRuns)!, /^\d+_create_job_runs_table\.ts$/)
    assert.match(fileNameOf(silencedJobs)!, /^\d+_create_silenced_jobs_table\.ts$/)

    /**
     * Two migrations of the same moment take the same name, and the second one
     * writes over the first.
     */
    assert.notEqual(fileNameOf(jobRuns), fileNameOf(silencedJobs))
  })

  test('the two variables of the environment are written, and left empty', async ({ assert }) => {
    const written = await run()

    assert.deepEqual(written.variables, {
      ORBIT_DASHBOARD_USER: '',
      ORBIT_DASHBOARD_PASSWORD: '',
    })
  })

  test('the two variables are read by the validation of the environment', async ({ assert }) => {
    const written = await run()

    assert.deepEqual(written.validations, {
      ORBIT_DASHBOARD_USER: 'Env.schema.string.optional()',
      ORBIT_DASHBOARD_PASSWORD: 'Env.schema.string.optional()',
    })
    assert.isString(written.comment)
  })
})
