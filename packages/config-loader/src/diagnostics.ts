import { randomUUID } from 'node:crypto'
import type { Context } from '@antarestra/plugin-sdk'
import type { PluginEntry } from './config.js'
import { ManagementError } from './document.js'

const stages = {
  metadata: '插件包解析失败',
  environment: '环境变量读取或转换失败',
  validation: '配置校验失败',
  import: '插件模块导入失败',
  registration: '插件实例注册失败',
} as const
export type LoadStage = keyof typeof stages

const reasons = {
  ERR_PLUGIN_NOT_FOUND: '未找到插件包',
  ERR_PLUGIN_INVALID_EXPORT: '插件导出格式无效',
  ERR_PLUGIN_TIMEOUT: '插件模块导入超时',
  ERR_MODULE_NOT_FOUND: '模块或内部依赖不存在',
  MODULE_NOT_FOUND: '模块或内部依赖不存在',
  ERR_PACKAGE_PATH_NOT_EXPORTED: '包入口未导出',
  ERR_PACKAGE_IMPORT_NOT_DEFINED: '包导入映射未定义',
  ERR_INVALID_PACKAGE_CONFIG: '包配置无效',
  ERR_INVALID_PACKAGE_TARGET: '包导出目标无效',
  ERR_UNKNOWN_FILE_EXTENSION: '模块文件扩展名不受支持',
  ENOENT: '文件不存在',
  EACCES: '文件访问被拒绝',
  EPERM: '文件操作不被允许',
} as const

// 异常的 message、stack、name、自定义 code 均可能包含凭据，不能直接记录。
// 只读取自有数据属性，不执行第三方 getter，也不保留原始异常对象。
function field(value: unknown, key: string): unknown {
  try {
    if (value && typeof value === 'object')
      return Object.getOwnPropertyDescriptor(value, key)?.value
  } catch {
    // Proxy 等不可信异常仍按未知原因报告。
  }
}

function causes(error: unknown) {
  const result: { code: string; type: string }[] = []
  const seen = new Set<unknown>()
  while (error !== undefined && !seen.has(error) && result.length < 8) {
    seen.add(error)
    const code = field(error, 'code')
    const name = field(error, 'name')
    let type = 'Unknown'
    try {
      if (error instanceof SyntaxError) type = 'SyntaxError'
      else if (error instanceof TypeError) type = 'TypeError'
      else if (error instanceof ReferenceError) type = 'ReferenceError'
      else if (error instanceof Error) type = 'Error'
    } catch {
      // 不读取异常文本。
    }
    if (name === 'AbortError') type = 'AbortError'
    result.push({
      code: typeof code === 'string' && Object.hasOwn(reasons, code) ? code : 'UNKNOWN',
      type,
    })
    error = field(error, 'cause')
  }
  return result
}

export class PluginLoadFailure extends ManagementError {}

export function reportLoadFailure(
  ctx: Context,
  entry: PluginEntry,
  stage: LoadStage,
  error: unknown,
): PluginLoadFailure {
  const diagnosticId = randomUUID()
  const chain = causes(error)
  const code = chain.find((item) => item.code !== 'UNKNOWN')?.code ?? 'UNKNOWN'
  const reason = reasons[code as keyof typeof reasons]
  const message = `${stages[stage]}${reason ? `：${reason}` : ''}（诊断编号：${diagnosticId}）`
  ctx
    .logger('config-loader')
    .error(
      '插件加载诊断：%s',
      JSON.stringify({ diagnosticId, instanceId: entry.instanceId, stage, code, causes: chain }),
    )
  return new PluginLoadFailure(400, message)
}
