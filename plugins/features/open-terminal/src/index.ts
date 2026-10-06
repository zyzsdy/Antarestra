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
  properties: {
    oldText: {
      type: 'string',
      minLength: 1,
      description: '原文件中能唯一定位待修改位置的完整片段，须精确匹配。',
    },
    newText: { ...text, description: '替换后的文本；空字符串表示删除匹配片段。' },
  },
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
        '在共享远端终端执行 Bash 命令，适合运行程序、检索文件和处理数据。所有工作空间共用此终端和文件；每次调用的 cd、export 不会保留到下次，需在命令中明确工作目录和环境变量。返回输出、退出码及完整输出文件路径：不超过 200 行时返回全文，超过时仅返回前 100 行和后 100 行，另受 48 KiB 上限限制。遇到截断时用 read 按返回路径分段读取。timeout 单位为秒，省略则不设命令时限；取消会终止远端进程。',
      parameters: parameters(
        {
          command: {
            type: 'string',
            minLength: 1,
            description: '要执行的 Bash 命令；含空格的路径须正确加引号。',
          },
          timeout: {
            type: 'number',
            exclusiveMinimum: 0,
            maximum: 86400,
            description: '最长执行秒数，省略则不限时。',
          },
        },
        ['command'],
      ),
    },
    {
      id: 'read',
      description:
        '读取 bash、write、edit 使用的共享远端文件，或查看 bash 保存的完整输出。文本每次最多返回 2000 行或 50 KiB；按返回提示调整 offset 继续读取，单行超出上限时用 bash 分段读取该行。也可查看 PNG、JPEG、GIF、WebP 图片，最多 8 MiB，需模型支持图片输入。工作空间附件或资源 ID 使用 workspace_file_read。',
      parameters: parameters(
        {
          path,
          offset: {
            type: 'integer',
            minimum: 1,
            maximum: 2147483647,
            description: '文本起始行号，从 1 开始，默认 1。',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 2147483647,
            description: '期望读取的文本行数，默认且最多 2000 行，实际还受字节上限限制。',
          },
        },
        ['path'],
      ),
    },
    {
      id: 'write',
      description:
        '在共享远端创建或完整重写 UTF-8 文本文件，父目录不存在时会自动创建。content 会覆盖已有全部内容；修改现有文件前先用 read 查看，只改局部内容时优先用 edit。',
      parameters: parameters(
        { path, content: { ...text, description: '写入文件的完整文本；空字符串会清空文件。' } },
        ['path', 'content'],
      ),
    },
    {
      id: 'edit',
      description:
        '局部修改共享远端的 UTF-8 文件。先用 read 获取当前内容，再用 oldText/newText 提交一次替换，或用 edits 提交多处替换，两种形式不能混用。每个 oldText 必须在同一份原文件中精确且唯一匹配，各处不能重叠；可增加上下文消除重复匹配。newText 为空表示删除。全部匹配成功才写入，否则文件保持原样；保留原文件 BOM 和 CRLF 换行，并返回修改差异。',
      parameters: {
        ...parameters(
          {
            path,
            edits: {
              type: 'array',
              minItems: 1,
              items: replacement,
              description: '多处替换，均针对修改前的原文件；不要同时填写顶层 oldText/newText。',
            },
            oldText: {
              type: 'string',
              minLength: 1,
              description: '单次替换的原文片段，须在当前文件中精确且唯一匹配。',
            },
            newText: { ...text, description: '单次替换的新文本；空字符串表示删除。' },
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
