/**
 * JSON-file persistence for the gateway configuration, layered over the
 * deployment defaults from the composition row config. The file lives at
 * `$DSH_HOME/lan-gateway/config.json` and holds the password, so it is
 * written with mode 0600.
 * @module dsh-lan-gateway/config-store
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_LAN_GATEWAY_CONFIG,
  validateLanGatewaySettings,
  type LanGatewaySettings,
} from './settings.ts'

/** One field-level patch accepted by the config.set RPC. */
export type ConfigPatch = Partial<LanGatewaySettings>

const STRING_FIELDS = new Set(['tlsMode', 'certPath', 'keyPath', 'username', 'password'])
const BOOLEAN_FIELDS = new Set(['enabled'])
const NUMBER_FIELDS = new Set(['port'])
const ARRAY_FIELDS = new Set(['allowlist'])
const WRITABLE_FIELDS = new Set([
  ...STRING_FIELDS, ...BOOLEAN_FIELDS, ...NUMBER_FIELDS, ...ARRAY_FIELDS,
])

/** Whether one field is writable through config.set. */
export function isWritableField(field: string): boolean {
  return WRITABLE_FIELDS.has(field)
}

/** Validate one field's wire value; returns a normalized value or throws. */
export function normalizeFieldValue(field: string, value: unknown): unknown {
  if (STRING_FIELDS.has(field)) {
    if (typeof value !== 'string') throw new TypeError(`lan-gateway: ${field} must be a string`)
    if (field === 'tlsMode' && value !== 'self-signed' && value !== 'provided') {
      throw new TypeError('lan-gateway: tlsMode must be self-signed or provided')
    }
    return value
  }
  if (BOOLEAN_FIELDS.has(field)) {
    if (typeof value !== 'boolean') throw new TypeError(`lan-gateway: ${field} must be a boolean`)
    return value
  }
  if (NUMBER_FIELDS.has(field)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`lan-gateway: ${field} must be a number`)
    }
    return value
  }
  if (ARRAY_FIELDS.has(field)) {
    if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
      throw new TypeError('lan-gateway: allowlist must be an array of strings')
    }
    return value
  }
  throw new TypeError(`lan-gateway: field ${JSON.stringify(field)} is not writable`)
}

export class ConfigStore {
  private current: LanGatewaySettings

  constructor(
    private readonly path: string,
    private readonly base: LanGatewaySettings,
  ) {
    this.current = this.load()
  }

  /** Current resolved configuration. */
  get(): LanGatewaySettings {
    return this.current
  }

  /** Apply one validated field patch, persist it, and return the new config. */
  update(patch: ConfigPatch): LanGatewaySettings {
    const next: LanGatewaySettings = { ...this.current, ...patch }
    validateLanGatewaySettings(next)
    this.persist(next)
    this.current = next
    return next
  }

  private load(): LanGatewaySettings {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>
      const candidate: LanGatewaySettings = {
        ...DEFAULT_LAN_GATEWAY_CONFIG,
        ...this.base,
        ...(raw as Partial<LanGatewaySettings>),
      }
      // Validate shape from the file; a malformed file falls back to defaults
      // so the gateway can never boot into a corrupted state.
      validateLanGatewaySettings(candidate)
      return candidate
    } catch {
      return { ...DEFAULT_LAN_GATEWAY_CONFIG, ...this.base }
    }
  }

  private persist(value: LanGatewaySettings): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  }
}
