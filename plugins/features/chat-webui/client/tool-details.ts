import type { ContentBlock, Json, RunRecord, ToolImage } from '@antarestra/contracts'

export interface ToolDetail {
  id: string
  name: string
  arguments: Json
  status: string
  result?: Json
  image?: string
  images?: ToolImage[]
  isError: boolean
}

export function mergeToolBlocks(tools: ToolDetail[], blocks: ContentBlock[], executing = false) {
  for (const block of blocks) {
    if (block.type === 'provider-tool') {
      const detail: ToolDetail = {
        id: block.id,
        name: `${block.name}（提供商内置）`,
        arguments: block.result.action ?? {},
        status:
          block.status === 'completed'
            ? '执行完成'
            : block.status === 'failed'
              ? '执行失败'
              : block.status === 'in_progress'
                ? '正在执行'
                : '未返回结果',
        ...(block.status === 'completed' || block.status === 'failed'
          ? { result: block.result }
          : {}),
        isError: block.status === 'failed',
      }
      if (
        block.result.type === 'image_generation_call' &&
        typeof block.result.result === 'string'
      ) {
        const format =
          block.result.output_format === 'jpeg'
            ? 'jpeg'
            : block.result.output_format === 'webp'
              ? 'webp'
              : 'png'
        detail.image = `data:image/${format};base64,${block.result.result}`
        detail.result = { ...block.result, result: '[图片内容见预览]' }
      }
      const index = tools.findIndex((tool) => tool.id === block.id)
      if (index < 0) tools.push(detail)
      else tools[index] = detail
    }
    if (block.type === 'tool-call') {
      const existing = tools.find((tool) => tool.id === block.id)
      if (existing) {
        existing.name = block.name
        existing.arguments = block.arguments
        if (executing && existing.result === undefined) existing.status = '正在执行'
      } else {
        tools.push({
          id: block.id,
          name: block.name,
          arguments: block.arguments,
          status: executing ? '正在执行' : '等待执行',
          isError: false,
        })
      }
    } else if (block.type === 'tool-result') {
      const tool = tools.find((item) => item.id === block.id)
      if (tool) {
        tool.result = block.content
        if (block.images) tool.images = block.images
        tool.isError = block.isError
        tool.status = block.isError ? '执行失败' : '执行完成'
      }
    }
  }
}

export function finishToolDetails(
  tools: ToolDetail[],
  status: RunRecord['status'],
  error: RunRecord['error'],
) {
  for (const tool of tools) {
    if (tool.result !== undefined) continue
    tool.status =
      status === 'failed' ? '调用失败' : status === 'cancelled' ? '已取消' : '未返回结果'
    tool.isError = status === 'failed'
    if (status === 'failed' && error) tool.result = { error: error.message, code: error.code }
  }
}

export function historyToolDetails(
  run?: Pick<RunRecord, 'messages' | 'status' | 'error'>,
): ToolDetail[] {
  const tools: ToolDetail[] = []
  for (const message of run?.messages ?? []) mergeToolBlocks(tools, message.content)
  if (run && run.status !== 'running') finishToolDetails(tools, run.status, run.error)
  return tools
}
