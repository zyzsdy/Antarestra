import { Context } from '@antarestra/plugin-sdk'
import DatabaseProvider, { defineDatabasePlugin } from '@antarestra/database'
import * as implementation from '@antarestra/plugin-database-kysely'
import type { Config } from '@antarestra/plugin-database-kysely'
import { initial, interrupted } from './database.js'

const ctx = new Context()
try {
  const config = JSON.parse(process.env.ANTARESTRA_TEST_CONFIG ?? '{}') as Config
  await ctx.use(DatabaseProvider)
  await ctx.use(implementation, config)
  await ctx.use(
    defineDatabasePlugin({
      name: process.env.ANTARESTRA_TEST_PLUGIN!,
      migrations: [process.env.ANTARESTRA_TEST_INTERRUPT ? interrupted : initial],
      apply() {},
    }),
  )
  process.stdout.write('迁移完成\n')
} finally {
  await ctx.fiber.dispose()
}
