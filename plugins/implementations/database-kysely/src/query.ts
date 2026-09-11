import { OperationNodeTransformer, TableNode } from 'kysely'
import type { OperationNode, QueryId, ReferenceNode, KyselyPlugin, Kysely } from 'kysely'
import type { Queries } from '@antarestra/database'
import { identifier, namespace, physicalName } from './names.js'

/** 引用中的别名不加前缀；嵌套查询使用词法作用域，允许关联外层表。 */
class NamespaceTransformer extends OperationNodeTransformer {
  private readonly scopes: Map<string, boolean>[] = []

  constructor(private readonly pluginId: string) {
    super()
  }

  protected override transformNodeImpl<T extends OperationNode>(node: T, queryId?: QueryId): T {
    if (
      !['SelectQueryNode', 'InsertQueryNode', 'UpdateQueryNode', 'DeleteQueryNode'].includes(
        node.kind,
      )
    ) {
      return super.transformNodeImpl(node, queryId)
    }
    const scope = new Map<string, boolean>()
    const collect = (value: unknown): void => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) {
        value.forEach(collect)
        return
      }
      const record = value as Record<string, unknown>
      if (record.kind === 'TableNode') {
        const table = value as TableNode
        scope.set(table.table.identifier.name, true)
      } else if (record.kind === 'AliasNode') {
        const alias = record.alias as { kind?: string; name?: string }
        if (alias.kind === 'IdentifierNode' && alias.name) scope.set(alias.name, false)
      } else if (record.kind === 'FromNode') collect(record.froms)
      else if (record.kind === 'JoinNode') collect(record.table)
      else if (record.kind === 'UsingNode') collect(record.tables)
    }
    const record = node as unknown as Record<string, unknown>
    for (const key of ['from', 'into', 'table', 'joins', 'using']) collect(record[key])
    if (record.with) throw new Error('首版数据库查询不支持 CTE')
    this.scopes.push(scope)
    try {
      return super.transformNodeImpl(node, queryId)
    } finally {
      this.scopes.pop()
    }
  }

  protected override transformTable(node: TableNode): TableNode {
    if (node.table.schema) throw new Error('查询不能指定数据库 schema')
    const name = node.table.identifier.name
    const prefix = `${namespace(this.pluginId)}_`
    // 独立构建后嵌入的子查询可能已经经过同一个命名空间转换。
    if (name.startsWith(prefix)) {
      identifier(name.slice(prefix.length))
      return node
    }
    return TableNode.create(physicalName(this.pluginId, name))
  }

  protected override transformReference(node: ReferenceNode, queryId?: QueryId): ReferenceNode {
    if (!node.table) return super.transformReference(node, queryId)
    const name = node.table.table.identifier.name
    let physical = true
    for (const scope of [...this.scopes].reverse()) {
      if (scope.has(name)) {
        physical = scope.get(name)!
        break
      }
    }
    return {
      ...node,
      column: this.transformNode(node.column, queryId),
      table: physical ? this.transformTable(node.table) : node.table,
    }
  }
}

export function queryPlugin(pluginId: string, assertActive: () => void): KyselyPlugin {
  return {
    transformQuery({ node }) {
      assertActive()
      return new NamespaceTransformer(pluginId).transformNode(node)
    },
    async transformResult({ result }) {
      return result
    },
  }
}

export function queries<Tables>(db: Kysely<Tables>, assertActive: () => void): Queries<Tables> {
  const guarded = <T extends (...args: never[]) => unknown>(fn: T): T =>
    new Proxy(fn, {
      apply(target, thisArg, args: unknown[]) {
        assertActive()
        return Reflect.apply(target, thisArg, args)
      },
    })
  return {
    selectFrom: guarded(db.selectFrom.bind(db)),
    insertInto: guarded(db.insertInto.bind(db)),
    updateTable: guarded(db.updateTable.bind(db)),
    deleteFrom: guarded(db.deleteFrom.bind(db)),
  }
}
