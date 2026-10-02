import { access, constants } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import { Browser, ChromeReleaseChannel, computeSystemExecutablePath } from '@puppeteer/browsers'

export async function findExecutable(executablePath?: string): Promise<string> {
  if (executablePath) {
    const path = resolve(executablePath)
    await access(path, constants.X_OK)
    return path
  }
  // 优先使用 Puppeteer 官方维护的各平台 Chrome 安装位置。
  for (const channel of Object.values(ChromeReleaseChannel)) {
    try {
      return computeSystemExecutablePath({ browser: Browser.CHROME, channel })
    } catch {
      // 继续检查其他渠道与系统 Chromium。
    }
  }
  const candidates =
    process.platform === 'darwin'
      ? ['/Applications/Chromium.app/Contents/MacOS/Chromium']
      : process.platform === 'win32'
        ? [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]
            .filter((value): value is string => !!value)
            .map((root) => join(root, 'Chromium', 'Application', 'chrome.exe'))
        : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']
  const names =
    process.platform === 'win32'
      ? ['chrome.exe', 'chromium.exe']
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) candidates.push(join(directory, name))
  }
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK)
      return path
    } catch {
      // 不存在或不可执行时检查下一个位置。
    }
  }
  throw new Error('未找到 Chrome/Chromium，请安装浏览器或配置 executablePath')
}
