/**
 * dsh-lan-gateway — browser half. Registers the LAN Access settings section
 * (slot `settings.section`) and wires it to the loopback-only /lan-gateway
 * config/status RPC through the LanGatewayStore.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the settings slot contract.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls ctx.locale.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { LanGatewaySection } from './LanGatewaySection.tsx'
import type { LanGatewaySectionInjected } from './LanGatewaySection.tsx'
import { LanGatewayStore } from './store.ts'
import { en, zh, type LanGatewayKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.lan-gateway': LanGatewayKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.lan-gateway'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection']

/**
 * Register the LAN Access section once the `settings.section` slot
 * declaration is on the ledger, and wire the store to the connection.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'lan-gateway: copy dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  const store = new LanGatewayStore(connection)
  void store.load()
  const t = ctx.locale.bind(NS)
  const injected = (): LanGatewaySectionInjected => ({ store, connection, t })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'lan-gateway',
    order: 70,
    label: () => t('nav'),
    inject: injected,
  }, LanGatewaySection))
}
