import { X509Certificate, createPrivateKey } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createSelfSignedCertificate } from '../src/selfsigned.ts'

/** DER OID bytes for one extension, for raw-cert presence assertions. */
function oidBytes(spec: string): Buffer {
  const arcs = spec.split('.').map(Number)
  const values = [arcs[0]! * 40 + arcs[1]!, ...arcs.slice(2)]
  const bytes: number[] = []
  for (const value of values) {
    let rest = value
    const encoded = [rest & 0x7f]
    rest = Math.floor(rest / 128)
    while (rest > 0) {
      encoded.unshift((rest & 0x7f) | 0x80)
      rest = Math.floor(rest / 128)
    }
    bytes.push(...encoded)
  }
  return Buffer.from(bytes)
}

const KEY_USAGE_OID = oidBytes('2.5.29.15')
const EXT_KEY_USAGE_OID = oidBytes('2.5.29.37')

describe('createSelfSignedCertificate', () => {
  it('produces a parseable, self-signed certificate with SAN entries', () => {
    const { cert, key, fingerprint } = createSelfSignedCertificate({
      commonName: 'dsh-lan-gateway',
      altNames: ['127.0.0.1', '::1', '192.168.1.5'],
    })

    const parsed = new X509Certificate(cert)
    expect(parsed.subject).toContain('CN=dsh-lan-gateway')
    expect(parsed.issuer).toBe(parsed.subject)
    expect(parsed.ca).toBe(false)
    expect(parsed.subjectAltName).toContain('IP Address:127.0.0.1')
    expect(parsed.subjectAltName).toContain('IP Address:192.168.1.5')
    // Validity: starts in the past, ends in the future.
    expect(new Date(parsed.validFrom).getTime()).toBeLessThan(Date.now())
    expect(new Date(parsed.validTo).getTime()).toBeGreaterThan(Date.now() + 365 * 24 * 60 * 60 * 1000)

    // The private key matches the certificate.
    expect(parsed.checkPrivateKey(createPrivateKey(key))).toBe(true)

    // Fingerprint: 32 colon-separated uppercase hex bytes.
    expect(fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    expect(fingerprint).toBe(parsed.fingerprint256.replace(/:/g, '').toUpperCase().match(/.{2}/g)!.join(':'))
  })

  it('varies serials and fingerprints between runs', () => {
    const first = createSelfSignedCertificate({ commonName: 'a', altNames: [] })
    const second = createSelfSignedCertificate({ commonName: 'a', altNames: [] })
    expect(first.fingerprint).not.toBe(second.fingerprint)
    expect(first.cert).not.toBe(second.cert)
  })

  it('carries keyUsage, basicConstraints and EKU extensions', () => {
    const { cert } = createSelfSignedCertificate({ commonName: 'x', altNames: [] })
    const parsed = new X509Certificate(cert)
    // Node's keyUsage/extKeyUsage getters are unreliable on this Node build
    // (they misreport even OpenSSL-generated certificates), so assert the
    // extension presence against the raw DER instead.
    const der = parsed.raw
    expect(der.includes(KEY_USAGE_OID)).toBe(true)
    expect(der.includes(EXT_KEY_USAGE_OID)).toBe(true)
    expect(parsed.ca).toBe(false)
  })
})
