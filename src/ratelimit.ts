// Per-IP daily caps on doc uploads, backed by KV. The Cloudflare rate-limit
// binding only supports 10s/60s windows (good for burst control), so the
// longer "N per day / M bytes per day" abuse caps live here.
//
// KV is eventually consistent, so these caps are approximate under a burst of
// concurrent uploads from one IP. That's fine: they exist to bound abuse, not
// to bill anyone to the byte. The 60s burst binding stops the concurrent case.

type DailyQuota = { count: number; bytes: number }

const DAY_TTL_SECONDS = 60 * 60 * 48 // keep a day's counter ~2 days, then expire

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10) // UTC YYYY-MM-DD
}

function quotaKey(tag: string, day = utcDay()): string {
  return `quota:${day}:${tag}`
}

// Stable, non-reversible-ish tag for the uploader's IP. Stored in metadata so a
// later delete can verify "same person who uploaded" before refunding quota,
// without persisting the raw IP. (SHA-256 of an IP isn't strong anonymisation —
// the input space is small — but the tag is never returned to clients.)
export async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(`docshare:${ip}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function quotaKeyForIp(ip: string): Promise<string> {
  return quotaKey(await hashIp(ip))
}

// Give back one upload's worth of daily quota when the uploader deletes a file
// they uploaded *today*. Refusing cross-day / cross-IP refunds stops someone
// farming quota by deleting old or other people's files. Best-effort.
export async function refundDaily(
  kv: KVNamespace,
  ip: string,
  size: number,
  uploadedAt: number,
  uploaderTag: string | undefined,
): Promise<void> {
  if (!Number.isFinite(uploadedAt) || uploadedAt <= 0) return
  if (utcDay(new Date(uploadedAt)) !== utcDay()) return // only today's counter is live
  if (!uploaderTag || (await hashIp(ip)) !== uploaderTag) return // only the original uploader

  await refundChargedDaily(kv, ip, size)
}

// Undo a quota charge from the same request/IP after a later upload step fails.
export async function refundChargedDaily(
  kv: KVNamespace,
  ip: string,
  size: number,
): Promise<void> {
  const cur = await readQuota(kv, ip)
  const next: DailyQuota = {
    count: Math.max(0, cur.count - 1),
    bytes: Math.max(0, cur.bytes - nonNegativeNumber(size)),
  }
  await kv.put(await quotaKeyForIp(ip), JSON.stringify(next), { expirationTtl: DAY_TTL_SECONDS })
}

async function readQuota(kv: KVNamespace, ip: string): Promise<DailyQuota> {
  const raw = await kv.get(await quotaKeyForIp(ip))
  if (!raw) return { count: 0, bytes: 0 }
  try {
    const parsed = JSON.parse(raw) as DailyQuota
    return {
      count: nonNegativeNumber(parsed.count),
      bytes: nonNegativeNumber(parsed.bytes),
    }
  } catch {
    return { count: 0, bytes: 0 }
  }
}

function nonNegativeNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// Read the requester's current daily usage without charging it (for /api/usage).
export async function readDailyUsage(kv: KVNamespace, ip: string): Promise<DailyQuota> {
  return readQuota(kv, ip)
}

export type QuotaCheck =
  | { ok: true }
  | { ok: false; reason: 'daily_count' | 'daily_bytes'; limit: number }

export async function checkAndChargeDaily(
  kv: KVNamespace,
  ip: string,
  addBytes: number,
  maxCount: number,
  maxBytes: number,
): Promise<QuotaCheck> {
  const bytesToAdd = nonNegativeNumber(addBytes)
  const cur = await readQuota(kv, ip)
  if (cur.count >= maxCount) {
    return { ok: false, reason: 'daily_count', limit: maxCount }
  }
  if (cur.bytes + bytesToAdd > maxBytes) {
    return { ok: false, reason: 'daily_bytes', limit: maxBytes }
  }
  const next: DailyQuota = { count: cur.count + 1, bytes: cur.bytes + bytesToAdd }
  await kv.put(await quotaKeyForIp(ip), JSON.stringify(next), {
    expirationTtl: DAY_TTL_SECONDS,
  })
  return { ok: true }
}
