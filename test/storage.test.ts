import { describe, expect, it } from 'vitest'
import {
  addStorageUsed,
  getStorageUsed,
  reconcileStorage,
  withinStorageCap,
} from '../src/storage'
import { FakeKV, FakeR2, asKV, asR2 } from './fakes'

describe('getStorageUsed / addStorageUsed', () => {
  it('starts at zero and accumulates', async () => {
    const kv = new FakeKV()
    expect(await getStorageUsed(asKV(kv))).toBe(0)
    await addStorageUsed(asKV(kv), 500)
    await addStorageUsed(asKV(kv), 250)
    expect(await getStorageUsed(asKV(kv))).toBe(750)
  })

  it('subtracts on delete but clamps at zero', async () => {
    const kv = new FakeKV()
    await addStorageUsed(asKV(kv), 100)
    await addStorageUsed(asKV(kv), -500)
    expect(await getStorageUsed(asKV(kv))).toBe(0)
  })

  it('skips no-op and non-finite deltas without writing', async () => {
    const kv = new FakeKV()
    await addStorageUsed(asKV(kv), 0)
    await addStorageUsed(asKV(kv), Number.NaN)
    await addStorageUsed(asKV(kv), Number.POSITIVE_INFINITY)
    expect(kv.putCalls).toBe(0)
  })

  it('treats a corrupt counter as zero', async () => {
    const kv = new FakeKV()
    kv.store.set('storage:used', 'not-a-number')
    expect(await getStorageUsed(asKV(kv))).toBe(0)
  })
})

describe('withinStorageCap', () => {
  it('allows up to and including the cap, rejects beyond', async () => {
    const kv = new FakeKV()
    await addStorageUsed(asKV(kv), 900)
    expect(await withinStorageCap(asKV(kv), 100, 1000)).toBe(true)
    expect(await withinStorageCap(asKV(kv), 101, 1000)).toBe(false)
  })

  it('treats a non-positive cap as disabled', async () => {
    const kv = new FakeKV()
    await addStorageUsed(asKV(kv), 10_000)
    expect(await withinStorageCap(asKV(kv), 1, 0)).toBe(true)
    expect(await withinStorageCap(asKV(kv), 1, Number.NaN)).toBe(true)
  })
})

describe('reconcileStorage', () => {
  it('overwrites the counter with the true sum, correcting drift', async () => {
    const kv = new FakeKV()
    // Simulate the drift the cron exists to fix: the lifecycle rule deleted
    // objects without telling the Worker, so the counter over-counts.
    await addStorageUsed(asKV(kv), 10_000)
    const r2 = new FakeR2([
      { key: 'doc/a', size: 100 },
      { key: 'meta/a.json', size: 20 },
      { key: 'img/b.webp', size: 300 },
    ])
    await reconcileStorage(asKV(kv), asR2(r2))
    expect(await getStorageUsed(asKV(kv))).toBe(420)
  })

  it('pages through a bucket larger than one list call', async () => {
    const kv = new FakeKV()
    const objects = Array.from({ length: 2500 }, (_, i) => ({ key: `doc/${i}`, size: 10 }))
    const r2 = new FakeR2(objects)
    await reconcileStorage(asKV(kv), asR2(r2))
    expect(await getStorageUsed(asKV(kv))).toBe(25_000)
    expect(r2.listCalls).toBeGreaterThan(1)
  })

  it('resets to zero when the bucket is empty', async () => {
    const kv = new FakeKV()
    await addStorageUsed(asKV(kv), 5000)
    await reconcileStorage(asKV(kv), asR2(new FakeR2([])))
    expect(await getStorageUsed(asKV(kv))).toBe(0)
  })
})
