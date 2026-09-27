import { describe, expect, it } from 'vitest'
import { hashOwnerToken, isValidOwnerToken, ownerTagFrom, ownsItem } from '../src/owner'
import { hashIp } from '../src/ratelimit'

const TOKEN_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

describe('isValidOwnerToken', () => {
  it('accepts url-safe tokens of a reasonable length', () => {
    expect(isValidOwnerToken(TOKEN_A)).toBe(true)
    expect(isValidOwnerToken('A-Z_az09' + 'x'.repeat(8))).toBe(true)
  })

  it('rejects short, overlong, or non-url-safe tokens', () => {
    expect(isValidOwnerToken('short')).toBe(false)
    expect(isValidOwnerToken('x'.repeat(129))).toBe(false)
    expect(isValidOwnerToken('has spaces here!!')).toBe(false)
    expect(isValidOwnerToken('')).toBe(false)
  })
})

describe('hashOwnerToken', () => {
  it('is stable, distinguishes tokens, and never echoes the token', async () => {
    expect(await hashOwnerToken(TOKEN_A)).toBe(await hashOwnerToken(TOKEN_A))
    expect(await hashOwnerToken(TOKEN_A)).not.toBe(await hashOwnerToken(TOKEN_B))
    expect(await hashOwnerToken(TOKEN_A)).not.toContain(TOKEN_A)
  })

  // Domain separation: an owner tag and an IP tag share one metadata namespace,
  // so a collision would let one identity impersonate the other.
  it('is domain-separated from hashIp', async () => {
    expect(await hashOwnerToken('1.2.3.4')).not.toBe(await hashIp('1.2.3.4'))
  })
})

describe('ownerTagFrom', () => {
  it('returns a tag for a valid token and nothing otherwise', async () => {
    expect(await ownerTagFrom(TOKEN_A)).toBe(await hashOwnerToken(TOKEN_A))
    expect(await ownerTagFrom(undefined)).toBeUndefined()
    expect(await ownerTagFrom('short')).toBeUndefined()
  })
})

describe('ownsItem', () => {
  const IP_TAG = 'ip-tag-of-caller'
  const OWNER_TAG = 'owner-tag-of-caller'

  it('lets admin see everything', () => {
    expect(ownsItem({
      admin: true,
      itemOwnerTag: 'someone-else',
      itemUploaderTag: 'another-ip',
      callerOwnerTag: OWNER_TAG,
      callerIpTag: IP_TAG,
    })).toBe(true)
  })

  it('matches a token-owned item only for the token holder', () => {
    expect(ownsItem({
      admin: false,
      itemOwnerTag: OWNER_TAG,
      itemUploaderTag: 'any-ip',
      callerOwnerTag: OWNER_TAG,
      callerIpTag: IP_TAG,
    })).toBe(true)
  })

  // The CGNAT leak this whole module exists to close: same public IP, different
  // person. Before owner tokens this returned true.
  it('denies a co-NAT stranger even when the IP tag matches', () => {
    expect(ownsItem({
      admin: false,
      itemOwnerTag: 'stranger-owner-tag',
      itemUploaderTag: IP_TAG,
      callerOwnerTag: OWNER_TAG,
      callerIpTag: IP_TAG,
    })).toBe(false)
  })

  it('denies a token-owned item to a caller with no token', () => {
    expect(ownsItem({
      admin: false,
      itemOwnerTag: OWNER_TAG,
      itemUploaderTag: IP_TAG,
      callerOwnerTag: undefined,
      callerIpTag: IP_TAG,
    })).toBe(false)
  })

  // Legacy objects (uploaded before owner tokens shipped) carry no ownerTag.
  // They keep the old IP behaviour so nobody's list empties mid-day; TTL
  // retires them within a day.
  it('falls back to IP matching for legacy items without an ownerTag', () => {
    expect(ownsItem({
      admin: false,
      itemOwnerTag: undefined,
      itemUploaderTag: IP_TAG,
      callerOwnerTag: OWNER_TAG,
      callerIpTag: IP_TAG,
    })).toBe(true)

    expect(ownsItem({
      admin: false,
      itemOwnerTag: undefined,
      itemUploaderTag: 'a-different-ip',
      callerOwnerTag: OWNER_TAG,
      callerIpTag: IP_TAG,
    })).toBe(false)
  })

  it('denies items with neither tag', () => {
    expect(ownsItem({
      admin: false,
      itemOwnerTag: undefined,
      itemUploaderTag: undefined,
      callerOwnerTag: OWNER_TAG,
      callerIpTag: IP_TAG,
    })).toBe(false)
  })
})
