// Per-IP daily caps on doc uploads, backed by KV. The Cloudflare rate-limit
// binding only supports 10s/60s windows (good for burst control), so the
// longer "N per day / M bytes per day" abuse caps live here.
//
// KV is eventually consistent, so these caps are approximate under a burst of
// concurrent uploads from one IP. That's fine: they exist to bound abuse, not
// to bill anyone to the byte. The 60s burst binding stops the concurrent case.

type DailyQuota = { count: number; bytes: number }

const DAY_TTL_SECONDS = 60 * 60 * 48 // keep a day's counter ~2 days, then expire

function quotaKey(ip: string): string {
  const day = new Date().toISOString().slice(0, 10) // UTC YYYY-MM-DD
  return `quota:${day}:${ip}`
}

async function readQuota(kv: KVNamespace, ip: string): Promise<DailyQuota> {
  const raw = await kv.get(quotaKey(ip))
  if (!raw) return { count: 0, bytes: 0 }
  try {
    const parsed = JSON.parse(raw) as DailyQuota
    return { count: parsed.count ?? 0, bytes: parsed.bytes ?? 0 }
  } catch {
    return { count: 0, bytes: 0 }
  }
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
  const cur = await readQuota(kv, ip)
  if (cur.count >= maxCount) {
    return { ok: false, reason: 'daily_count', limit: maxCount }
  }
  if (cur.bytes + addBytes > maxBytes) {
    return { ok: false, reason: 'daily_bytes', limit: maxBytes }
  }
  const next: DailyQuota = { count: cur.count + 1, bytes: cur.bytes + addBytes }
  await kv.put(quotaKey(ip), JSON.stringify(next), {
    expirationTtl: DAY_TTL_SECONDS,
  })
  return { ok: true }
}
