import { appendFile, access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

export async function apply(ctx, config) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  ctx.effect(() => async () => {
    await appendFile(config.events, `清理开始:${process.pid}\n`)
    while (
      !(await access(config.release).then(
        () => true,
        () => false,
      ))
    )
      await delay(25)
    const exited = once(child, 'exit')
    child.kill()
    await exited
    await appendFile(config.events, `清理完成:${process.pid}\n`)
  })
  await appendFile(config.events, `就绪:${process.pid}:${child.pid}\n`)
}
