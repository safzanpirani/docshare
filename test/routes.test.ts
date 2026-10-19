import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { makeEnv } from './app-fakes'
import indexHtml from '../public/index.html'

const IP = '1.2.3.4'
const OTHER_IP = '5.6.7.8'
const TOKEN = 'agent-token-aaaaaaaaaaaaaaaa'
const OTHER_TOKEN = 'someone-else-bbbbbbbbbbbbbbbb'

type Env = ReturnType<typeof makeEnv>
let env: Env
let clock: number

beforeEach(() => {
  env = makeEnv()
  vi.useFakeTimers({ toFake: ['Date'] })
  clock = Date.parse('2026-03-02T10:00:00Z')
  vi.setSystemTime(clock)
})
afterEach(() => vi.useRealTimers())

// Each request advances the clock a minute so upload order is unambiguous.
async function call(path: string, init: RequestInit & { ip?: string } = {}) {
  clock += 60_000
  vi.setSystemTime(clock)
  const headers = new Headers(init.headers)
  headers.set('cf-connecting-ip', init.ip ?? IP)
  const req = new Request(`https://docs.example${path}`, { ...init, headers })
  return worker.fetch(req, env as never, {} as ExecutionContext)
}

async function upload(name: string, size: number, opts: { token?: string; ip?: string; makeRoom?: boolean } = {}) {
  const headers: Record<string, string> = {
    'content-length': String(size),
    accept: 'application/json',
  }
  if (opts.token) headers['x-owner-token'] = opts.token
  if (opts.makeRoom) headers['x-make-room'] = '1'
  return call(`/upload/${name}`, { method: 'PUT', body: new Uint8Array(size), headers, ip: opts.ip })
}

async function mine(token = TOKEN, ip = IP) {
  const res = await call('/api/mine', { headers: { 'x-owner-token': token }, ip })
  return (await res.json() as { items: Array<{ id: string; filename: string }> }).items
}

describe('upload responses', () => {
  it('returns JSON with the id, raw URL and expiry when asked for JSON', async () => {
    const res = await upload('a.txt', 10, { token: TOKEN })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.url).toMatch(/^https:\/\/docs\.example\/d\/[A-Za-z0-9]{16}\/a\.txt$/)
    expect(body.rawUrl).toBe(`${body.url}?raw=1`)
    expect(body.expiresAt).toBe(Number(body.uploadedAt) + 24 * 3600 * 1000)
  })

  it('keeps the bare-URL body for plain curl', async () => {
    const res = await call('/upload/a.txt', { method: 'PUT', body: new Uint8Array(5), headers: { 'content-length': '5' } })
    expect(await res.text()).toMatch(/^https:\/\/docs\.example\/d\/\w+\/a\.txt\n$/)
  })
})

describe('daily cap errors', () => {
  it('explain the cap, the reset time and how to make room', async () => {
    for (const n of [1, 2, 3]) expect((await upload(`${n}.txt`, 10, { token: TOKEN })).status).toBe(200)
    const res = await call('/api/doc/presign', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-owner-token': TOKEN },
      body: JSON.stringify({ filename: '4.txt', size: 10 }),
    })
    expect(res.status).toBe(429)
    const body = await res.json() as Record<string, string | number>
    expect(body).toMatchObject({ error: 'daily_count', limit: 3, used: 3, resetsAt: '2026-03-03T00:00:00.000Z' })
    expect(body.hint).toContain('makeRoom')
  })
})

describe('make room', () => {
  it('deletes the oldest own upload when x-make-room is set, and only then', async () => {
    for (const n of [1, 2, 3]) await upload(`${n}.txt`, 10, { token: TOKEN })
    expect((await upload('4.txt', 10, { token: TOKEN })).status).toBe(429)

    const res = await upload('4.txt', 10, { token: TOKEN, makeRoom: true })
    expect(res.status).toBe(200)
    const body = await res.json() as { evicted: Array<{ filename: string }> }
    expect(body.evicted.map((e) => e.filename)).toEqual(['1.txt'])
    expect(res.headers.get('x-docshare-evicted')).toBeTruthy()
    expect((await mine()).map((i) => i.filename)).toEqual(['4.txt', '3.txt', '2.txt'])
  })

  it('previews without deleting on dryRun', async () => {
    for (const n of [1, 2, 3]) await upload(`${n}.txt`, 10, { token: TOKEN })
    const res = await call('/api/make-room', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-owner-token': TOKEN },
      body: JSON.stringify({ bytes: 10, dryRun: true }),
    })
    const body = await res.json() as { fits: boolean; wouldDelete: Array<{ filename: string }> }
    expect(body.fits).toBe(true)
    expect(body.wouldDelete.map((e) => e.filename)).toEqual(['1.txt'])
    expect(await mine()).toHaveLength(3)
  })

  // Another person's files share the storage cap but are never candidates, and
  // a request that can't succeed must not delete anything.
  it('never touches other owners and deletes nothing when it cannot fit', async () => {
    await upload('mine.bin', 100_000, { token: TOKEN })
    await upload('theirs.bin', 800_000, { token: OTHER_TOKEN, ip: OTHER_IP })
    const res = await call('/api/make-room', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-owner-token': TOKEN },
      body: JSON.stringify({ bytes: 500_000 }),
    })
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string; shortfall: { storageBytes: number } }
    expect(body.error).toBe('cannot_make_room')
    expect(body.shortfall.storageBytes).toBe(300_000)
    expect(await mine()).toHaveLength(1)
    expect(await mine(OTHER_TOKEN, OTHER_IP)).toHaveLength(1)
  })

  it('frees global storage using the caller\'s own files', async () => {
    await upload('old.bin', 400_000, { token: TOKEN })
    await upload('theirs.bin', 500_000, { token: OTHER_TOKEN, ip: OTHER_IP })
    const res = await call('/api/make-room', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-owner-token': TOKEN },
      body: JSON.stringify({ bytes: 300_000 }),
    })
    expect(res.status).toBe(200)
    expect((await res.json() as { deleted: unknown[] }).deleted).toHaveLength(1)
    expect(await mine()).toHaveLength(0)
    expect((await upload('new.bin', 300_000, { token: TOKEN })).status).toBe(200)
  })
})

describe('delete', () => {
  it('deletes by the share URL with HTTP DELETE and refunds the daily quota', async () => {
    const { url } = await (await upload('a.txt', 10, { token: TOKEN })).json() as { url: string }
    const path = new URL(url).pathname
    const res = await call(path, { method: 'DELETE' })
    expect(await res.json()).toMatchObject({ deleted: true, kind: 'doc' })
    expect((await call(path)).status).toBe(404)
    const usage = await (await call('/api/usage')).json() as { daily: { count: number } }
    expect(usage.daily.count).toBe(0)
  })

  it('refunds the charged counter when the owner deletes from another IP', async () => {
    const { id } = await (await upload('a.txt', 10, { token: TOKEN })).json() as { id: string }
    await call('/api/delete', {
      method: 'POST',
      ip: OTHER_IP,
      headers: { 'content-type': 'application/json', 'x-owner-token': TOKEN },
      body: JSON.stringify({ id }),
    })
    const usage = await (await call('/api/usage')).json() as { daily: { count: number } }
    expect(usage.daily.count).toBe(0)
  })

  it('refuses a cross-origin browser DELETE', async () => {
    const { url } = await (await upload('a.txt', 10, { token: TOKEN })).json() as { url: string }
    const res = await call(new URL(url).pathname, { method: 'DELETE', headers: { origin: 'https://evil.example' } })
    expect(res.status).toBe(403)
    expect(await mine()).toHaveLength(1)
  })
})

describe('make room ownership', () => {
  // Untagged uploads are matched to their IP for listing, but that match is too
  // weak to justify deleting them automatically.
  it('never evicts an untagged upload from the same IP', async () => {
    await upload('untagged.bin', 900_000)
    const res = await call('/api/make-room', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-owner-token': TOKEN },
      body: JSON.stringify({ bytes: 500_000 }),
    })
    expect(res.status).toBe(409)
    expect(await (await call('/api/mine')).json()).toMatchObject({ items: [{ filename: 'untagged.bin' }] })
  })

  it('requires an owner token', async () => {
    const res = await call('/api/make-room', { method: 'POST', body: '{}' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'owner_token_required' })
  })
})

describe('/api/mine matchedBy', () => {
  it('labels token matches apart from same-IP untagged uploads', async () => {
    await upload('untagged.txt', 5)
    await upload('tagged.txt', 5, { token: TOKEN })
    const res = await call('/api/mine', { headers: { 'x-owner-token': TOKEN } })
    const { items } = await res.json() as { items: Array<{ filename: string; matchedBy: string }> }
    expect(Object.fromEntries(items.map((i) => [i.filename, i.matchedBy]))).toEqual({
      'tagged.txt': 'token',
      'untagged.txt': 'ip',
    })
  })
})

async function presign(size: number, headers: Record<string, string> = {}) {
  const res = await call('/api/doc/presign', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ filename: 'file.bin', size }),
  })
  expect(res.status).toBe(200)
  return await res.json() as { id: string; putUrl: string }
}

async function finalize(id: string, ip = IP) {
  return call('/api/doc/finalize', { method: 'POST', ip, body: JSON.stringify({ id }) })
}

describe('exact upload admission', () => {
  it('does not charge abandoned presigns or refund somebody else when they are deleted', async () => {
    await upload('existing.txt', 10)
    const pending = await Promise.all(Array.from({ length: 5 }, () => presign(20)))
    for (const { id, putUrl } of pending) {
      expect(new URL(putUrl).pathname).toBe(`/bucket/pending/${id}`)
      expect(new URL(putUrl).searchParams.get('X-Amz-SignedHeaders')).toContain('content-length')
      await call('/api/delete', { method: 'POST', body: JSON.stringify({ id }) })
    }
    expect(await (await call('/api/usage')).json()).toMatchObject({ daily: { count: 1, bytes: 10 } })
  })

  it('charges actual bytes to the presigning IP, publishes only after finalize, and is immutable/idempotent', async () => {
    const { id } = await presign(10)
    await env.BUCKET.put(`pending/${id}`, new Uint8Array(40).buffer)
    expect((await call(`/d/${id}/file.bin`)).status).toBe(404)
    expect((await finalize(id, OTHER_IP)).status).toBe(200)
    expect(await (await call('/api/usage')).json()).toMatchObject({ daily: { count: 1, bytes: 40 }, storage: { used: 40 } })
    expect(await (await call('/api/usage', { ip: OTHER_IP })).json()).toMatchObject({ daily: { count: 0, bytes: 0 } })
    await env.BUCKET.put(`pending/${id}`, new Uint8Array(90).buffer)
    expect(await (await finalize(id)).json()).toMatchObject({ size: 40, finalized: true })
    expect((await (await call(`/d/${id}/file.bin`)).arrayBuffer()).byteLength).toBe(40)
    expect(await (await call('/api/usage')).json()).toMatchObject({ daily: { count: 1, bytes: 40 }, storage: { used: 40 } })
  })

  it('serializes concurrent finalizations at the daily count cap', async () => {
    const pending = await Promise.all(Array.from({ length: 6 }, () => presign(10)))
    for (const { id } of pending) await env.BUCKET.put(`pending/${id}`, new Uint8Array(10).buffer)
    const responses = await Promise.all(pending.map(({ id }) => finalize(id)))
    expect(responses.filter((res) => res.status === 200)).toHaveLength(3)
    expect(responses.filter((res) => res.status === 429)).toHaveLength(3)
    expect(await (await call('/api/usage')).json()).toMatchObject({ daily: { count: 3, bytes: 30 }, storage: { used: 30 } })
  })

  it('serializes concurrent one-shot uploads at the daily byte cap and counts actual bodies', async () => {
    env.DOC_DAILY_BYTES = '100'
    const responses = await Promise.all(Array.from({ length: 3 }, () => call('/upload/file.bin', {
      method: 'PUT', headers: { 'content-length': '1', accept: 'application/json' }, body: new Uint8Array(60),
    })))
    expect(responses.filter((res) => res.status === 200)).toHaveLength(1)
    expect(responses.filter((res) => res.status === 429)).toHaveLength(2)
    expect(await (await call('/api/usage')).json()).toMatchObject({ daily: { count: 1, bytes: 60 }, storage: { used: 60 } })
  })

  it('enforces the actual daily byte cap again at finalize', async () => {
    env.DOC_DAILY_BYTES = '100'
    const { id } = await presign(10)
    await env.BUCKET.put(`pending/${id}`, new Uint8Array(101).buffer)
    const res = await finalize(id)
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ error: 'daily_bytes', used: 0, limit: 100 })
    expect(await env.BUCKET.head(`pending/${id}`)).toBeNull()
    expect(await env.BUCKET.head(`doc/${id}`)).toBeNull()
    expect(await (await call('/api/usage')).json()).toMatchObject({ daily: { count: 0, bytes: 0 } })
  })

  it('serializes different IPs at the global published-file cap', async () => {
    env.MAX_TOTAL_BYTES = '100'
    const pending = await Promise.all([presign(60), presign(60)])
    for (const { id } of pending) await env.BUCKET.put(`pending/${id}`, new Uint8Array(60).buffer)
    const responses = await Promise.all(pending.map(({ id }, index) => finalize(id, index ? OTHER_IP : IP)))
    expect(responses.map((res) => res.status).sort()).toEqual([200, 507])
    expect(await (await call('/api/usage')).json()).toMatchObject({ storage: { used: 60 } })
  })

  it('does not refund daily quota for admin uploads', async () => {
    const { id } = await presign(10, { 'x-admin-key': env.ADMIN_KEY })
    await env.BUCKET.put(`pending/${id}`, new Uint8Array(10).buffer)
    await finalize(id)
    await upload('normal.txt', 20)
    await call('/api/delete', { method: 'POST', body: JSON.stringify({ id }) })
    expect(await (await call('/api/usage')).json()).toMatchObject({ daily: { count: 1, bytes: 20 } })
  })

  it('charges the UTC day the upload is finalized, not the day it was presigned', async () => {
    const { id } = await presign(10)
    await env.BUCKET.put(`pending/${id}`, new Uint8Array(10).buffer)
    clock = Date.parse('2026-03-03T00:00:00Z')
    expect((await finalize(id)).status).toBe(200)
    await call('/api/delete', { method: 'POST', body: JSON.stringify({ id }) })
    expect(await (await call('/api/usage')).json()).toMatchObject({ daily: { count: 0, bytes: 0 } })
  })
})

describe('PNG image cap', () => {
  it('reduces large PNG dimensions until the encoded bytes fit without changing format', async () => {
    const source = indexHtml.match(/  async function toPngBlob\([\s\S]*?\n  }/)?.[0]
    expect(source).toBeTruthy()
    const draws: unknown[] = []
    const dimensions: Array<[number, number]> = []
    function canvas(width = 0, height = 0) {
      return {
        width, height,
        toBlob(callback: (blob: { size: number; type: string }) => void, type: string) {
          dimensions.push([this.width, this.height])
          callback({ size: this.width * this.height * 4, type })
        },
        getContext() { return { drawImage: (original: unknown) => draws.push(original) } },
      }
    }
    const original = canvas(4096, 4096)
    const encode = new Function('document', 'MAX_IMAGE_BYTES', `${source}; return toPngBlob`)(
      { createElement: () => canvas() }, 15 * 1024 * 1024,
    )
    const blob = await encode(original, original.width, original.height)
    expect(blob.type).toBe('image/png')
    expect(blob.size).toBeLessThanOrEqual(15 * 1024 * 1024)
    expect(dimensions.length).toBeGreaterThan(1)
    expect(draws.every((draw) => draw === original)).toBe(true)
    expect(dimensions.every(([width, height]) => width >= 1 && height >= 1)).toBe(true)
  })
})

 describe('admin forced document size override', () => {
  async function forced(size: number, key?: string, force = true) {
    return call('/api/doc/presign', { method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'x-admin-key': key } : {}) },
      body: JSON.stringify({ filename: 'movie.mp4', size, force }) })
  }
  it('rejects unauthenticated force requests', async () => {
    expect((await forced(2016165423)).status).toBe(403)
    expect((await forced(2016165423, 'wrong-key')).status).toBe(403)
  })
  it('retains the normal admin size cap without force', async () => {
    expect((await forced(2016165423, env.ADMIN_KEY, false)).status).toBe(413)
  })
  it('permits a large admin upload and persists the finalize ceiling', async () => {
    env.MAX_TOTAL_BYTES = '9000000000'
    const response = await forced(2016165423, env.ADMIN_KEY)
    expect(response.status).toBe(200)
    const { id } = await response.json() as { id: string }
    const meta = await env.BUCKET.get(`meta/${id}.json`)
    expect((await meta!.json() as { maxBytes: number }).maxBytes).toBe(5000000000)
  })
  it('does not bypass global storage capacity', async () => {
    expect((await forced(2016165423, env.ADMIN_KEY)).status).toBe(507)
  })
  it('enforces the single PUT ceiling even for admins' , async () => {
    expect((await forced(5000000001, env.ADMIN_KEY)).status).toBe(413)
  })
 })
