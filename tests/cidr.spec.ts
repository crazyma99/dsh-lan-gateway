import { describe, expect, it } from 'vitest'
import { cidrMatches, isAllowed, ipv4ToInt, normalizeAddress } from '../src/cidr.ts'

describe('ipv4ToInt', () => {
  it('converts dotted quads', () => {
    expect(ipv4ToInt('0.0.0.0')).toBe(0n)
    expect(ipv4ToInt('255.255.255.255')).toBe(0xffffffffn)
    expect(ipv4ToInt('192.168.1.5')).toBe(3232235781n)
  })

  it('rejects malformed input', () => {
    expect(() => ipv4ToInt('192.168.1')).toThrow()
    expect(() => ipv4ToInt('192.168.1.256')).toThrow()
    expect(() => ipv4ToInt('a.b.c.d')).toThrow()
  })
})

describe('normalizeAddress', () => {
  it('handles mapped IPv4, brackets, and undefined', () => {
    expect(normalizeAddress('::ffff:192.168.1.5')).toBe('192.168.1.5')
    expect(normalizeAddress('[::1]')).toBe('::1')
    expect(normalizeAddress(undefined)).toBeUndefined()
  })
})

describe('cidrMatches', () => {
  it('matches exact IPv4 and CIDR ranges', () => {
    expect(cidrMatches('192.168.1.5', '192.168.1.0/24')).toBe(true)
    expect(cidrMatches('192.168.2.5', '192.168.1.0/24')).toBe(false)
    expect(cidrMatches('192.168.1.5', '192.168.1.5')).toBe(true)
    expect(cidrMatches('10.0.0.1', '10.0.0.0/8')).toBe(true)
  })

  it('matches IPv6 exactly and case-insensitively', () => {
    expect(cidrMatches('fe80::1', 'fe80::1')).toBe(true)
    expect(cidrMatches('FE80::1', 'fe80::1')).toBe(true)
    expect(cidrMatches('fe80::2', 'fe80::1')).toBe(false)
  })
})

describe('isAllowed', () => {
  it('admits everything with an empty allowlist', () => {
    expect(isAllowed('8.8.8.8', [])).toBe(true)
    expect(isAllowed('192.168.1.5', [])).toBe(true)
  })

  it('filters by allowlist entries', () => {
    expect(isAllowed('192.168.1.7', ['192.168.1.0/24'])).toBe(true)
    expect(isAllowed('192.168.2.7', ['192.168.1.0/24'])).toBe(false)
  })

  it('refuses missing peer addresses and malformed entries fail closed', () => {
    expect(isAllowed(undefined, [])).toBe(false)
    expect(isAllowed('192.168.1.7', ['not-a-cidr!!'])).toBe(false)
  })
})
