/** 处理时长按完整秒显示，时钟偏差不产生负数。 */
export function formatProcessingTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours) return `${hours}小时${minutes % 60}分${seconds % 60}秒`
  if (minutes) return `${minutes}分${seconds % 60}秒`
  return `${seconds}秒`
}
