import { describe, expect, it } from 'vitest'
import { type RoomCandidate, computeNeed, isBlocked, planRoom } from '../src/room'

function item(id: string, uploadedAt: number, size: number, refundsDaily = false): RoomCandidate {
  return { id, kind: 'doc', filename: `${id}.txt`, size, chargedSize: size, uploadedAt, refundsDaily }
}

const base = {
  bytes: 100,
  storageUsed: 0,
  storageCap: 1000,
  dailyCharged: true,
  dailyCount: 0,
  dailyCountMax: 5,
  dailyBytes: 0,
  dailyBytesMax: 1000,
}

describe('computeNeed', () => {
  it('reports no need when every cap has headroom', () => {
    expect(isBlocked(computeNeed(base))).toBe(false)
  })

  it('reports each cap that the pending upload would exceed', () => {
    expect(computeNeed({ ...base, storageUsed: 950 }).storageBytes).toBe(50)
    expect(computeNeed({ ...base, dailyCount: 5 }).dailyCount).toBe(1)
    expect(computeNeed({ ...base, dailyBytes: 950 }).dailyBytes).toBe(50)
  })

  it('ignores the daily caps for uncharged (admin) uploads and a disabled storage cap', () => {
    const need = computeNeed({ ...base, dailyCharged: false, dailyCount: 99, storageCap: 0, storageUsed: 1e9 })
    expect(isBlocked(need)).toBe(false)
  })
})

describe('planRoom', () => {
  it('evicts oldest first and stops once the upload fits', () => {
    const plan = planRoom(
      [item('new', 3, 60), item('old', 1, 30), item('mid', 2, 30)],
      { storageBytes: 50, dailyCount: 0, dailyBytes: 0 },
    )
    expect(plan.evict.map((i) => i.id)).toEqual(['old', 'mid'])
    expect(plan.fits).toBe(true)
  })

  // Deleting an upload from another day or IP frees storage but gives no quota
  // back, so it must not be sacrificed for a daily-cap shortfall.
  it('only evicts quota-refunding uploads for a daily shortfall', () => {
    const plan = planRoom(
      [item('yesterday', 1, 10), item('today', 2, 10, true)],
      { storageBytes: 0, dailyCount: 1, dailyBytes: 0 },
    )
    expect(plan.evict.map((i) => i.id)).toEqual(['today'])
    expect(plan.fits).toBe(true)
  })

  it('reports the shortfall when the caller does not own enough to free', () => {
    const plan = planRoom([item('a', 1, 10)], { storageBytes: 50, dailyCount: 0, dailyBytes: 0 })
    expect(plan.fits).toBe(false)
    expect(plan.shortfall.storageBytes).toBe(40)
  })

  it('evicts nothing when nothing is blocked', () => {
    expect(planRoom([item('a', 1, 10)], { storageBytes: 0, dailyCount: 0, dailyBytes: 0 }).evict).toEqual([])
  })
})
