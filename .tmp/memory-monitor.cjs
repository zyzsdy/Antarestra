// 通过 NODE_OPTIONS 加载到启动器、服务及其 Node 子进程，不输出参数或环境变量。
const { appendFileSync } = require('node:fs')
const { join, basename } = require('node:path')
const { getHeapStatistics } = require('node:v8')
const { PerformanceObserver, constants } = require('node:perf_hooks')
const { threadId } = require('node:worker_threads')

const directory = process.env.ANTARESTRA_MEMORY_LOG_DIR
if (directory) {
  const file = join(directory, `memory-${process.pid}-${threadId}.jsonl`)
  const interval = Number(process.env.ANTARESTRA_MEMORY_INTERVAL_MS) || 30000
  let gcCount = 0
  let majorGcCount = 0
  let gcDurationMs = 0
  let failed = false
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcCount++
      gcDurationMs += entry.duration
      if (entry.detail.kind === constants.NODE_PERFORMANCE_GC_MAJOR) majorGcCount++
    }
  })
  observer.observe({ entryTypes: ['gc'] })

  function sample(event, exitCode) {
    if (failed) return
    try {
      const resources = Object.create(null)
      for (const name of process.getActiveResourcesInfo()) {
        resources[name] = (resources[name] || 0) + 1
      }
      const heap = getHeapStatistics()
      appendFileSync(file, JSON.stringify({
        timestamp: new Date().toISOString(),
        event,
        pid: process.pid,
        parentPid: process.ppid,
        threadId,
        entry: process.argv[1] ? basename(process.argv[1]) : 'eval',
        worker: process.env.ANTARESTRA_WORKER === '1',
        nodeVersion: process.version,
        uptimeSeconds: process.uptime(),
        // 内存单位均为字节；GC 时长为毫秒，计数和时长均为累计值。
        ...process.memoryUsage(),
        heapSizeLimit: heap.heap_size_limit,
        nativeContexts: heap.number_of_native_contexts,
        detachedContexts: heap.number_of_detached_contexts,
        gcCount,
        majorGcCount,
        gcDurationMs,
        activeResources: resources,
        ...(exitCode === undefined ? {} : { exitCode }),
      }) + '\n')
    } catch {
      failed = true
      observer.disconnect()
      console.error(`[内存监测] PID ${process.pid} 写入失败，已停用采样，请检查目录权限和磁盘空间。`)
    }
  }

  sample('start')
  const timer = setInterval(() => sample('sample'), interval)
  timer.unref()
  process.once('exit', (code) => {
    clearInterval(timer)
    observer.disconnect()
    sample('exit', code)
  })
}
