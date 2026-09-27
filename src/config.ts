// Single source of truth for the numeric config knobs set in wrangler.toml
// [vars]. Previously each route re-parsed `Number(c.env.X) || <literal>` at the
// point of use — 14 sites, and they had drifted: /api/doc/presign defaulted
// DOC_DAILY_BYTES to 300 MB while /upload and /api/usage used 1.5 GB, so an
// unset var meant the quota enforced was not the quota displayed.
//
// Every default lives here now. Routes call readConfig(env) once.

export type Config = {
  ttlHours: number
  ttlMs: number
  maxUploadBytes: number
  maxDocBytes: number
  maxAdminDocBytes: number
  dailyCount: number
  dailyBytes: number
  maxTotalBytes: number
}

export const DEFAULTS = {
  ttlHours: 24,
  maxUploadBytes: 15 * 1024 * 1024, // 15 MB, images (webp)
  maxDocBytes: 100 * 1024 * 1024, // 100 MB, docs
  maxAdminDocBytes: 1_572_864_000, // 1.46 GiB per doc once unlocked with the admin key
  dailyCount: 10,
  dailyBytes: 1_572_864_000, // 1.5 GB per IP per day
  maxTotalBytes: 9_000_000_000, // 9 GB global cap (R2 free tier is 10 GB)
} as const

type ConfigEnv = {
  TTL_HOURS?: string
  MAX_UPLOAD_BYTES?: string
  MAX_DOC_BYTES?: string
  MAX_ADMIN_DOC_BYTES?: string
  DOC_DAILY_COUNT?: string
  DOC_DAILY_BYTES?: string
  MAX_TOTAL_BYTES?: string
}

// Positive finite numbers only; anything else (unset, empty, "abc", "-1", "0")
// falls back to the default rather than silently disabling a cap.
export function positiveNumber(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function readConfig(env: ConfigEnv): Config {
  const ttlHours = positiveNumber(env.TTL_HOURS, DEFAULTS.ttlHours)
  return {
    ttlHours,
    ttlMs: ttlHours * 3600 * 1000,
    maxUploadBytes: positiveNumber(env.MAX_UPLOAD_BYTES, DEFAULTS.maxUploadBytes),
    maxDocBytes: positiveNumber(env.MAX_DOC_BYTES, DEFAULTS.maxDocBytes),
    maxAdminDocBytes: positiveNumber(env.MAX_ADMIN_DOC_BYTES, DEFAULTS.maxAdminDocBytes),
    dailyCount: positiveNumber(env.DOC_DAILY_COUNT, DEFAULTS.dailyCount),
    dailyBytes: positiveNumber(env.DOC_DAILY_BYTES, DEFAULTS.dailyBytes),
    maxTotalBytes: positiveNumber(env.MAX_TOTAL_BYTES, DEFAULTS.maxTotalBytes),
  }
}
