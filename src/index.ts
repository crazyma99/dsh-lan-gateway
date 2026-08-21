/**
 * dsh-lan-gateway — the Cordis host half. It mounts the LAN gateway engine,
 * owns a loopback-only configuration RPC (config.get / config.set /
 * status), and persists configuration to `$DSH_HOME/lan-gateway/config.json`.
 *
 * The dsh Web settings plane serves only an explicit namespace allowlist, so
 * this plugin intentionally does NOT use the settings seam — its own RPC
 * keeps the plugin self-contained and the loopback authority keeps the
 * configuration surface off the LAN, mirroring the settings plane's posture.
 * @module dsh-lan-gateway
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only merges: ctx.webServer (host-webserver) and ctx.connection
// (client-connection's host half).
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import { join } from 'node:path'
import { defaultDataDir, LanGatewayEngine } from './gateway.ts'
import { ConfigStore, isWritableField, normalizeFieldValue } from './config-store.ts'
import {
  CONFIG_GET_ENDPOINT,
  CONFIG_SET_ENDPOINT,
  LanGatewaySettingsSchema,
  STATUS_RPC_CHANNEL,
  STATUS_RPC_ENDPOINT,
  publicConfig,
  type LanGatewaySettings,
} from './settings.ts'

export type { GatewayConfig, GatewayStatus } from './gateway.ts'
export type { LanGatewayPublicConfig, LanGatewaySettings } from './settings.ts'
export {
  CONFIG_GET_ENDPOINT,
  CONFIG_SET_ENDPOINT,
  DEFAULT_LAN_GATEWAY_CONFIG,
  LanGatewaySettingsSchema,
  STATUS_RPC_CHANNEL,
  STATUS_RPC_ENDPOINT,
} from './settings.ts'
export { defaultDataDir, LanGatewayEngine } from './gateway.ts'

/** Stable Cordis plugin name. */
export const name = 'lan-gateway'

/** Composition entry config: deployment defaults the persisted file layers over. */
export interface Config extends LanGatewaySettings {}

export const Config = LanGatewaySettingsSchema

/** Build one RPC success result. */
function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

/** Build one RPC failure result from a validation or handler error. */
function badRequest(message: string): { ok: false; error: { code: 'bad-request'; message: string; details: { issues: never[] } } } {
  return {
    ok: false,
    error: { code: 'bad-request', message, details: { issues: [] } },
  }
}

export function apply(ctx: Context, config: LanGatewaySettings): void {
  const dataDir = defaultDataDir()
  const store = new ConfigStore(join(dataDir, 'config.json'), config)
  const engine = new LanGatewayEngine({
    // Read the Web server port lazily: at apply time the webserver row may not
    // have activated yet, and the port never changes during a run.
    targetPort: () => ctx.get('webServer')?.port ?? 3080,
    dataDir,
  })
  engine.apply(store.get())

  // Teardown: stop the gateway when this plugin's fiber is disposed.
  ctx.effect(() => () => {
    void engine.stop()
  }, 'lan-gateway: teardown')

  // Register the config/status RPC lazily once the connection transport
  // exists; the channel's route lands on the connection service's webserver.
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => connectionCtx.connection.rpc.handle(
      STATUS_RPC_CHANNEL,
      async (endpoint, payload) => {
        if (endpoint === STATUS_RPC_ENDPOINT) {
          return ok(engine.getStatus())
        }
        if (endpoint === CONFIG_GET_ENDPOINT) {
          return ok(publicConfig(store.get()))
        }
        if (endpoint === CONFIG_SET_ENDPOINT) {
          const patch = payload as { field?: unknown; value?: unknown } | null
          const field = typeof patch?.field === 'string' ? patch.field : undefined
          if (field === undefined || !isWritableField(field)) {
            return badRequest(`lan-gateway: field ${JSON.stringify(String(field))} is not writable`)
          }
          let value: unknown
          try {
            value = normalizeFieldValue(field, patch?.value)
          } catch (error) {
            return badRequest(error instanceof Error ? error.message : String(error))
          }
          let next: LanGatewaySettings
          try {
            next = store.update({ [field]: value } as Partial<LanGatewaySettings>)
          } catch (error) {
            return badRequest(error instanceof Error ? error.message : String(error))
          }
          engine.apply(next)
          return ok(publicConfig(next))
        }
        return badRequest(`lan-gateway: unknown endpoint ${JSON.stringify(endpoint)}`)
      },
      // Loopback only: a LAN client can use the gateway but never read or
      // change its management surface — mirroring the settings plane's own
      // posture, and the password never crosses this boundary.
      { authority: 'loopback' },
    ), 'lan-gateway: config/status rpc')
  })
}
