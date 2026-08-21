import { test } from '@japa/runner'

import { defineConfig } from '../src/define_config.js'

test.group('Define config', () => {
  test('the configuration travels as the application wrote it', ({ assert }) => {
    const config = { path: '/queue', authorize: () => true, sinks: [] }

    assert.deepEqual(defineConfig(config), config)
  })
})
