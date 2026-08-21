/**
 * HTTP Basic authentication for the gateway: parsing and timing-safe
 * comparison against the configured credentials.
 * @module dsh-lan-gateway/auth
 */

import { createHash, timingSafeEqual } from 'node:crypto'

/** One decoded credential pair from an Authorization header. */
export interface BasicCredentials {
  readonly username: string
  readonly password: string
}

/** Expected credentials the gateway compares against. */
export interface GatewayCredentials {
  readonly username: string
  readonly password: string
}

const BASIC_PREFIX = /^basic\s+/i

/** Strict base64 decode that rejects malformed input instead of best-effort parsing. */
function decodeStrictBase64(text: string): Buffer | undefined {
  try {
    const buffer = Buffer.from(text, 'base64')
    // Re-encoding round-trip rejects garbage that Buffer decodes leniently.
    if (buffer.toString('base64') !== text.replace(/\s+/g, '')) return undefined
    return buffer
  } catch {
    return undefined
  }
}

/**
 * Parse an `Authorization` header into its credential pair.
 * @param header - raw header value (case-insensitive Basic prefix).
 * @returns the decoded pair, or undefined when absent or malformed.
 */
export function parseBasicAuth(header: string | undefined): BasicCredentials | undefined {
  if (header === undefined) return undefined
  const match = BASIC_PREFIX.exec(header)
  if (match === null) return undefined
  const decoded = decodeStrictBase64(header.slice(match[0].length).trim())
  if (decoded === undefined) return undefined
  const text = decoded.toString('utf8')
  const colon = text.indexOf(':')
  if (colon < 0) return undefined
  // The password may itself contain colons; split at the first only.
  return { username: text.slice(0, colon), password: text.slice(colon + 1) }
}

/** Constant-time equality over SHA-256 digests (lengths equalized by hashing). */
function digestEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest()
  const rightDigest = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftDigest, rightDigest)
}

/**
 * Compare presented credentials against the expected pair, constant-time per
 * field so neither the username nor the password leaks through timing.
 */
export function credentialsMatch(
  given: BasicCredentials | undefined,
  expected: GatewayCredentials,
): boolean {
  if (given === undefined) return false
  return digestEqual(given.username, expected.username)
    && digestEqual(given.password, expected.password)
}
