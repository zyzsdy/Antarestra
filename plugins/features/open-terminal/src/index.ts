import type { Context } from '@antarestra/plugin-sdk'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import type { JsonObject } from '@antarestra/ai'
import { TerminalClient } from './client.js'
import type { Config } from './client.js'
export type { Config } from './client.js'

export const name = 'open-terminal'
export const inject = ['ai', 'http']

const path = {
  type: 'string',
  minLength: 1,
  description: '远端文件路径，相对路径从远端服务工作目录解析。',
}
const text = { type: 'string' }
const replacement = {
  type: 'object',
  properties: { oldText: { type: 'string', minLength: 1 }, newText: text },
  required: ['oldText', 'newText'],
  additionalProperties: false,
}
function parameters(properties: JsonObject, required: string[]): JsonObject {
  return { type: 'object', properties, required, additionalProperties: false }
}

export function apply(ctx: Context, input: Config) {
  const config = schemaConfig<Config>(new URL('../config.schema.json', import.meta.url), input)
  const terminal = new TerminalClient(ctx, config)
  const definitions = [
    {
      id: 'bash',
      description:
        '在共享的远端 Open Terminal 中执行 Bash 命令，返回合并输出、退出码和完整输出文件路径。不超过 200 行时完整返回；超过时只返回前 100 行和后 100 行，中间明确提示截断及远端路径，使用 read 按路径分段读取完整输出。超长行另按 48 KiB 总预算裁剪。所有工作空间共用终端和文件；每次启动独立 Bash，cd、export 不跨调用保留。timeout 为可选秒数，不传则不限命令执行时间；取消会终止远端进程。',
      parameters: parameters(
        {
          command: { type: 'string', minLength: 1 },
          timeout: { type: 'number', exclusiveMinimum: 0, maximum: 86400 },
        },
        ['command'],
      ),
    },
    {
      id: 'read',
      description:
        '读取共享远端文件。文本最多返回 2000 行或 50 KiB；offset 从 1 开始，limit 指定最多行数，根据返回提示继续读取。支持 PNG、JPEG、GIF、WebP 图片（最多 8 MiB），图片通过当前会话的附件服务交给模型。',
      parameters: parameters(
        {
          path,
          offset: { type: 'integer', minimum: 1, maximum: 2147483647 },
          limit: { type: 'integer', minimum: 1, maximum: 2147483647 },
        },
        ['path'],
      ),
    },
    {
      id: 'write',
      description:
        '向共享远端文件写入 UTF-8 文本，覆盖已有内容，自动创建父目录。path 为远端路径，content 为完整文本。',
      parameters: parameters({ path, content: text }, ['path', 'content']),
    },
    {
      id: 'edit',
      description:
        '在共享远端精确编辑 UTF-8 文件。使用 edits 数组一次提交多处 oldText/newText 替换；每项必须在原文件中唯一匹配，且各项不能重叠，全部校验成功后才写入。也支持单次 oldText/newText。保留 BOM 和 CRLF 换行，返回差异；不进行模糊匹配。',
      parameters: {
        ...parameters(
          {
            path,
            edits: { type: 'array', minItems: 1, items: replacement },
            oldText: { type: 'string', minLength: 1 },
            newText: text,
          },
          ['path'],
        ),
        oneOf: [
          {
            required: ['edits'],
            not: { anyOf: [{ required: ['oldText'] }, { required: ['newText'] }] },
          },
          { required: ['oldText', 'newText'], not: { required: ['edits'] } },
        ],
      },
    },
  ]
  for (const definition of definitions) {
    ctx.ai.registerTool(ctx, {
      ...definition,
      resultMode: 'structured',
      timeoutMs: null,
      execute: (args, context) => terminal.execute(definition.id, args, context),
    })
  }
}
