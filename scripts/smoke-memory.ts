import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Context } from '@antarestra/plugin-sdk'
import DatabaseProvider from '@antarestra/database'
import * as database from '@antarestra/plugin-database-kysely'
import Server from '@antarestra/plugin-server'
import rbac from '@antarestra/rbac'
import ai from '@antarestra/ai'
import * as memory from '@antarestra/plugin-memory'

// 不启用 development 导出：检查构建产物，测试连接必须指向独立 PostgreSQL。
const url = process.env.ANTARESTRA_TEST_POSTGRES
assert(url, '请设置 ANTARESTRA_TEST_POSTGRES 指向独立测试 PostgreSQL')
const ctx = new Context()
try {
  await ctx.plugin(DatabaseProvider)
  await ctx.plugin(database, { type: 'postgresql', url })
  await ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(rbac)
  await ctx.plugin(ai, {})
  await ctx.plugin(memory, { globalTokenBudget: 4096 })
  const workspaceId = randomUUID()
  ctx.rbac.registerRequestSource(ctx, 'memory-smoke-stable', {
    id: 'memory-smoke-stable',
    resolve: async () => ({ actorId: 'smoke', workspaceId, roles: ['user'] }),
  })
  const access = await ctx.ai.authorize('memory-smoke-stable', {})
  const catalog = await ctx.ai.catalog(access)
  for (const id of [
    'global_memory',
    'memory_create',
    'memory_read',
    'memory_update',
    'memory_forget',
    'memory_search',
    'memory_link',
  ])
    assert(
      catalog.tools.some((tool) => tool.id === id),
      `工具未注册：${id}`,
    )
  assert(ctx.memory, '记忆服务未就绪')
  console.log('记忆编译产物、PostgreSQL 迁移和七个工具注册检查通过')
} finally {
  await ctx.fiber.dispose()
}
