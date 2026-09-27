// "Make room": pick which of the caller's own uploads to delete so that one
// more upload of a given size fits under the caps that are blocking it.
//
// Three caps can refuse an upload:
// - the global storage cap: any owned object frees its bytes;
// - the per-IP daily count and daily bytes caps: only docs uploaded *today*
//   from the caller's own IP counter give quota back when deleted (see
//   refundDaily), so only those help.
//
// Planning is pure so the policy can be tested without R2/KV. The route plans
// first and deletes only when the plan actually makes the upload fit, so a
// request that can't succeed never destroys anything.

export type RoomCandidate = {
  id: string
  kind: 'doc' | 'image'
  filename: string
  size: number // bytes currently counted against the storage cap
  chargedSize: number // bytes charged to the daily quota at upload time
  uploadedAt: number
  // True when deleting this item refunds the caller's current daily counter.
  refundsDaily: boolean
}

// How much each cap is over budget for the pending upload. Positive means that
// much must be freed; zero or negative means the cap is not in the way.
export type RoomNeed = {
  storageBytes: number
  dailyCount: number
  dailyBytes: number
}

export type RoomPlan = {
  evict: RoomCandidate[]
  fits: boolean
  shortfall: RoomNeed
}

export function computeNeed(opts: {
  bytes: number
  storageUsed: number
  storageCap: number
  dailyCharged: boolean
  dailyCount: number
  dailyCountMax: number
  dailyBytes: number
  dailyBytesMax: number
}): RoomNeed {
  const bytes = Math.max(0, opts.bytes)
  const storageBytes = opts.storageCap > 0 ? opts.storageUsed + bytes - opts.storageCap : 0
  if (!opts.dailyCharged) return { storageBytes, dailyCount: 0, dailyBytes: 0 }
  return {
    storageBytes,
    dailyCount: opts.dailyCount + 1 - opts.dailyCountMax,
    dailyBytes: opts.dailyBytes + bytes - opts.dailyBytesMax,
  }
}

export function isBlocked(need: RoomNeed): boolean {
  return need.storageBytes > 0 || need.dailyCount > 0 || need.dailyBytes > 0
}

// Oldest first: those are the uploads closest to expiring anyway, so evicting
// them costs the caller the least.
export function planRoom(candidates: RoomCandidate[], need: RoomNeed): RoomPlan {
  const left = { ...need }
  const evict: RoomCandidate[] = []
  const ordered = [...candidates].sort((a, b) => a.uploadedAt - b.uploadedAt)
  for (const item of ordered) {
    if (!isBlocked(left)) break
    const helpsStorage = left.storageBytes > 0 && item.size > 0
    const helpsDaily = item.refundsDaily && (left.dailyCount > 0 || left.dailyBytes > 0)
    if (!helpsStorage && !helpsDaily) continue
    evict.push(item)
    left.storageBytes -= item.size
    if (item.refundsDaily) {
      left.dailyCount -= 1
      left.dailyBytes -= item.chargedSize
    }
  }
  return {
    evict,
    fits: !isBlocked(left),
    shortfall: {
      storageBytes: Math.max(0, left.storageBytes),
      dailyCount: Math.max(0, left.dailyCount),
      dailyBytes: Math.max(0, left.dailyBytes),
    },
  }
}
