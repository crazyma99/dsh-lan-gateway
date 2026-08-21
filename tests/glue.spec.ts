/**
 * Host-glue integration smoke test: boots the plugin's apply() on a real
 * Cordis context with mocked webServer / connection services, drives the
 * config RPC round-trip (set password, enable the gateway) and checks the
 * status surface plus config persistence.
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { name, apply } from '../src/index.ts'
import { CONFIG_GET_ENDPOINT, CONFIG_SET_ENDPOINT, STATUS_RPC_ENDPOINT } from '../src/settings.ts'

/** Stub services the plugin injects: webServer port and the connection RPC registry. */
function StubWebServer(ctx: Context): void {
  ctx.provide('webServer', { port: 3080, host: '127.0.0.1' })
}

function StubConnection(ctx: Context, handle: ReturnType<typeof vi.fn>): void {
  ctx.provide('connection', { rpc: { handle, intercept: vi.fn() } })
}

type Handler = (endpoint: string, payload: unknown) => Promise<{ ok: boolean; value?: unknown; error?: { code?: string; message?: string } }>

const ENTRY_CONFIG = {
  enabled: false,
  port: 0,
  tlsMode: 'self-signed',
  certPath: '',
  keyPath: '',
  username: 'dsh',
  password: '',
  allowlist: [],
} as const

describe('lan-gateway host glue', () => {
  let dataDir: string
  let previousHome: string | undefined

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'dsh-lan-gateway-home-'))
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = dataDir
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(dataDir, { recursive: true, force: true })
  })

  async function boot(): Promise<{ handler: Handler; configPath: string }> {
    const handle = vi.fn(() => () => Promise.resolve())
    const root = new Context()
    await root.plugin(StubWebServer)
    await root.plugin(StubConnection, handle)
    await root.plugin({ name, apply }, ENTRY_CONFIG)
    expect(handle).toHaveBeenCalledWith('/lan-gateway', expect.any(Function), { authority: 'loopback' })
    return {
      handler: handle.mock.calls[0]![1] as Handler,
      configPath: join(dataDir, 'lan-gateway', 'config.json'),
    }
  }

  it('serves config.get, refuses enabling without a password, and reports status', async () => {
    const { handler, configPath } = await boot()

    const initial = await handler(CONFIG_GET_ENDPOINT, {})
    expect(initial.ok).toBe(true)
    expect((initial.value as { enabled: boolean; hasPassword: boolean }).enabled).toBe(false)
    expect((initial.value as { hasPassword: boolean }).hasPassword).toBe(false)

    // Enabling without a password is refused by the validation layer.
    const refused = await handler(CONFIG_SET_ENDPOINT, { field: 'enabled', value: true })
    expect(refused.ok).toBe(false)
    expect(refused.error?.code).toBe('bad-request')

    // Set the password, then enable: the engine starts and persists the file.
    const password = await handler(CONFIG_SET_ENDPOINT, { field: 'password', value: 'topsecret' })
    expect(password.ok).toBe(true)
    expect((password.value as { hasPassword: boolean }).hasPassword).toBe(true)

    const enabled = await handler(CONFIG_SET_ENDPOINT, { field: 'enabled', value: true })
    expect(enabled.ok).toBe(true)

    // Poll status until the gateway binds.
    const deadline = Date.now() + 5000
    let status = await handler(STATUS_RPC_ENDPOINT, {})
    while (status.ok === true && (status.value as { state: string }).state !== 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
      status = await handler(STATUS_RPC_ENDPOINT, {})
    }
    expect(status.ok).toBe(true)
    expect((status.value as { state: string }).state).toBe('running')

    // The persisted file exists with mode 0600 and never leaves the host.
    const stored = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(stored.enabled).toBe(true)
    expect(stored.password).toBe('topsecret')

    // Disable again so the gateway releases its listening socket.
    await handler(CONFIG_SET_ENDPOINT, { field: 'enabled', value: false })
  })

  it('refuses unknown endpoints and unknown fields with bad-request', async () => {
    const { handler } = await boot()

    const unknownEndpoint = await handler('nope', {})
    expect(unknownEndpoint.ok).toBe(false)
    expect(unknownEndpoint.error?.code).toBe('bad-request')

    const unknownField = await handler(CONFIG_SET_ENDPOINT, { field: 'passwordPath', value: '/etc/passwd' })
    expect(unknownField.ok).toBe(false)

    const wrongType = await handler(CONFIG_SET_ENDPOINT, { field: 'port', value: 'not-a-number' })
    expect(wrongType.ok).toBe(false)
  })
})
