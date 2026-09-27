// Ownership identity for "my uploads" (/api/mine).
//
// Previously the only identity was a hash of the client IP. That works for one
// person's several devices — the case the feature was built for — but behind
// CGNAT, a corporate NAT, or a mobile carrier, unrelated strangers share a
// public IP and would therefore see (and be able to delete) each other's
// uploads. The 16-char id is supposed to be the capability; IP-scoping handed
// it out.
//
// Fix: the browser mints a random owner token once, keeps it in localStorage,
// and sends it as `x-owner-token`. The server stores only its SHA-256 (the
// token itself is never persisted), so possession of the token — not co-location
// on a NAT — is what proves ownership.
//
// Legacy objects uploaded before this existed have no ownerTag. For those we
// still fall back to IP matching so nobody's list empties out mid-day; because
// every object is deleted after TTL_HOURS, that fallback retires itself within
// a day of deploy.

export const OWNER_TOKEN_HEADER = 'x-owner-token'

// Tokens are opaque to the server; we only bound the shape so a malformed or
// absurdly long header can't be used to bloat stored metadata.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

export function isValidOwnerToken(token: string): boolean {
  return TOKEN_PATTERN.test(token)
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Domain-separated from hashIp's `docshare:` prefix so an owner tag and an IP
// tag can never collide in the metadata field.
export async function hashOwnerToken(token: string): Promise<string> {
  return sha256Hex(`docshare-owner:${token}`)
}

// Returns the caller's owner tag, or undefined when they sent no (or an
// invalid) token — e.g. curl, agents, or a browser that hasn't minted one yet.
export async function ownerTagFrom(
  header: string | undefined,
): Promise<string | undefined> {
  if (!header || !isValidOwnerToken(header)) return undefined
  return hashOwnerToken(header)
}

// Ownership test used by /api/mine.
//
// - admin sees everything.
// - an object carrying an ownerTag matches only the holder of that token. This
//   is the case that closes the shared-NAT leak: IP is deliberately not
//   consulted, so a co-NAT'd stranger never matches.
// - an object with no ownerTag is legacy; fall back to the IP tag.
export function ownsItem(opts: {
  admin: boolean
  itemOwnerTag: unknown
  itemUploaderTag: unknown
  callerOwnerTag: string | undefined
  callerIpTag: string
}): boolean {
  if (opts.admin) return true

  const itemOwner = typeof opts.itemOwnerTag === 'string' ? opts.itemOwnerTag : undefined
  if (itemOwner) return opts.callerOwnerTag === itemOwner

  const itemUploader = typeof opts.itemUploaderTag === 'string' ? opts.itemUploaderTag : undefined
  return !!itemUploader && itemUploader === opts.callerIpTag
}
