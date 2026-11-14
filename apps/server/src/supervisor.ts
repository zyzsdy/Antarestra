import { spawn } from 'node:child_process'
import { watch, readdirSync, existsSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDocument } from '@antarestra/config-loader'

export function supervise(filename: string, entry: string, development: boolean) {
  let child: ReturnType<typeof spawn> | undefined
  let ready = false
  let stopping = false
  let restarting = false
  let forced = false
  let debounce: ReturnType<typeof setTimeout> | undefined
  const watchers: FSWatcher[] = []
  const wasRaw = process.stdin.isRaw
  const restoreTerminal = () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw)
  }
  process.once('exit', restoreTerminal)
  const closeWatchers = () => {
    clearTimeout(debounce)
    for (const watcher of watchers.splice(0)) watcher.close()
  }
  const finish = (code: number) => {
    stopping = true
    closeWatchers()
    restoreTerminal()
    process.stdin.pause()
    process.exitCode = code
    if (process.connected) process.disconnect?.()
  }
  const terminateTree = () => {
    forced = true
    console.error('再次收到中断，正在强制退出')
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
      finish(130)
      return
    }
    if (process.platform === 'win32') {
      const worker = child
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      killer.once('error', () => worker.kill('SIGKILL'))
      killer.once('exit', (code) => {
        if (code) worker.kill('SIGKILL')
      })
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  }
  const requestShutdown = () => {
    if (ready && child?.connected) child.send({ type: 'shutdown' }, () => {})
  }
  const stop = () => {
    if (stopping) return
    stopping = true
    closeWatchers()
    console.log('正在等待所有插件完成清理，再按一次 Ctrl+C 可强制退出')
    if (!child || child.exitCode !== null || child.signalCode !== null) finish(0)
    else requestShutdown()
  }
  const interrupt = () => {
    if (stopping) terminateTree()
    else stop()
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', stop)
  process.once('disconnect', stop)
  process.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown')
      stop()
  })
  // 终端由监督进程统一读取，避免同一次 Ctrl+C 被终端和包管理器重复转发。
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.on('data', (data: Buffer) => {
      for (const byte of data) if (byte === 3) interrupt()
    })
    process.stdin.resume()
  }
  const launch = () => {
    if (stopping) return
    ready = false
    restarting = false
    child = spawn(process.execPath, [...process.execArgv, entry, ...process.argv.slice(2)], {
      cwd: process.cwd(),
      env: { ...process.env, ANTARESTRA_WORKER: '1' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    child.on('message', (message: unknown) => {
      if (message && typeof message === 'object' && 'type' in message && message.type === 'ready') {
        ready = true
        if (stopping || restarting) requestShutdown()
      }
    })
    child.once('error', () => finish(1))
    child.once('exit', (code) => {
      ready = false
      if (stopping) {
        finish(forced ? 130 : (code ?? 1))
      } else if (restarting) {
        launch()
      } else if (code === 75) {
        void readDocument(filename)
          .then((file) => {
            if (stopping) finish(0)
            else if (file.settings.supervision === 'internal') launch()
            else finish(75)
          })
          .catch(() => finish(1))
      } else if (!development) {
        finish(code ?? 1)
      } else {
        console.log('服务端已退出，等待源码变化后重启')
      }
    })
  }
  if (development) {
    const root = fileURLToPath(new URL('../../../', import.meta.url))
    for (const group of ['packages', 'apps']) {
      for (const directory of readdirSync(join(root, group), { withFileTypes: true })) {
        const source = join(root, group, directory.name, 'src')
        if (!directory.isDirectory() || !existsSync(source)) continue
        const watcher = watch(source, { recursive: true }, (_event, path) => {
          if (stopping || path?.split(/[\\/]/).some((part) => part.startsWith('.'))) return
          clearTimeout(debounce)
          debounce = setTimeout(() => {
            console.log('源码已变化，等待插件清理后重启服务端')
            restarting = true
            if (!child || child.exitCode !== null || child.signalCode !== null) launch()
            else requestShutdown()
          }, 100)
        })
        watcher.on('error', () => {
          console.error('源码监听失败，正在关闭服务端')
          stop()
        })
        watchers.push(watcher)
      }
    }
  }
  launch()
}
