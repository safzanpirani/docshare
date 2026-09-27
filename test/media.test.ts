import { describe, expect, it } from 'vitest'
import { mediaKind } from '../src/http'
import { mediaPage } from '../src/media'

describe('mediaKind', () => {
  it('detects video by content type and by extension', () => {
    expect(mediaKind('a.bin', 'video/mp4')).toBe('video')
    expect(mediaKind('clip.mkv', 'application/octet-stream')).toBe('video')
    expect(mediaKind('rec.MOV', 'application/octet-stream')).toBe('video')
  })
  it('detects audio', () => {
    expect(mediaKind('a.bin', 'audio/mpeg')).toBe('audio')
    expect(mediaKind('song.flac', 'application/octet-stream')).toBe('audio')
  })
  it('returns null for non-media', () => {
    expect(mediaKind('notes.md', 'text/markdown')).toBeNull()
    expect(mediaKind('doc.pdf', 'application/pdf')).toBeNull()
  })
})

describe('mediaPage', () => {
  const base = {
    id: 'abc123',
    contentType: 'video/mp4',
    kind: 'video' as const,
    size: 1024 * 1024,
    expiresAt: Date.now() + 3600_000,
    fileUrl: 'https://docs.example/d/abc123/clip.mp4',
  }
  it('renders a video element pointed at the /d/ URL', () => {
    const html = mediaPage({ ...base, filename: 'clip.mp4' })
    expect(html).toContain('<video')
    expect(html).toContain('src="https://docs.example/d/abc123/clip.mp4"')
    expect(html).toContain('?dl=1')
  })
  it('renders an audio element for audio', () => {
    const html = mediaPage({ ...base, kind: 'audio', filename: 'song.mp3' })
    expect(html).toContain('<audio')
    expect(html).not.toContain('<video')
  })
  it('escapes the filename', () => {
    const html = mediaPage({ ...base, filename: '<img src=x onerror=1>.mp4' })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
  })
})
