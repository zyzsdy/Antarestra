export const proxyError =
  '代理服务器需为无账号密码、路径、查询参数及片段的 HTTP、HTTPS 或 SOCKS5 地址'

/** 前后端共用地址校验，避免保存不能使用的代理。 */
export function normalizeProxy(value: string): string {
  const proxy = value.trim()
  if (!proxy) return ''
  try {
    const url = new URL(proxy)
    if (
      proxy.length > 2000 ||
      /[\s\x00-\x1f]/.test(proxy) ||
      !['http:', 'https:', 'socks5:', 'socks:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      (url.pathname && url.pathname !== '/') ||
      url.search ||
      url.hash
    )
      throw new Error()
    return url.href
  } catch {
    throw new Error(proxyError)
  }
}
