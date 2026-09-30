import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
} from '@aws-sdk/client-s3'
const bucket = 'antarestra-dev'
const client = new S3Client({
  endpoint: 'http://127.0.0.1:19000',
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.ANTARESTRA_S3_ACCESS_KEY ?? '',
    secretAccessKey: process.env.ANTARESTRA_S3_SECRET_KEY ?? '',
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
})
try {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }))
  } catch (error) {
    if (error.$metadata?.httpStatusCode !== 404) throw error
    await client.send(new CreateBucketCommand({ Bucket: bucket }))
  }
  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: ['*'],
            AllowedMethods: ['PUT', 'GET', 'HEAD'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 300,
          },
        ],
      },
    }),
  )
  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: 'temporary-uploads',
            Status: 'Enabled',
            Filter: { Prefix: 'uploads/' },
            Expiration: { Days: 1 },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
          },
        ],
      },
    }),
  )
  console.log('已初始化本地 antarestra-dev 私有桶、浏览器 CORS 和临时上传生命周期。')
} finally {
  client.destroy()
}
