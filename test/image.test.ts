import { describe, expect, it } from 'vitest'
import {
  bytesMatchFormat,
  contentTypeFor,
  detectImageFormat,
  formatFromContentType,
  imageKey,
  isPng,
  isWebp,
  parseImageKey,
} from '../src/image'

const webpBytes = () => {
  const b = new Uint8Array(16)
  b.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  b.set([0x57, 0x45, 0x42, 0x50], 8) // WEBP
  return b.buffer
}

const pngBytes = () => {
  const b = new Uint8Array(16)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return b.buffer
}

describe('formatFromContentType', () => {
  it('maps the supported types', () => {
    expect(formatFromContentType('image/webp')).toBe('webp')
    expect(formatFromContentType('image/png')).toBe('png')
  })

  // The seeshare port documented exact-match as brittle for curl users.
  it('tolerates casing and parameters', () => {
    expect(formatFromContentType('image/PNG')).toBe('png')
    expect(formatFromContentType('image/webp; charset=binary')).toBe('webp')
    expect(formatFromContentType('  image/png  ')).toBe('png')
  })

  it('rejects anything else', () => {
    for (const bad of [undefined, '', 'image/jpeg', 'image/svg+xml', 'text/plain', 'image/pngx']) {
      expect(formatFromContentType(bad)).toBeUndefined()
    }
  })
})

describe('magic bytes', () => {
  it('identifies webp and png', () => {
    expect(isWebp(webpBytes())).toBe(true)
    expect(isPng(pngBytes())).toBe(true)
  })

  it('does not confuse the two formats', () => {
    expect(isWebp(pngBytes())).toBe(false)
    expect(isPng(webpBytes())).toBe(false)
  })

  it('rejects truncated buffers without throwing', () => {
    expect(isWebp(new ArrayBuffer(4))).toBe(false)
    expect(isPng(new ArrayBuffer(4))).toBe(false)
    expect(isWebp(new ArrayBuffer(0))).toBe(false)
  })

  // The stored extension follows the bytes, so a lie in content-type must not
  // be able to write a .png key containing webp bytes (or vice versa).
  it('bytesMatchFormat catches a mismatched declaration', () => {
    expect(bytesMatchFormat(pngBytes(), 'webp')).toBe(false)
    expect(bytesMatchFormat(pngBytes(), 'png')).toBe(true)
    expect(bytesMatchFormat(webpBytes(), 'webp')).toBe(true)
  })

  it('detects format from bytes alone', () => {
    expect(detectImageFormat(webpBytes())).toBe('webp')
    expect(detectImageFormat(pngBytes())).toBe('png')
    expect(detectImageFormat(new ArrayBuffer(16))).toBeUndefined()
  })
})

describe('keys', () => {
  it('builds and round-trips', () => {
    expect(imageKey('abc123', 'png')).toBe('img/abc123.png')
    expect(parseImageKey('img/abc123.png')).toEqual({ id: 'abc123', format: 'png' })
    expect(parseImageKey('img/abc123.webp')).toEqual({ id: 'abc123', format: 'webp' })
  })

  it('rejects non-image and sidecar keys', () => {
    expect(parseImageKey('doc/abc123')).toBeUndefined()
    expect(parseImageKey('img/abc123.ocr.json')).toBeUndefined()
    expect(parseImageKey('img/abc123')).toBeUndefined()
    expect(parseImageKey('img/.png')).toBeUndefined()
  })

  it('pairs contentTypeFor with formatFromContentType', () => {
    for (const f of ['webp', 'png'] as const) {
      expect(formatFromContentType(contentTypeFor(f))).toBe(f)
    }
  })
})
