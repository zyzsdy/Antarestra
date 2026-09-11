import type { DatabaseScope } from '@antarestra/database'
import type { Tables } from '../fixtures/database.js'

// 仅编译验证，不连接数据库。
export function checkDatabaseTypes(db: DatabaseScope<Tables>): void {
  db.selectFrom('records').select(['id', 'workspace_id'])
  // @ts-expect-error 不存在的表
  db.selectFrom('missing')
  // @ts-expect-error 不存在的字段
  db.selectFrom('records').select('missing')
  // @ts-expect-error 字段值类型必须匹配
  db.updateTable('records').set({ enabled: true })
  // @ts-expect-error 消费入口不能销毁连接
  db.destroy()
  // @ts-expect-error 消费入口不提供原始查询执行器
  db.executeQuery({ sql: 'select 1', parameters: [] })
  // @ts-expect-error Schema 只通过迁移修改
  db.schema.createTable('arbitrary')
}
