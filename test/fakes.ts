// Minimal in-memory stand-ins for the KV and R2 bindings, so the accounting
// logic in storage.ts / ratelimit.ts can be tested without a Workers runtime.
// Only the surface those modules actually use is implemented.

export class FakeKV {
  store = new Map<string, string>()
  putCalls = 0

  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null
  }

  async put(key: string, value: string, _opts?: { expirationTtl?: number }): Promise<void> {
    this.putCalls++
    this.store.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }
}

export type FakeObject = { key: string; size: number }

export class FakeR2 {
  objects: FakeObject[] = []
  listCalls = 0

  constructor(objects: FakeObject[] = []) {
    this.objects = objects
  }

  // Cursor is just an index into the sorted key list, encoded as a string.
  async list(opts?: { prefix?: string; cursor?: string; limit?: number }) {
    this.listCalls++
    const limit = opts?.limit ?? 1000
    const all = this.objects
      .filter((o) => !opts?.prefix || o.key.startsWith(opts.prefix))
      .sort((a, b) => (a.key < b.key ? -1 : 1))
    const start = opts?.cursor ? Number(opts.cursor) : 0
    const page = all.slice(start, start + limit)
    const next = start + page.length
    const truncated = next < all.length
    return {
      objects: page.map((o) => ({ key: o.key, size: o.size })),
      truncated,
      cursor: truncated ? String(next) : undefined,
    }
  }
}

// KV binding type is structural in the source modules; the fakes satisfy the
// members used, so a single cast at the call site keeps the tests readable.
export const asKV = (kv: FakeKV) => kv as unknown as KVNamespace
export const asR2 = (r2: FakeR2) => r2 as unknown as R2Bucket
