/**
 * Browser-side store for the lan-gateway section: config and status snapshots
 * backed by the loopback-only /lan-gateway RPC channel, polled while the
 * gateway is enabled. This plugin owns its configuration transport (the dsh
 * Web settings plane does not expose external plugin namespaces yet).
 */
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { GatewayStatus } from '../gateway.ts'
import type { LanGatewayPublicConfig } from '../settings.ts'
import { CONFIG_GET_ENDPOINT, CONFIG_SET_ENDPOINT, STATUS_RPC_CHANNEL, STATUS_RPC_ENDPOINT } from '../settings.ts'

export interface LanGatewaySnapshot {
  config: LanGatewayPublicConfig | undefined
  status: GatewayStatus | undefined
}

type RpcResult = { ok: true; value: unknown } | { ok: false; error?: { message?: string } }

const POLL_MS = 2000

export class LanGatewayStore {
  private snapshot: LanGatewaySnapshot = { config: undefined, status: undefined }
  private readonly listeners = new Set<() => void>()
  private pollTimer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly connection: ConnectionHandle) {}

  /** Stable reference until the snapshot changes (uSES contract). */
  getSnapshot(): LanGatewaySnapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(partial: Partial<LanGatewaySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial }
    for (const listener of this.listeners) listener()
  }

  private async call(endpoint: string, payload: unknown): Promise<RpcResult> {
    return await this.connection.rpc.call(STATUS_RPC_CHANNEL, endpoint, payload) as RpcResult
  }

  /** Initial config read. */
  async load(): Promise<void> {
    const result = await this.call(CONFIG_GET_ENDPOINT, {})
    if (result.ok === true) this.set({ config: result.value as LanGatewayPublicConfig })
  }

  /** One status read; also refreshes hasPassword alongside the config. */
  async pollStatus(): Promise<void> {
    const [statusResult, configResult] = await Promise.all([
      this.call(STATUS_RPC_ENDPOINT, {}),
      this.call(CONFIG_GET_ENDPOINT, {}),
    ])
    if (statusResult.ok === true) this.set({ status: statusResult.value as GatewayStatus })
    if (configResult.ok === true) this.set({ config: configResult.value as LanGatewayPublicConfig })
  }

  /** Start periodic status polling (idempotent). */
  startPolling(): void {
    if (this.pollTimer !== undefined) return
    this.pollTimer = setInterval(() => {
      void this.pollStatus()
    }, POLL_MS)
  }

  stopPolling(): void {
    if (this.pollTimer === undefined) return
    clearInterval(this.pollTimer)
    this.pollTimer = undefined
  }

  /**
   * Write one field through the host. Returns the new public config on
   * success, or undefined when the host refused the write.
   */
  async setField(field: keyof LanGatewayPublicConfig | 'password', value: unknown): Promise<LanGatewayPublicConfig | undefined> {
    const result = await this.call(CONFIG_SET_ENDPOINT, { field, value })
    if (result.ok !== true) return undefined
    const config = result.value as LanGatewayPublicConfig
    this.set({ config })
    return config
  }
}
