import { readFileSync } from 'node:fs'

/** 保留浏览器原生系统标识，使用真实 Chromium 版本并追加应用标识。 */
export function browserUserAgent(nativeUserAgent: string, browserVersion: string): string {
  // 从应用根清单读取版本，源码和 dist 的目录层级一致。
  const { version } = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
  const chromeVersion = browserVersion.replace(/^.*\//, '')
  return `${nativeUserAgent.replace(/(?:HeadlessChrome|Chrome)\/[\d.]+/g, `Chrome/${chromeVersion}`)} Anta/${version}`
}
