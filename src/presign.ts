import { AwsClient } from 'aws4fetch'

type PresignEnv = {
  R2_ACCOUNT_ID: string
  R2_BUCKET_NAME: string
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
}

// Mint a short-lived presigned PUT URL so the browser can upload the file
// bytes straight to R2 — bypassing the Worker request-body limit (~100 MB on
// Free/Pro) and the Worker CPU/duration cost of streaming a large file.
//
// Requires an R2 S3-API token (Access Key ID + Secret) set as Worker secrets.
// Create one at: Cloudflare dashboard → R2 → Manage R2 API Tokens.
export async function presignPutUrl(
  env: PresignEnv,
  key: string,
  expiresSeconds = 300,
): Promise<string> {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  })

  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`
  const url = new URL(endpoint)
  url.searchParams.set('X-Amz-Expires', String(expiresSeconds))

  const signed = await client.sign(url.toString(), {
    method: 'PUT',
    aws: { signQuery: true },
  })
  return signed.url
}
