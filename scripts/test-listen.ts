import { randomInt } from 'node:crypto'
import type { Server } from 'node:net'

/** 避免 Windows 自定义动态端口范围分配到 Fetch/Chromium 禁用的端口。 */
export async function listenForTest(server: Server): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = randomInt(20000, 60000)
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error)
        server.once('error', onError)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', onError)
          resolve()
        })
      })
      return port
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
      // 并发测试或本地服务占用时另选端口，不修改系统动态端口配置。
    }
  }
  throw new Error('未能分配可供浏览器访问的测试端口')
}
