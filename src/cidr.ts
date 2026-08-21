/**
 * Minimal CIDR / IP matching for the LAN allowlist.
 * IPv4 CIDR (`a.b.c.d/n`) via BigInt ranges; IPv6 and bare IPv4 are exact
 * matches. A `::ffff:x.x.x.x` mapped address is normalized to its IPv4 form.
 * Empty allowlist = allow every address (the caller's documented default).
 * @module dsh-lan-gateway/cidr
 */

/** Parse one dotted-quad IPv4 literal into a 32-bit unsigned integer. */
export function ipv4ToInt(ip: string): bigint {
  const parts = ip.split('.')
  if (parts.length !== 4) throw new TypeError(`invalid IPv4 address ${JSON.stringify(ip)}`)
  let value = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) throw new TypeError(`invalid IPv4 address ${JSON.stringify(ip)}`)
    const octet = Number(part)
    if (octet > 255) throw new TypeError(`invalid IPv4 address ${JSON.stringify(ip)}`)
    value = (value << 8n) | BigInt(octet)
  }
  return value
}

/** Strip brackets and port from a socket address, keeping IPv6 brackets intact. */
export function normalizeAddress(address: string | undefined): string | undefined {
  if (address === undefined || address.length === 0) return undefined
  let ip = address.trim()
  if (ip.startsWith('::ffff:')) {
    const v4 = ip.slice('::ffff:'.length)
    if (v4.includes('.')) return v4
  }
  // Bracketed IPv6 like "[::1]".
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1)
  return ip
}

/** Whether one CIDR entry (`a.b.c.d/n`, bare IPv4, or exact IPv6) matches an IP. */
export function cidrMatches(ip: string, entry: string): boolean {
  const trimmed = entry.trim()
  if (trimmed.length === 0) return false
  if (trimmed.includes(':')) {
    // IPv6: exact match only in this minimal matcher.
    return ip.toLowerCase() === trimmed.toLowerCase()
  }
  const slash = trimmed.indexOf('/')
  if (slash < 0) return ip === trimmed
  const base = ipv4ToInt(trimmed.slice(0, slash))
  const maskText = trimmed.slice(slash + 1)
  if (!/^\d{1,2}$/.test(maskText)) throw new TypeError(`invalid CIDR mask in ${JSON.stringify(entry)}`)
  const bits = Number(maskText)
  if (bits > 32) throw new TypeError(`invalid CIDR mask in ${JSON.stringify(entry)}`)
  const mask = bits === 0 ? 0n : (~0n << BigInt(32 - bits)) & 0xffffffffn
  const target = ipv4ToInt(ip)
  return (target & mask) === (base & mask)
}

/** Whether one peer IP is admitted by the allowlist. Empty list admits all. */
export function isAllowed(ip: string | undefined, allowlist: readonly string[]): boolean {
  const normalized = normalizeAddress(ip)
  if (normalized === undefined) return false
  if (allowlist.length === 0) return true
  try {
    return allowlist.some(entry => cidrMatches(normalized, entry))
  } catch {
    // A malformed entry is a configuration error; fail closed for this request.
    return false
  }
}
