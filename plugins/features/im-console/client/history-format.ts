import type { MessageSegment } from '@antarestra/im'

export const formatTime = (time: number | null) =>
  time === null ? '暂无记录' : new Date(time).toLocaleString('zh-CN', { hour12: false })
export const jobStates = {
  queued: '等待处理',
  running: '处理中',
  completed: '已完成',
  failed: '处理失败',
  cancelled: '已取消',
}
export const deliveryStates = {
  pending: '等待投递',
  sent: '已投递',
  failed: '投递失败',
  unknown: '投递结果未知',
}
export function segmentText(segment: MessageSegment) {
  if (segment.type === 'text') return segment.text
  if (segment.type === 'mention') return `@${segment.userId}`
  if (segment.type === 'reply') return `[引用消息 ${segment.messageId}]`
  if (segment.type === 'unsupported') return `[${segment.name}]`
  const labels = { image: '图片', video: '视频', audio: '音频', file: '文件' }
  return `[${labels[segment.type]}${segment.name ? `：${segment.name}` : ''}]`
}
