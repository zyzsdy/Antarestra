import { Readable } from 'node:stream'
import type Koa from 'koa'

// Koa 的 pipeline 会在流报错时先销毁响应，导致未发送响应头也无法返回 500。
// 在这里保留背压和断连清理，把失败交回最外层错误处理。
export async function sendStream(ctx: Koa.Context): Promise<void> {
  if (ctx.respond === false || ctx.method === 'HEAD' || [204, 205, 304].includes(ctx.status)) return
  const body: unknown = ctx.body
  let stream: Readable
  if (body instanceof Readable) stream = body
  else if (body instanceof Blob) stream = Readable.from(body.stream())
  else if (body instanceof ReadableStream) stream = Readable.from(body)
  else return
  ctx.respond = false
  await new Promise<void>((resolve, reject) => {
    let ended = false
    const failed = (error: Error) => {
      stream.unpipe(ctx.res)
      reject(error)
    }
    const complete = () => {
      stream.unpipe(ctx.res)
      stream.destroy()
      resolve()
    }
    stream.once('error', failed)
    stream.once('end', () => {
      ended = true
    })
    stream.once('close', () => {
      if (!ended && !ctx.res.destroyed && !ctx.res.writableEnded)
        failed(new Error('响应流提前关闭'))
    })
    ctx.res.once('close', complete)
    stream.pipe(ctx.res)
  })
}
