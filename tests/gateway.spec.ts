import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LanGatewayEngine, type GatewayConfig } from '../src/gateway.ts'

/** The loopback upstream the gateway fronts. */
class Upstream {
  readonly server: http.Server
  readonly port: number
  seenHost: string | undefined
  seenOrigin: string | undefined
  seenUpgradeHead: string | undefined

  constructor() {
    this.server = http.createServer((req, res) => {
      this.seenHost = req.headers.host
      this.seenOrigin = req.headers.origin
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, host: req.headers.host, origin: req.headers.origin }))
    })
    this.server.on('upgrade', (req, socket, head) => {
      this.seenUpgradeHead = `${req.method} ${req.url} host=${String(req.headers.host)} origin=${String(req.headers.origin ?? '')}`
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n')
      socket.on('data', data => socket.write(data))
      socket.on('end', () => socket.destroy())
    })
    this.port = 0
  }

  /** Begin listening and resolve once the OS has assigned the port. */
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('listening', resolve)
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1')
    })
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('upstream address unavailable')
    ;(this as { port: number }).port = address.port
  }

  async close(): Promise<void> {
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }
}

function config(overrides: Partial<GatewayConfig>): GatewayConfig {
  return {
    enabled: true,
    port: 0,
    tlsMode: 'self-signed',
    certPath: '',
    keyPath: '',
    username: 'dsh',
    password: 's3cret',
    allowlist: [],
    ...overrides,
  }
}

async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (predicate(value)) return value
    if (Date.now() > deadline) throw new Error(`waitFor timed out; last value: ${JSON.stringify(value)}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

function httpsGet(port: number, options: { auth?: string; origin?: string }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: '127.0.0.1',
      port,
      path: '/hello',
      method: 'GET',
      rejectUnauthorized: false,
      headers: {
        ...(options.auth !== undefined ? { authorization: `Basic ${Buffer.from(options.auth).toString('base64')}` } : {}),
        ...(options.origin !== undefined ? { origin: options.origin } : {}),
      },
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }))
    })
    request.on('error', reject)
    request.end()
  })
}

describe('LanGatewayEngine', () => {
  let upstream: Upstream | undefined
  let engine: LanGatewayEngine | undefined
  let dataDir: string | undefined

  beforeEach(async () => {
    upstream = new Upstream()
    await upstream!.listen()
    dataDir = mkdtempSync(join(tmpdir(), 'dsh-lan-gateway-'))
    engine = new LanGatewayEngine({ targetPort: () => upstream!.port, dataDir })
  })

  afterEach(async () => {
    await engine?.stop()
    await upstream?.close()
    if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true })
  })

  it('starts with a self-signed cert and reports running status', async () => {
    engine!.apply(config({}))
    const status = await waitFor(() => engine!.getStatus(), value => value.state === 'running')
    expect(status.port).toBeGreaterThan(0)
    expect(status.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    expect(status.hasPassword).toBe(true)
    expect(status.urls.length).toBeGreaterThan(0)
    expect(status.urls.every(url => url.startsWith('https://'))).toBe(true)
  })

  it('requires authentication: 401 without, 401 with wrong credentials, 200 with correct ones', async () => {
    engine!.apply(config({}))
    const status = await waitFor(() => engine!.getStatus(), value => value.state === 'running')

    const anonymous = await httpsGet(status.port!, {})
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers['www-authenticate']).toContain('Basic realm="dsh-lan-gateway"')

    const wrong = await httpsGet(status.port!, { auth: 'dsh:wrong' })
    expect(wrong.status).toBe(401)

    const right = await httpsGet(status.port!, { auth: 'dsh:s3cret', origin: 'http://192.168.1.5:8443' })
    expect(right.status).toBe(200)
    // The backend must see a loopback Host/Origin so its trust fence passes.
    expect(upstream!.seenHost).toBe(`127.0.0.1:${String(upstream!.port)}`)
    expect(upstream!.seenOrigin).toBe(`http://127.0.0.1:${String(upstream!.port)}`)
  })

  it('enforces the IP allowlist', async () => {
    engine!.apply(config({ allowlist: ['10.99.99.0/24'] }))
    const status = await waitFor(() => engine!.getStatus(), value => value.state === 'running')
    const blocked = await httpsGet(status.port!, { auth: 'dsh:s3cret' })
    expect(blocked.status).toBe(403)

    engine!.apply(config({ allowlist: ['127.0.0.0/8'] }))
    const restarted = await waitFor(() => engine!.getStatus(), value => value.state === 'running')
    const admitted = await httpsGet(restarted.port!, { auth: 'dsh:s3cret' })
    expect(admitted.status).toBe(200)
  })

  it('refuses privileged settings/credentials RPCs through the gateway', async () => {
    engine!.apply(config({}))
    const status = await waitFor(() => engine!.getStatus(), value => value.state === 'running')
    // The harness pins the settings plane to loopback; the gateway must keep
    // LAN clients out even though it rewrites Host to loopback.
    const ordinary = await httpsGet(status.port!, { auth: 'dsh:s3cret', origin: 'http://192.168.1.5:8443' })
    expect(ordinary.status).toBe(200) // ordinary traffic still flows

    const privileged = await new Promise<{ status: number }>((resolve, reject) => {
      const request = https.request({
        host: '127.0.0.1',
        port: status.port!,
        path: '/api/settings.describe',
        method: 'POST',
        rejectUnauthorized: false,
        headers: { authorization: `Basic ${Buffer.from('dsh:s3cret').toString('base64')}` },
      }, (response) => {
        response.resume()
        resolve({ status: response.statusCode ?? 0 })
      })
      request.on('error', reject)
      request.end('{}')
    })
    expect(privileged.status).toBe(403)

    // The plugin's own management channel must be equally unreachable.
    const management = await new Promise<{ status: number }>((resolve, reject) => {
      const request = https.request({
        host: '127.0.0.1',
        port: status.port!,
        path: '/lan-gateway/config.get',
        method: 'POST',
        rejectUnauthorized: false,
        headers: { authorization: `Basic ${Buffer.from('dsh:s3cret').toString('base64')}` },
      }, (response) => {
        response.resume()
        resolve({ status: response.statusCode ?? 0 })
      })
      request.on('error', reject)
      request.end('{}')
    })
    expect(management.status).toBe(403)
  })

  it('proxies WebSocket upgrades with rewritten Host and Origin', async () => {
    engine!.apply(config({}))
    const status = await waitFor(() => engine!.getStatus(), value => value.state === 'running')

    await new Promise<void>((resolve, reject) => {
      const socket = tls.connect({
        host: '127.0.0.1',
        port: status.port!,
        rejectUnauthorized: false,
      }, () => {
        socket.write([
          'GET /upgrade HTTP/1.1',
          `Host: 127.0.0.1:${String(status.port)}`,
          `Authorization: Basic ${Buffer.from('dsh:s3cret').toString('base64')}`,
          'Upgrade: echo',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          'Origin: http://192.168.1.5:8443',
          '',
          '',
        ].join('\r\n'))
      })
      socket.on('error', reject)
      socket.on('data', (data) => {
        const text = data.toString('utf8')
        if (text.includes('101')) {
          socket.end()
          resolve()
        }
      })
      setTimeout(() => reject(new Error('upgrade timed out')), 5000)
    })
    expect(upstream!.seenUpgradeHead).toContain(`host=127.0.0.1:${String(upstream!.port)}`)
    expect(upstream!.seenUpgradeHead).toContain(`origin=http://127.0.0.1:${String(upstream!.port)}`)
  })

  it('stops on disable and reports off', async () => {
    engine!.apply(config({}))
    await waitFor(() => engine!.getStatus(), value => value.state === 'running')
    engine!.apply(config({ enabled: false }))
    const stopped = await waitFor(() => engine!.getStatus(), value => value.state === 'off')
    expect(stopped.port).toBeUndefined()
  })

  it('surfaces bind failures as error status', async () => {
    const blocker = net.createServer()
    await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve))
    const blockerPort = (blocker.address() as net.AddressInfo).port
    try {
      engine!.apply(config({ port: blockerPort }))
      const status = await waitFor(() => engine!.getStatus(), value => value.state === 'error')
      expect(status.error).toMatch(/EADDRINUSE|address already in use/i)
    } finally {
      await new Promise<void>(resolve => blocker.close(() => resolve()))
    }
  })

  it('rejects provided TLS mode without certificate paths', async () => {
    engine!.apply(config({ tlsMode: 'provided' }))
    const status = await waitFor(() => engine!.getStatus(), value => value.state === 'error')
    expect(status.error).toContain('certificate and key paths')
  })
})
