/**
 * Self-signed X.509 certificate generation (ECDSA P-256 + SHA-256) with no
 * external dependencies. Node's crypto signs and generates keys; this module
 * only assembles the minimal DER certificate structure those keys need.
 * @module dsh-lan-gateway/selfsigned
 */

import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto'

/** Output of one generation run. */
export interface SelfSignedCertificate {
  /** PEM certificate chain (a single cert). */
  readonly cert: string
  /** PEM private key (PKCS#8). */
  readonly key: string
  /** Colon-grouped SHA-256 fingerprint of the DER certificate. */
  readonly fingerprint: string
}

/** Generation parameters. */
export interface SelfSignedOptions {
  /** Subject/issuer common name. */
  readonly commonName: string
  /** SAN entries: bare IPs and hostnames alike (IPv6 supported). */
  readonly altNames: readonly string[]
  /** Validity window in days. */
  readonly days?: number
}

const ECDSA_SHA256_OID = '1.2.840.10045.4.3.2'
const CN_OID = '2.5.4.3'
const BASIC_CONSTRAINTS_OID = '2.5.29.19'
const KEY_USAGE_OID = '2.5.29.15'
const EXT_KEY_USAGE_OID = '2.5.29.37'
const SUBJECT_ALT_NAME_OID = '2.5.29.17'
const SERVER_AUTH_OID = '1.3.6.1.5.5.7.3.1'

/** Length byte(s) of a DER TLV, long form when needed. */
function lengthBytes(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  let rest = length
  while (rest > 0) {
    bytes.unshift(rest & 0xff)
    rest = Math.floor(rest / 256)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

/** One DER TLV element. */
function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), lengthBytes(content.length), content])
}

function sequence(...children: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(children))
}

function integer(value: number | bigint | Uint8Array): Buffer {
  if (typeof value !== 'number' && typeof value !== 'bigint') {
    // Byte sequence (e.g. a random serial): keep as-is, strip leading zeros.
    let bytes = Array.from(value)
    while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.slice(1)
    if (bytes.length === 0) bytes = [0]
    if ((bytes[0]! & 0x80) !== 0) bytes.unshift(0)
    return tlv(0x02, Buffer.from(bytes))
  }
  let bigint = typeof value === 'bigint' ? value : BigInt(value)
  const bytes: number[] = []
  while (bigint > 0n) {
    bytes.unshift(Number(bigint & 0xffn))
    bigint >>= 8n
  }
  if (bytes.length === 0) bytes.push(0)
  // Two's-complement: a high bit set requires a leading zero byte.
  if ((bytes[0]! & 0x80) !== 0) bytes.unshift(0)
  return tlv(0x02, Buffer.from(bytes))
}

/** Encode a dotted-decimal OID into its DER content bytes. */
function oidContent(spec: string): Buffer {
  const arcs = spec.split('.').map(Number)
  const first = arcs[0]! * 40 + arcs[1]!
  const values = [first, ...arcs.slice(2)]
  const bytes: number[] = []
  for (const value of values) {
    let rest = value
    const encoded: number[] = [rest & 0x7f]
    rest = Math.floor(rest / 128)
    while (rest > 0) {
      encoded.unshift((rest & 0x7f) | 0x80)
      rest = Math.floor(rest / 128)
    }
    bytes.push(...encoded)
  }
  return Buffer.from(bytes)
}

function oid(spec: string): Buffer {
  return tlv(0x06, oidContent(spec))
}

function utf8String(text: string): Buffer {
  return tlv(0x0c, Buffer.from(text, 'utf8'))
}

/** ASN.1 UTCTime (YYMMDDHHMMSSZ); valid for dates through 2049. */
function utcTime(date: Date): Buffer {
  const stamp = date.toISOString().slice(2).replace(/[-:T]/g, '').replace(/\.\d{3}/, '')
  return tlv(0x17, Buffer.from(stamp, 'ascii'))
}

function bitString(data: Buffer, unusedBits = 0): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), data]))
}

function nameEntry(oidSpec: string, value: string): Buffer {
  return sequence(oid(oidSpec), utf8String(value))
}

function setOf(...children: Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(children))
}

function distinguishedName(commonName: string): Buffer {
  // X.509 Name = RDNSequence = SEQUENCE of SET of SEQUENCE { OID, value }.
  return sequence(setOf(nameEntry(CN_OID, commonName)))
}

/**
 * One X.509 extension: Extension ::= SEQUENCE { extnID, critical?,
 * extnValue } — the fields are direct children (no inner AlgorithmIdentifier
 * wrapper).
 */
function extension(oidSpec: string, value: Buffer, critical = false): Buffer {
  return sequence(
    oid(oidSpec),
    ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []),
    tlv(0x04, value),
  )
}

/** Extension content builders. */
function basicConstraintsCaFalse(): Buffer {
  // cA BOOLEAN DEFAULT FALSE: DER requires defaulted fields to be omitted.
  return sequence()
}

function keyUsageDigitalSignatureKeyEncipherment(): Buffer {
  // digitalSignature(0) | keyEncipherment(2) => 0b1010_0000 = 0xA0;
  // five trailing zero bits are the unused-bit count.
  return bitString(Buffer.from([0xa0]), 5)
}

function extKeyUsageServerAuth(): Buffer {
  return sequence(oid(SERVER_AUTH_OID))
}

/** Expand an IPv6 literal into its 16 bytes (handles `::` compression). */
function ipv6Bytes(literal: string): Buffer {
  const [head, tail] = literal.split('::') as [string, string | undefined]
  const headGroups = head.length === 0 ? [] : head.split(':')
  const tailGroups = tail === undefined || tail.length === 0 ? [] : tail.split(':')
  const missing = 8 - headGroups.length - tailGroups.length
  const groups = [...headGroups, ...Array.from({ length: missing }, () => '0'), ...tailGroups]
  if (groups.length !== 8) throw new TypeError(`invalid IPv6 address ${JSON.stringify(literal)}`)
  const bytes: number[] = []
  for (const group of groups) {
    const value = Number.parseInt(group.length === 0 ? '0' : group, 16)
    if (!Number.isFinite(value) || value > 0xffff) throw new TypeError(`invalid IPv6 address ${JSON.stringify(literal)}`)
    bytes.push((value >> 8) & 0xff, value & 0xff)
  }
  return Buffer.from(bytes)
}

/** SAN entries: [2] dNSName for hostnames, [7] iPAddress for IP literals. */
function subjectAltName(altNames: readonly string[]): Buffer {
  const names = altNames.map((name) => {
    const trimmed = name.trim()
    const isIp = trimmed.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)
    if (isIp) {
      const ip = trimmed.includes(':') ? ipv6Bytes(trimmed) : Buffer.from(trimmed.split('.').map(Number))
      return tlv(0x87, ip)
    }
    return tlv(0x82, Buffer.from(trimmed, 'utf8'))
  })
  return sequence(...names)
}

function algorithmIdentifier(): Buffer {
  // ecdsa-with-SHA256; RFC 5758 requires parameters to be absent.
  return sequence(oid(ECDSA_SHA256_OID))
}

/** Build the TBSCertificate and sign it with the EC private key. */
function signTbs(tbs: Buffer, privateKey: KeyObject): Buffer {
  return createSign('sha256').update(tbs).end().sign(privateKey)
}

/**
 * Generate one self-signed certificate.
 * @param options - identity and validity parameters.
 * @returns PEM materials plus the DER fingerprint shown to users.
 */
export function createSelfSignedCertificate(options: SelfSignedOptions): SelfSignedCertificate {
  const days = options.days ?? 3650
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })

  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const now = new Date()
  const notBefore = new Date(now.getTime() - 5 * 60 * 1000)
  const notAfter = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)

  const serial = randomBytes(8)
  serial[0] = serial[0]! & 0x7f // keep the INTEGER positive

  const extensions = sequence(
    extension(BASIC_CONSTRAINTS_OID, basicConstraintsCaFalse(), true),
    extension(KEY_USAGE_OID, keyUsageDigitalSignatureKeyEncipherment(), true),
    extension(EXT_KEY_USAGE_OID, extKeyUsageServerAuth()),
    extension(SUBJECT_ALT_NAME_OID, subjectAltName([options.commonName, ...options.altNames])),
  )

  const tbs = sequence(
    tlv(0xa0, integer(2)), // [0] EXPLICIT version 3
    integer(serial),
    algorithmIdentifier(),
    distinguishedName(options.commonName),
    sequence(utcTime(notBefore), utcTime(notAfter)),
    distinguishedName(options.commonName),
    // SPKI exported by Node already carries its own AlgorithmIdentifier.
    spki,
    tlv(0xa3, extensions), // [3] EXPLICIT extensions
  )

  const signature = signTbs(tbs, privateKey)
  const der = sequence(tbs, algorithmIdentifier(), bitString(signature))
  const fingerprintHex = createHash('sha256').update(der).digest('hex')

  return {
    cert: pem('CERTIFICATE', der),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString('ascii'),
    fingerprint: groupFingerprint(fingerprintHex),
  }
}

function groupFingerprint(hex: string): string {
  return (hex.match(/.{2}/g) ?? []).join(':').toUpperCase()
}

function pem(label: string, der: Buffer): string {
  const base64 = der.toString('base64').match(/.{1,64}/g)?.join('\n') ?? ''
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`
}
