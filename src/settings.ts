/**
 * The lan-gateway configuration shape and validation.
 *
 * The dsh Web settings plane only serves an explicit namespace allowlist
 * (`WEB_SETTINGS_NAMESPACES` in dsh-host-apiproxy), so an external plugin
 * cannot expose its own settings namespace yet. This plugin therefore owns a
 * loopback-only RPC surface (config.get / config.set) and persists its
 * configuration to `$DSH_HOME/lan-gateway/config.json` (mode 0600). The
 * password is never returned by any endpoint — only `hasPassword`.
 * @module dsh-lan-gateway/settings
 */

import z from '@deepseek-ai/schemastery'

/** Resolved configuration shape, shared by host and client type surfaces. */
export interface LanGatewaySettings {
  enabled: boolean
  port: number
  tlsMode: 'self-signed' | 'provided'
  certPath: string
  keyPath: string
  username: string
  password: string
  allowlist: string[]
}

/** Client-facing projection: everything except the password. */
export interface LanGatewayPublicConfig {
  enabled: boolean
  port: number
  tlsMode: 'self-signed' | 'provided'
  certPath: string
  keyPath: string
  username: string
  allowlist: string[]
  hasPassword: boolean
}

/** The RPC channel carrying gateway config and status to the settings page. */
export const STATUS_RPC_CHANNEL = '/lan-gateway'
export const STATUS_RPC_ENDPOINT = 'status'
export const CONFIG_GET_ENDPOINT = 'config.get'
export const CONFIG_SET_ENDPOINT = 'config.set'

/** Deployment defaults the persisted file layers over. */
export const DEFAULT_LAN_GATEWAY_CONFIG: LanGatewaySettings = {
  enabled: false,
  port: 8443,
  tlsMode: 'self-signed',
  certPath: '',
  keyPath: '',
  username: 'dsh',
  password: '',
  allowlist: [],
}

export const LanGatewaySettingsSchema: z<LanGatewaySettings> = z.object({
  enabled: z.boolean().default(false),
  port: z.natural().default(8443),
  tlsMode: z.union([z.const('self-signed'), z.const('provided')]).default('self-signed'),
  certPath: z.string().default(''),
  keyPath: z.string().default(''),
  username: z.string().default('dsh'),
  password: z.string().role('secret').default(''),
  allowlist: z.array(z.string()).default([]),
})

/**
 * Cross-field validation the schema cannot express. Throwing refuses the
 * write that produced the value, so the settings UI learns immediately.
 * @param value - schema-valid resolved section.
 */
export function validateLanGatewaySettings(value: LanGatewaySettings): void {
  if (!value.enabled) return
  if (value.password.length === 0) {
    throw new Error('lan-gateway: enabling requires a non-empty password')
  }
  if (value.port > 65535) {
    throw new Error(`lan-gateway: port must be at most 65535, got ${String(value.port)}`)
  }
  if (value.tlsMode === 'provided' && (value.certPath.length === 0 || value.keyPath.length === 0)) {
    throw new Error('lan-gateway: provided TLS mode requires both certPath and keyPath')
  }
}

/** Redact the password into a wire-safe public view. */
export function publicConfig(value: LanGatewaySettings): LanGatewayPublicConfig {
  return {
    enabled: value.enabled,
    port: value.port,
    tlsMode: value.tlsMode,
    certPath: value.certPath,
    keyPath: value.keyPath,
    username: value.username,
    allowlist: [...value.allowlist],
    hasPassword: value.password.length > 0,
  }
}
