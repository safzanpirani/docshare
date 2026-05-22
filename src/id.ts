const ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export function generateId(length = 8): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let id = ''
  for (let i = 0; i < length; i++) {
    id += ALPHABET[bytes[i] % 62]
  }
  return id
}

export function isValidId(id: string): boolean {
  return /^[A-Za-z0-9]{4,32}$/.test(id)
}
