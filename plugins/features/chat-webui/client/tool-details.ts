import type { ContentBlock, Json, RunRecord } from '@antarestra/contracts'

export interface ToolDetail {
  id: string
  name: string
  arguments: Json
  status: string
  result?: Json
  isError: boolean
}

export function mergeToolBlocks(tools: ToolDetail[], blocks: ContentBlock[], executing = false) {
  for (const block of blocks) {
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

export function historyToolDetails(run?: RunRecord): ToolDetail[] {
  const tools: ToolDetail[] = []
  for (const message of run?.messages ?? []) mergeToolBlocks(tools, message.content)
  if (run && run.status !== 'running') finishToolDetails(tools, run.status, run.error)
  return tools
}
