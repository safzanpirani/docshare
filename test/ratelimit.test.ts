import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  checkAndChargeDaily,
  hashIp,
  readDailyUsage,
  refundChargedDaily,
  refundDaily,
} from '../src/ratelimit'
import { FakeKV, asKV } from './fakes'

const IP = '1.2.3.4'
const OTHER_IP = '5.6.7.8'

afterEach(() => vi.useRealTimers())

describe('hashIp', () => {
  it('is stable and distinguishes inputs', async () => {
    expect(await hashIp(IP)).toBe(await hashIp(IP))
    expect(await hashIp(IP)).not.toBe(await hashIp(OTHER_IP))
  })

  it('never returns the raw IP', async () => {
    expect(await hashIp(IP)).not.toContain(IP)
  })
})

describe('checkAndChargeDaily', () => {
  it('charges count and bytes cumulatively', async () => {
    const kv = new FakeKV()
    expect(await checkAndChargeDaily(asKV(kv), IP, 100, 5, 1000)).toEqual({ ok: true })
    expect(await checkAndChargeDaily(asKV(kv), IP, 250, 5, 1000)).toEqual({ ok: true })
    expect(await readDailyUsage(asKV(kv), IP)).toEqual({ count: 2, bytes: 350 })
  })

  it('rejects once the count cap is reached, without charging', async () => {
    const kv = new FakeKV()
    for (let i = 0; i < 3; i++) await checkAndChargeDaily(asKV(kv), IP, 1, 3, 10_000)
    const res = await checkAndChargeDaily(asKV(kv), IP, 1, 3, 10_000)
    expect(res).toEqual({ ok: false, reason: 'daily_count', limit: 3 })
    expect(await readDailyUsage(asKV(kv), IP)).toEqual({ count: 3, bytes: 3 })
  })

  it('rejects an upload that would exceed the byte cap, without charging', async () => {
    const kv = new FakeKV()
    await checkAndChargeDaily(asKV(kv), IP, 900, 10, 1000)
    const res = await checkAndChargeDaily(asKV(kv), IP, 200, 10, 1000)
    expect(res).toEqual({ ok: false, reason: 'daily_bytes', limit: 1000 })
    expect(await readDailyUsage(asKV(kv), IP)).toEqual({ count: 1, bytes: 900 })
  })

  it('keeps separate counters per IP', async () => {
    const kv = new FakeKV()
    await checkAndChargeDaily(asKV(kv), IP, 100, 5, 1000)
    expect(await readDailyUsage(asKV(kv), OTHER_IP)).toEqual({ count: 0, bytes: 0 })
  })

  it('treats a corrupt counter as empty rather than throwing', async () => {
    const kv = new FakeKV()
    await checkAndChargeDaily(asKV(kv), IP, 100, 5, 1000)
    const key = [...kv.store.keys()][0]
    kv.store.set(key, '{not json')
    expect(await readDailyUsage(asKV(kv), IP)).toEqual({ count: 0, bytes: 0 })
  })
})

describe('refundChargedDaily', () => {
  it('undoes exactly one charge', async () => {
    const kv = new FakeKV()
    await checkAndChargeDaily(asKV(kv), IP, 500, 5, 10_000)
    await refundChargedDaily(asKV(kv), IP, 500)
    expect(await readDailyUsage(asKV(kv), IP)).toEqual({ count: 0, bytes: 0 })
  })

  it('never drives a counter negative', async () => {
    const kv = new FakeKV()
    await refundChargedDaily(asKV(kv), IP, 9999)
    expect(await readDailyUsage(asKV(kv), IP)).toEqual({ count: 0, bytes: 0 })
  })
})

describe('refundDaily', () => {
  it('refunds the original uploader on the same UTC day', async () => {
    const kv = new FakeKV()
    await checkAndChargeDaily(asKV(kv), IP, 500, 5, 10_000)
    await refundDaily(asKV(kv), IP, 500, Date.now(), await hashIp(IP))
    expect(await readDailyUsage(asKV(kv), IP)).toEqual({ count: 0, bytes: 0 })
  })

  // Each of the following would otherwise be a way to farm daily quota by
  // deleting files you did not upload, or files from a previous day.
  it('refuses a refund to a different IP', async () => {
    const kv = new FakeKV()
    await checkAndChargeDaily(asKV(kv), IP, 500, 5, 10_000)
    await refundDaily(asKV(kv), IP, 500, Date.now(), await hashIp(OTHER_IP))
    expect(await readDailyUsage(asKV(kv), IP)).toEqual({ count: 1, bytes: 500 })
  })

  it('refuses a refund for an upload from a previous day', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-02T00:30:00Z'))
    const kv = new FakeKV()
    await checkAndChargeDaily(asKV(kv), IP, 500, 5, 10_000)
    const yesterday = Date.parse('2026-03-01T23:30:00Z')
    await refundDaily(asKV(kv), IP, 500, yesterday, await hashIp(IP))
    expect(await readDailyUsage(asKV(kv), IP)).toEqual({ count: 1, bytes: 500 })
  })

  it('refuses a refund when the uploader tag is missing or the timestamp is junk', async () => {
    const kv = new FakeKV()
    await checkAndChargeDaily(asKV(kv), IP, 500, 5, 10_000)
    await refundDaily(asKV(kv), IP, 500, Date.now(), undefined)
    await refundDaily(asKV(kv), IP, 500, 0, await hashIp(IP))
    await refundDaily(asKV(kv), IP, 500, Number.NaN, await hashIp(IP))
    expect(await readDailyUsage(asKV(kv), IP)).toEqual({ count: 1, bytes: 500 })
  })
})
