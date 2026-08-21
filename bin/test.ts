import { assert } from '@japa/assert'
import { configure, processCLIArgs, run } from '@japa/runner'

import { startApp, stopApp } from '../tests/helpers.js'

/**
 * The application starts before the tests are read.
 *
 * The files under test ask the container for the database and the logger as
 * they are imported, thus the container answers first.
 */
await startApp()

processCLIArgs(process.argv.splice(2))

configure({
  files: ['tests/**/*.spec.ts'],
  plugins: [assert()],
  teardown: [stopApp],
})

run()
