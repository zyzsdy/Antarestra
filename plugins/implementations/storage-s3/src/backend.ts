import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { fileResponse } from '@antarestra/storage'
import type {
  BlobUpload,
  DownloadResponse,
  StorageBackend,
  UploadedPart,
  UploadPlan,
} from '@antarestra/storage'
export interface Config {
  id?: string
  endpoint: string
  publicEndpoint?: string
  region?: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle?: boolean
  multipartThreshold?: number
  partSize?: number
}
const missing = (error: unknown) =>
  error instanceof Error && ['NotFound', 'NoSuchKey', 'NoSuchUpload'].includes(error.name)
export class S3Backend implements StorageBackend {
  readonly client: S3Client
  private readonly publicClient: S3Client
  private readonly partSize: number
  constructor(private readonly config: Config) {
    for (const field of ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'] as const)
      if (!config[field]) throw new Error(`S3 配置缺少 ${field}`)
    for (const endpoint of [config.endpoint, config.publicEndpoint].filter(Boolean)) {
      const url = new URL(endpoint!)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('S3 endpoint 必须是 HTTP(S) 地址')
    }
    this.partSize = config.partSize ?? 8 * 1024 * 1024
    if (!Number.isSafeInteger(this.partSize) || this.partSize < 5 * 1024 * 1024)
      throw new Error('S3 分片至少为 5 MiB')
    const options = {
      region: config.region ?? 'us-east-1',
      forcePathStyle: config.forcePathStyle ?? true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    }
    this.client = new S3Client({ ...options, endpoint: config.endpoint })
    this.publicClient = new S3Client({
      ...options,
      endpoint: config.publicEndpoint ?? config.endpoint,
    })
  }
  close() {
    this.client.destroy()
    this.publicClient.destroy()
  }
  private object(key: string) {
    return { Bucket: this.config.bucket, Key: key }
  }
  async begin(upload: BlobUpload): Promise<BlobUpload> {
    if (upload.size < (this.config.multipartThreshold ?? 16 * 1024 * 1024)) return upload
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        ...this.object(upload.stagingKey),
        ContentType: fileResponse(upload.contentType).contentType,
      }),
    )
    if (!result.UploadId) throw new Error('S3 未返回分片标识')
    return { ...upload, multipartId: result.UploadId }
  }
  async plan(upload: BlobUpload): Promise<UploadPlan> {
    const expiresIn = Math.min(3600, Math.floor((upload.expiresAt - Date.now()) / 1000))
    if (expiresIn < 1) throw new Error('上传凭证已过期')
    const count = upload.multipartId ? Math.ceil(upload.size / this.partSize) : 1
    if (count > 10000) throw new Error('文件超过分片上限')
    const parts: UploadPlan['parts'] = []
    for (let index = 0; index < count; index++) {
      const offset = upload.multipartId ? index * this.partSize : 0
      const size = upload.multipartId ? Math.min(this.partSize, upload.size - offset) : upload.size
      const command = upload.multipartId
        ? new UploadPartCommand({
            ...this.object(upload.stagingKey),
            UploadId: upload.multipartId,
            PartNumber: index + 1,
            ContentLength: size,
          })
        : new PutObjectCommand({
            ...this.object(upload.stagingKey),
            ContentLength: size,
            IfNoneMatch: '*',
            ContentType: fileResponse(upload.contentType).contentType,
          })
      const url =
        command instanceof UploadPartCommand
          ? await getSignedUrl(this.publicClient, command, { expiresIn })
          : await getSignedUrl(this.publicClient, command, { expiresIn })
      parts.push({ number: index + 1, offset, size, url })
    }
    return {
      driver: 's3',
      parts,
      headers: upload.multipartId
        ? {}
        : { 'If-None-Match': '*', 'Content-Type': fileResponse(upload.contentType).contentType },
    }
  }
  private async head(key: string) {
    try {
      return await this.client.send(new HeadObjectCommand(this.object(key)))
    } catch (error) {
      if (missing(error)) return
      throw error
    }
  }
  async complete(upload: BlobUpload, parts: UploadedPart[]) {
    const existing = await this.head(upload.key)
    if (existing) {
      if (existing.ContentLength !== upload.size) throw new Error('已封存对象大小不匹配')
      return
    }
    if (upload.multipartId && !(await this.head(upload.stagingKey))) {
      const count = Math.ceil(upload.size / this.partSize)
      if (
        parts.length !== count ||
        parts.some((p, i) => p.number !== i + 1 || !/^"?[a-f\d]{32}(?:-\d+)?"?$/i.test(p.etag))
      )
        throw new Error('分片清单无效')
      await this.client.send(
        new CompleteMultipartUploadCommand({
          ...this.object(upload.stagingKey),
          UploadId: upload.multipartId,
          MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.number, ETag: p.etag })) },
        }),
      )
    }
    const source = await this.head(upload.stagingKey)
    if (!source || source.ContentLength !== upload.size || !source.ETag)
      throw new Error('上传对象不存在或大小不匹配')
    await this.client.send(
      new CopyObjectCommand({
        ...this.object(upload.key),
        CopySource: `${this.config.bucket}/${upload.stagingKey}`,
        CopySourceIfMatch: source.ETag,
        MetadataDirective: 'REPLACE',
        ContentType: fileResponse(upload.contentType).contentType,
        ContentDisposition: fileResponse(upload.contentType).contentDisposition,
      }),
    )
    if ((await this.head(upload.key))?.ContentLength !== upload.size)
      throw new Error('封存对象核验失败')
  }
  async discard(upload: BlobUpload) {
    if (upload.multipartId) {
      try {
        await this.client.send(
          new AbortMultipartUploadCommand({
            ...this.object(upload.stagingKey),
            UploadId: upload.multipartId,
          }),
        )
      } catch (error) {
        if (!missing(error)) throw error
      }
    }
    await this.remove(upload.stagingKey)
  }
  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand(this.object(key)))
  }
  download(key: string, response?: DownloadResponse) {
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        ...this.object(key),
        ...(response
          ? {
              ResponseContentDisposition: response.contentDisposition,
              ...(response.contentType
                ? { ResponseContentType: fileResponse(response.contentType).contentType }
                : {}),
            }
          : {}),
      }),
      { expiresIn: 60 },
    )
  }
  async read(key: string) {
    const value = await this.client.send(new GetObjectCommand(this.object(key)))
    if (!value.Body) throw new Error('对象内容不存在')
    return value.Body.transformToByteArray()
  }
  async exists(key: string) {
    return !!(await this.head(key))
  }
}
