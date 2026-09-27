import { describe, expect, it } from 'vitest'
import { DEFAULTS, positiveNumber, readConfig } from '../src/config'

describe('positiveNumber', () => {
  it('accepts positive finite numbers', () => {
    expect(positiveNumber('42', 7)).toBe(42)
    expect(positiveNumber(42, 7)).toBe(42)
  })

  it('falls back for anything not a positive finite number', () => {
    for (const bad of [undefined, null, '', '   ', 'abc', '0', '-1', 'NaN', 'Infinity']) {
      expect(positiveNumber(bad, 7)).toBe(7)
    }
  })
})

describe('readConfig', () => {
  it('uses documented defaults when nothing is set', () => {
    const cfg = readConfig({})
    expect(cfg.ttlHours).toBe(DEFAULTS.ttlHours)
    expect(cfg.maxUploadBytes).toBe(DEFAULTS.maxUploadBytes)
    expect(cfg.maxDocBytes).toBe(DEFAULTS.maxDocBytes)
    expect(cfg.dailyCount).toBe(DEFAULTS.dailyCount)
    expect(cfg.dailyBytes).toBe(DEFAULTS.dailyBytes)
    expect(cfg.maxTotalBytes).toBe(DEFAULTS.maxTotalBytes)
  })

  // This is the regression the extraction exists to prevent: /api/doc/presign
  // used to default DOC_DAILY_BYTES to 300 MB while /upload and /api/usage used
  // 1.5 GB, so the quota enforced differed from the quota displayed.
  it('yields one dailyBytes default for every caller', () => {
    expect(readConfig({}).dailyBytes).toBe(1_572_864_000)
  })

  it('derives ttlMs from ttlHours', () => {
    expect(readConfig({ TTL_HOURS: '2' }).ttlMs).toBe(2 * 3600 * 1000)
  })

  it('ignores junk values rather than disabling a cap', () => {
    const cfg = readConfig({ MAX_TOTAL_BYTES: 'unlimited', DOC_DAILY_COUNT: '-5' })
    expect(cfg.maxTotalBytes).toBe(DEFAULTS.maxTotalBytes)
    expect(cfg.dailyCount).toBe(DEFAULTS.dailyCount)
  })
})
