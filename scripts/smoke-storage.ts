import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, basename } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  PutBucketCorsCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'
import { Context } from '@antarestra/plugin-sdk'
import DatabaseProvider from '@antarestra/database'
import * as database from '@antarestra/plugin-database-kysely'
import Server from '@antarestra/plugin-server'
import rbac from '@antarestra/rbac'
import WebUI from '@antarestra/webui'
import local from '@antarestra/plugin-auth-local'
import Storage from '@antarestra/storage'
import * as s3 from '@antarestra/plugin-storage-s3'
import files from '@antarestra/plugin-workspace-file'
import * as admin from '@antarestra/plugin-admin-console'
import type { UploadPlan, UploadedPart } from '@antarestra/storage'
const preview = process.env.STORAGE_PREVIEW === '1'
const directory = await mkdtemp(join(tmpdir(), 'antarestra-storage-'))
const bucket = 'antarestra-smoke-' + randomUUID()
const config = {
  endpoint: 'http://127.0.0.1:19000',
  region: 'us-east-1',
  bucket,
  accessKeyId: process.env.ANTARESTRA_S3_ACCESS_KEY ?? '',
  secretAccessKey: process.env.ANTARESTRA_S3_SECRET_KEY ?? '',
  multipartThreshold: 5 * 1024 * 1024,
  partSize: 5 * 1024 * 1024,
}
const backend = new s3.S3Backend(config)
const ctx = new Context()
const password = preview ? 'storage-preview-password-42' : randomBytes(24).toString('hex')
try {
  await backend.client.send(new CreateBucketCommand({ Bucket: bucket }))
  await backend.client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: ['*'],
            AllowedMethods: ['PUT', 'GET', 'HEAD'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag'],
          },
        ],
      },
    }),
  )
  await ctx.plugin(DatabaseProvider)
  await ctx.plugin(database, { filename: join(directory, 'metadata.sqlite') })
  await ctx.plugin(Server, { host: '127.0.0.1', port: preview ? 14459 : 0 })
  await ctx.plugin(rbac)
  await ctx.plugin(WebUI)
  await ctx.plugin(Storage)
  await ctx.plugin(s3, config)
  await ctx.plugin(admin)
  await ctx.plugin(local, {
    providerId: 'local',
    allowRegistration: true,
    bootstrapEmail: 'storage-test@example.com',
    bootstrapPassword: password,
  })
  let fiber = await ctx.plugin(files, { backendId: 's3', defaultQuota: 20 * 1024 * 1024 })
  const origin = `http://127.0.0.1:${ctx.server.address!.port}`
  const request = (path: string, cookie = '', body?: object, method = 'POST') =>
    fetch(origin + '/api' + path, {
      method: body ? method : 'GET',
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  const login = await request('/auth/local/local/login', '', {
    email: 'storage-test@example.com',
    password,
  })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const other = await request('/auth/local/local/register', '', {
    email: 'other@example.com',
    displayName: '隔离用户',
    password,
  })
  assert.equal(other.status, 201)
  const otherLogin = await request('/auth/local/local/login', '', {
    email: 'other@example.com',
    password,
  })
  const otherCookie = otherLogin.headers.get('set-cookie')!.split(';')[0]!
  async function upload(
    path: string,
    bytes: Buffer,
    contentType = 'application/octet-stream',
    disposition = 'attachment',
  ) {
    const started = await request('/workspace-files/uploads', cookie, { path, size: bytes.length })
    assert.equal(started.status, 200, await started.clone().text())
    const ticket = (await started.json()) as { token: string; plan: UploadPlan }
    const parts: UploadedPart[] = []
    for (const part of ticket.plan.parts) {
      const response = await fetch(part.url, {
        method: 'PUT',
        headers: ticket.plan.headers,
        body: new Uint8Array(bytes.subarray(part.offset, part.offset + part.size)),
      })
      assert.equal(response.status, 200, await response.clone().text())
      parts.push({ number: part.number, etag: response.headers.get('etag')! })
    }
    const complete = await request(`/workspace-files/uploads/${ticket.token}/complete`, cookie, {
      parts,
    })
    assert.equal(complete.status, 200, await complete.clone().text())
    assert.equal(
      (await request(`/workspace-files/uploads/${ticket.token}/complete`, cookie, { parts }))
        .status,
      200,
    )
    const download = await request(
      '/workspace-files/download?path=' + encodeURIComponent(path),
      cookie,
    )
    const { url } = (await download.json()) as { url: string }
    const response = await fetch(url, { headers: { Origin: 'https://images.example.com' } })
    assert.equal(response.headers.get('content-type'), contentType)
    assert.ok(response.headers.get('content-disposition')?.startsWith(disposition + ';'))
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
    const stored = await backend.client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: new URL(url).pathname.split('/').slice(2).join('/'),
      }),
    )
    assert.equal(stored.ContentType, contentType)
    assert.equal(stored.ContentDisposition, disposition)
    if (ticket.plan.parts.length === 1) {
      const replay = await fetch(ticket.plan.parts[0]!.url, {
        method: 'PUT',
        headers: ticket.plan.headers,
        body: Buffer.alloc(bytes.length, 120),
      })
      assert.equal(replay.status, 412, '直传凭证必须拒绝覆盖临时对象')
      assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), bytes)
    }
    assert.equal(
      (await request(`/workspace-files/uploads/${ticket.token}/complete`, otherCookie, { parts }))
        .status,
      404,
    )
    assert.equal(
      (await request('/workspace-files/download?path=' + encodeURIComponent(path), otherCookie))
        .status,
      404,
    )
    return ticket
  }
  await upload(
    '/upload/2026-09-29/中文说明.txt',
    Buffer.from('这是来自真实 RustFS 的文件。'),
    'text/plain',
    'inline',
  )
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDaYAAAAASUVORK5CYII=',
    'base64',
  )
  await upload('/图片.png', image, 'image/png', 'inline')
  await upload('/页面.html', Buffer.from('<script>alert(1)</script>'), 'text/html')
  await upload(
    '/矢量.svg',
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    'image/svg+xml',
  )
  await upload(
    '/分片图片.png',
    Buffer.concat([image, Buffer.alloc(6 * 1024 * 1024)]),
    'image/png',
    'inline',
  )
  const multipart = await upload(
    '/upload/2026-09-29/分片数据.bin',
    Buffer.alloc(6 * 1024 * 1024, 37),
  )
  assert.equal(multipart.plan.parts.length, 2)
  const zero = await upload('/empty.txt', Buffer.alloc(0), 'text/plain', 'inline')
  assert.equal(zero.plan.parts.length, 1)
  const listed = await backend.client.send(new ListObjectsV2Command({ Bucket: bucket }))
  for (const object of listed.Contents ?? []) {
    assert.match(object.Key!, /^(uploads|objects)\/[a-f\d-]{36}$/)
    const head = await backend.client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: object.Key! }),
    )
    assert.deepEqual(head.Metadata, {})
  }
  await fiber.dispose()
  fiber = await ctx.plugin(files, { backendId: 's3', defaultQuota: 20 * 1024 * 1024 })
  const restored = await request('/workspace-files?path=/upload/2026-09-29', cookie)
  assert.equal((await restored.json()).entries.length, 2)
  assert.equal((await request('/workspace-file-admin', otherCookie)).status, 403)
  console.log(
    'RustFS + 磁盘 SQLite 验证通过：任意 Origin CORS、图片与文本内联、HTML/SVG 附件、原始类型、直传、零字节、分片、内容下载、重复完成、不可覆盖、随机键、跨空间拒绝、插件重载。',
  )
  if (preview) {
    console.log(
      '浏览器预览：http://127.0.0.1:14459/auth/user/；测试账号 storage-test@example.com，密码由脚本的预览分支固定，仅用于隔离临时环境。',
    )
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
  }
} finally {
  await ctx.fiber.dispose()
  const objects = await backend.client
    .send(new ListObjectsV2Command({ Bucket: bucket }))
    .catch(() => undefined)
  if (objects?.Contents?.length)
    await backend.client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: objects.Contents.map((o) => ({ Key: o.Key! })) },
      }),
    )
  await backend.client.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => {})
  backend.close()
  assert.equal(resolve(dirname(directory)), resolve(tmpdir()))
  assert.ok(basename(directory).startsWith('antarestra-storage-'))
  await rm(directory, { recursive: true, force: true })
}
