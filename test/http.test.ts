import { describe, expect, it } from 'vitest'
import {
  asciiFilename,
  clientIp,
  contentTypeForDownload,
  isForbiddenCrossOrigin,
  isPdfFile,
  isViewableText,
  normalizeContentType,
  parseSingleRange,
  returnedRangeBounds,
  rfc5987Value,
  sanitizeFilename,
  shouldServeInline,
  timingSafeEqual,
} from '../src/http'

describe('sanitizeFilename', () => {
  it('strips directory components', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('C:\\Windows\\system32\\evil.exe')).toBe('evil.exe')
    expect(sanitizeFilename('a/b/c/report.pdf')).toBe('report.pdf')
  })

  it('strips control characters that could forge response headers', () => {
    expect(sanitizeFilename('bad\r\nX-Injected: 1.txt')).toBe('badX-Injected: 1.txt')
    expect(sanitizeFilename('nul\u0000byte.txt')).toBe('nulbyte.txt')
  })

  it('falls back to "file" when nothing usable remains', () => {
    expect(sanitizeFilename('')).toBe('file')
    expect(sanitizeFilename('   ')).toBe('file')
    expect(sanitizeFilename('/')).toBe('file')
  })

  it('caps length at 200 characters', () => {
    expect(sanitizeFilename('a'.repeat(500))).toHaveLength(200)
  })

  it('keeps unicode names intact', () => {
    expect(sanitizeFilename('résumé — final.pdf')).toBe('résumé — final.pdf')
  })
})

describe('asciiFilename / rfc5987Value', () => {
  it('produces a quote-free ascii fallback for the legacy header param', () => {
    expect(asciiFilename('ré"sumé.pdf')).toBe('r_sum_.pdf')
    expect(asciiFilename('a"b.txt')).not.toContain('"')
  })

  it('percent-encodes the UTF-8 variant including RFC 5987 specials', () => {
    expect(rfc5987Value('résumé.pdf')).toBe('r%C3%A9sum%C3%A9.pdf')
    expect(rfc5987Value("it's(a)*.txt")).toBe('it%27s%28a%29%2A.txt')
  })
})

describe('normalizeContentType', () => {
  it('lowercases and drops parameters', () => {
    expect(normalizeContentType('TEXT/Plain; charset=UTF-8')).toBe('text/plain')
  })

  it('rejects malformed types rather than echoing them into a header', () => {
    for (const bad of ['', 'notatype', 'text/', '/plain', 'text/plain\r\nX: 1']) {
      expect(normalizeContentType(bad)).toBe('application/octet-stream')
    }
  })
})

describe('contentTypeForDownload', () => {
  it('overrides APK metadata with the Android package MIME type', () => {
    expect(contentTypeForDownload('app.apk', 'application/zip')).toBe('application/vnd.android.package-archive')
    expect(contentTypeForDownload('APP.APK', 'application/octet-stream')).toBe('application/vnd.android.package-archive')
  })

  it('preserves the stored type for other extensions', () => {
    expect(contentTypeForDownload('archive.zip', 'application/zip')).toBe('application/zip')
    expect(contentTypeForDownload('notes.apk.txt', 'text/plain')).toBe('text/plain')
  })
})

describe('shouldServeInline', () => {
  it('allows known-safe browser media', () => {
    expect(shouldServeInline('image/png')).toBe(true)
    expect(shouldServeInline('video/mp4')).toBe(true)
    expect(shouldServeInline('audio/mpeg; rate=44100')).toBe(true)
  })

  // The whole point of the allowlist: active content must never be inline,
  // because content-type here is client-declared.
  it('refuses active content types', () => {
    expect(shouldServeInline('image/svg+xml')).toBe(false)
    expect(shouldServeInline('text/html')).toBe(false)
    expect(shouldServeInline('application/xhtml+xml')).toBe(false)
    expect(shouldServeInline('application/javascript')).toBe(false)
  })
})

describe('isViewableText / isPdfFile', () => {
  it('detects text by content-type', () => {
    expect(isViewableText('x', 'text/plain')).toBe(true)
    expect(isViewableText('x', 'application/json')).toBe(true)
  })

  it('falls back to extension when the type is opaque', () => {
    expect(isViewableText('main.rs', 'application/octet-stream')).toBe(true)
    expect(isViewableText('Dockerfile', 'application/octet-stream')).toBe(true)
    expect(isViewableText('photo.png', 'application/octet-stream')).toBe(false)
  })

  it('detects pdfs by either signal', () => {
    expect(isPdfFile('a.pdf', 'application/octet-stream')).toBe(true)
    expect(isPdfFile('a.bin', 'application/pdf')).toBe(true)
    expect(isPdfFile('a.bin', 'application/octet-stream')).toBe(false)
  })
})

describe('parseSingleRange', () => {
  it('parses closed, open and suffix ranges', () => {
    expect(parseSingleRange('bytes=0-499')).toEqual({ offset: 0, length: 500 })
    expect(parseSingleRange('bytes=500-')).toEqual({ offset: 500 })
    expect(parseSingleRange('bytes=-500')).toEqual({ suffix: 500 })
  })

  it('rejects malformed, multi and inverted ranges', () => {
    for (const bad of ['bytes=100-50', 'bytes=abc-def', 'bytes=0-1,5-6', 'items=0-10', 'bytes=-0', 'bytes=']) {
      expect(parseSingleRange(bad)).toBeUndefined()
    }
  })

  it('rejects offsets beyond safe-integer precision', () => {
    expect(parseSingleRange('bytes=99999999999999999999-')).toBeUndefined()
  })
})

describe('returnedRangeBounds', () => {
  it('resolves an open range against the object size', () => {
    expect(returnedRangeBounds({ offset: 10 }, 100)).toEqual({ start: 10, length: 90 })
  })

  it('clamps a suffix longer than the object', () => {
    expect(returnedRangeBounds({ suffix: 500 }, 100)).toEqual({ start: 0, length: 100 })
  })

  it('resolves a closed range verbatim', () => {
    expect(returnedRangeBounds({ offset: 10, length: 5 }, 100)).toEqual({ start: 10, length: 5 })
  })
})

describe('clientIp', () => {
  const req = (headers: Record<string, string>) => new Request('https://x/', { headers })

  it('uses cf-connecting-ip', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '1.2.3.4' }))).toBe('1.2.3.4')
  })

  // Regression: x-real-ip used to be a fallback, which would have let a caller
  // choose the identity that gates /api/mine and the quota counters.
  it('ignores client-supplied x-real-ip', () => {
    expect(clientIp(req({ 'x-real-ip': '9.9.9.9' }))).toBe('unknown')
    expect(clientIp(req({ 'cf-connecting-ip': '1.2.3.4', 'x-real-ip': '9.9.9.9' }))).toBe('1.2.3.4')
  })
})

describe('timingSafeEqual', () => {
  it('matches equal strings and rejects differences', () => {
    expect(timingSafeEqual('secret', 'secret')).toBe(true)
    expect(timingSafeEqual('secret', 'secreu')).toBe(false)
    expect(timingSafeEqual('secret', 'secre')).toBe(false)
    expect(timingSafeEqual('', '')).toBe(true)
  })
})

describe('isForbiddenCrossOrigin', () => {
  const PUBLIC = 'https://docs.safzan.dev'

  it('allows requests with no Origin (curl, agents)', () => {
    expect(isForbiddenCrossOrigin(undefined, PUBLIC)).toBe(false)
  })

  it('allows the app origin', () => {
    expect(isForbiddenCrossOrigin(PUBLIC, PUBLIC)).toBe(false)
  })

  it('blocks any other browser origin', () => {
    expect(isForbiddenCrossOrigin('https://evil.example', PUBLIC)).toBe(true)
    expect(isForbiddenCrossOrigin('null', PUBLIC)).toBe(true)
    expect(isForbiddenCrossOrigin('http://docs.safzan.dev', PUBLIC)).toBe(true)
  })
})
