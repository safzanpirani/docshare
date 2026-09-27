import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { makeEnv } from './app-fakes'

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
