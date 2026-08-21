import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { setTimeout as wait } from 'node:timers/promises'

import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor'
import type { ApplicationService } from '@adonisjs/core/types'
import { defineConfig as defineDatabaseConfig } from '@adonisjs/lucid'
import type { BaseSchema } from '@adonisjs/lucid/schema'
import type { ModelAttributes } from '@adonisjs/lucid/types/model'

import edge from 'edge.js'

import JobRun, { JobRunStatus } from '../src/models/job_run.js'

const APP_ROOT = new URL('../', import.meta.url)
const TEMPLATES = new URL('../templates/', import.meta.url)
const MIGRATIONS = new URL('../stubs/migrations/', import.meta.url)
const TMP = new URL('./tmp/', import.meta.url)

/** The tables that the two migrations of the package create. */
const TABLES = ['job_runs', 'silenced_jobs']

/** The two migrations, in the order that the configure step publishes them. */
const SCHEMAS = ['create_job_runs_table', 'create_silenced_jobs_table']

let app: ApplicationService

/**
 * Where the tests read and write.
 *
 * The package writes SQL that PostgreSQL answers: `on conflict`, `filter`, and
 * a `jsonb` column. The tests thus ask for a PostgreSQL server, and the
 * environment names it.
 */
function connection() {
  return {
    client: 'pg' as const,
    connection: {
      host: process.env.PG_HOST ?? '127.0.0.1',
      port: Number(process.env.PG_PORT ?? 5432),
      user: process.env.PG_USER ?? 'postgres',
      password: process.env.PG_PASSWORD ?? 'postgres',
      database: process.env.PG_DATABASE ?? 'orbit_test',
    },
  }
}

/**
 * Read one migration of the package as a class.
 *
 * The stub carries a header that names where the file goes. The rest is the
 * migration itself, thus the header is taken away and the rest is written as a
 * file that Node imports. The tests read the tables that an application gets.
 */
async function readSchema(name: string) {
  const stub = await readFile(new URL(`${name}.stub`, MIGRATIONS), 'utf-8')

  await mkdir(TMP, { recursive: true })
  await writeFile(new URL(`${name}.ts`, TMP), stub.replace(/^\{\{\{[\s\S]*?\}\}\}\s*/, ''))

  /**
   * The file is read as TypeScript, and the name that Node reads ends in
   * `.js`, as every import of the package does.
   */
  const file = new URL(`${name}.js`, TMP)

  const { default: Schema } = (await import(file.href)) as { default: typeof BaseSchema }

  return Schema
}

/** Create the two tables of the package. */
async function migrate() {
  const { default: db } = await import('@adonisjs/lucid/services/db')

  for (const table of TABLES) {
    await db.connection().schema.dropTableIfExists(table)
  }

  for (const name of SCHEMAS) {
    const Schema = await readSchema(name)

    await new Schema(db.connection(), `${name}.ts`, false).execUp()
  }
}

/** The application that the tests run against. */
export function getApp() {
  return app
}

/**
 * Start an application that carries what the package asks for.
 *
 * The package reads the database, the logger and the configuration from the
 * container. The tests thus boot an application with Lucid, and mount the
 * templates as the provider does.
 */
export async function startApp() {
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: { providers: [() => import('@adonisjs/lucid/database_provider')] },
      config: {
        database: defineDatabaseConfig({
          connection: 'primary',
          connections: { primary: connection() },
        }),
        orbit: { path: '/queue', auth: {} },
      },
    })
    .create(APP_ROOT)

  app = ignitor.createApp('web')

  await app.init()
  await app.boot()

  edge.mount('orbit', TEMPLATES)

  await migrate()
}

/** Take away the tables, the files of the migrations, and the connection. */
export async function stopApp() {
  const { default: db } = await import('@adonisjs/lucid/services/db')

  for (const table of TABLES) {
    await db.connection().schema.dropTableIfExists(table)
  }

  await db.manager.closeAll()
  await rm(TMP, { recursive: true, force: true })
  await app.terminate()
}

/** Empty the two tables, and count the rows of the next test from one. */
export async function truncate() {
  const { default: db } = await import('@adonisjs/lucid/services/db')

  await db.rawQuery(`truncate ${TABLES.join(', ')} restart identity`)
}

/**
 * Wait for a value that another task writes.
 *
 * The recorder answers the channel of the queue at once and writes the row
 * apart, thus the test reads the table again until the row is there.
 */
export async function waitFor<T>(read: () => Promise<T | null>, timeout = 5000) {
  const until = Date.now() + timeout

  while (Date.now() < until) {
    const value = await read()

    if (value) {
      return value
    }

    await wait(25)
  }

  throw new Error('The value did not arrive in time')
}

/** One row of the table, with a value for everything the test does not name. */
export function makeRun(values: Partial<ModelAttributes<JobRun>> = {}) {
  return JobRun.create({
    jobId: randomUUID(),
    name: 'SendMail',
    queue: 'default',
    status: JobRunStatus.COMPLETED,
    payload: {},
    attempts: 1,
    ...values,
  })
}

/** Leave the writes of the recorder the time to land. */
export function settle() {
  return wait(250)
}
