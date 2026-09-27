import { describe, expect, it } from 'vitest'
import { generateId, isValidId } from '../src/id'

describe('generateId', () => {
  it('honours the requested length and alphabet', () => {
    for (const len of [8, 16, 32]) {
      const id = generateId(len)
      expect(id).toHaveLength(len)
      expect(id).toMatch(/^[A-Za-z0-9]+$/)
    }
  })

  it('produces ids that pass validation', () => {
    for (let i = 0; i < 100; i++) expect(isValidId(generateId(16))).toBe(true)
  })

  it('does not repeat across many draws', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => generateId(16)))
    expect(seen.size).toBe(1000)
  })
})

describe('isValidId', () => {
  it('accepts ids in the supported length range', () => {
    expect(isValidId('abcd')).toBe(true)
    expect(isValidId('a'.repeat(32))).toBe(true)
  })

  // isValidId gates every key built as `doc/${id}` / `meta/${id}.json`, so
  // anything that could escape the prefix must be rejected.
  it('rejects path traversal and separator characters', () => {
    for (const bad of ['../etc', 'a/b', 'a.json', 'a-b', 'a_b', 'a b', 'a%2Fb', '..']) {
      expect(isValidId(bad)).toBe(false)
    }
  })

  it('rejects out-of-range lengths', () => {
    expect(isValidId('')).toBe(false)
    expect(isValidId('abc')).toBe(false)
    expect(isValidId('a'.repeat(33))).toBe(false)
  })
})
