function redact(value: string) {
  return value
    .replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
      try {
        return `${new URL(value).origin}/[已隐藏下载地址]`
      } catch {
        return '[已隐藏下载地址]'
      }
    })
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [已隐藏]')
    .replace(
      /\b(authorization|access[_-]?token|api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi,
      '$1=[已隐藏]',
    )
    .replace(/[\r\n\t]/g, ' ')
    .slice(0, 500)
}

/** 只提取错误原因链和诊断字段，不展开请求、响应、堆栈或连接配置。 */
export function describeArchiveError(error: unknown): string {
  const reasons: string[] = []
  const seen = new Set<unknown>()
  while (error !== undefined && error !== null && reasons.length < 5 && !seen.has(error)) {
    seen.add(error)
    if (typeof error !== 'object') {
      reasons.push(redact(String(error)))
      break
    }
    const detail = error as Record<string, unknown>
    const fields = ['name', 'message', 'code', 'status', 'statusCode']
      .flatMap((key) => {
        const value = detail[key]
        return typeof value === 'string' || typeof value === 'number'
          ? [`${key}=${redact(String(value))}`]
          : []
      })
      .join('，')
    reasons.push(fields || '未提供错误信息')
    error = detail.cause
  }
  return reasons.join('；原因：') || '未提供错误信息'
}
