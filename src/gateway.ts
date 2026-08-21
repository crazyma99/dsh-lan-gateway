/**
 * The LAN gateway engine: an opt-in HTTPS reverse proxy in front of the
 * loopback-only dsh WebUI. It owns TLS termination, Basic authentication, an
 * IP allowlist, and Host/Origin rewriting so the backend always sees a
 * loopback request (keeping the built-in /api trust fence intact).
 *
 * This module is pure Node — no Cordis imports — so it can be unit-tested
 * without a running harness. `src/index.ts` is the thin Cordis adapter.
 * @module dsh-lan-gateway/gateway
 */

import { createHash, X509Certificate } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { networkInterfaces } from 'node:os'
import { Duplex } from 'node:stream'
import { BASIC_CHALLENGE, credentialsMatch, parseBasicAuth } from './auth.ts'
import { isAllowed } from './cidr.ts'
import { createSelfSignedCertificate } from './selfsigned.ts'

/** User-facing configuration snapshot (mirrors the settings namespace). */
export interface GatewayConfig {
  readonly enabled: boolean
  readonly port: number
  readonly tlsMode: 'self-signed' | 'provided'
  readonly certPath: string
  readonly keyPath: string
  readonly username: string
  readonly password: string
  readonly allowlist: readonly string[]
}

/** Live state reported to the settings page over the status RPC. */
export interface GatewayStatus {
  readonly state: 'off' | 'starting' | 'running' | 'error'
  readonly error?: string
  readonly port?: number
  readonly fingerprint?: string
  readonly urls: readonly string[]
  readonly activeConnections: number
  readonly hasPassword: boolean
}

/** Engine dependencies resolved by the Cordis adapter. */
export interface LanGatewayEngineOptions {
  /** Loopback port of the dsh WebUI this gateway fronts, read lazily. */
  readonly targetPort: () => number
  /** Directory holding the generated self-signed certificate. */
  readonly dataDir: string
}

interface TlsMaterial {
  readonly cert: string
  readonly key: string
  readonly fingerprint: string
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * Headers skipped when re-emitting a raw upgrade request. `connection` and
 * `upgrade` MUST survive (that is what makes the upstream classify the
 * request as an upgrade), so this is a narrower set than HOP_BY_HOP.
 */
const UPGRADE_SKIP = new Set([
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
])

/**
 * RPC methods the gateway refuses to forward, mirroring the harness's
 * loopback-pinned privileged plane (`PRIVILEGED_METHODS` in
 * dsh-client-connection): settings, credentials, model discovery, preset
 * management, and host dialogs. The gateway rewrites Host to loopback, which
 * would otherwise make these methods look loopback-originated and defeat the
 * harness's own fence — so the gateway re-establishes the boundary itself.
 * Keep this list in sync with the harness's PRIVILEGED_METHODS when upgrading.
 */
const PRIVILEGED_API_PREFIXES = [
  '/api/settings.',
  '/api/credentials.',
  '/api/llm.discoverModels',
  '/api/agentPreset.read',
  '/api/agentPreset.copy',
  '/api/agentPreset.openDocument',
  '/api/agentPreset.remove',
  '/api/host.pickDirectory',
  '/api/host.openPath',
  // This plugin's own management channel: config/status stay loopback-only.
  '/lan-gateway',
]

/** Whether one request path targets the privileged, loopback-pinned RPC plane. */
function isPrivilegedApiPath(pathname: string): boolean {
  return PRIVILEGED_API_PREFIXES.some(prefix => pathname.startsWith(prefix))
}

/** IPv4 literals of every non-internal interface, for display and SAN entries. */
function lanIpv4Addresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((iface): iface is NonNullable<typeof iface> =>
      iface !== undefined && iface.family === 'IPv4' && !iface.internal)
    .map(iface => iface.address)
}

function sameConfig(left: GatewayConfig, right: GatewayConfig): boolean {
  return left.enabled === right.enabled
    && left.port === right.port
    && left.tlsMode === right.tlsMode
    && left.certPath === right.certPath
    && left.keyPath === right.keyPath
    && left.username === right.username
    && left.password === right.password
    && JSON.stringify([...left.allowlist]) === JSON.stringify([...right.allowlist])
}

export class LanGatewayEngine {
  private server: https.Server | undefined
  private readonly sockets = new Set<Duplex>()
  private generation = 0
  private current: GatewayConfig | undefined
  private statusValue: GatewayStatus = { state: 'off', urls: [], activeConnections: 0, hasPassword: false }

  constructor(private readonly options: LanGatewayEngineOptions) {}

  /** Reconcile the engine with a (possibly changed) configuration snapshot. */
  apply(config: GatewayConfig): void {
    if (this.current !== undefined && sameConfig(this.current, config)) return
    this.current = config
    const generation = ++this.generation
    if (!config.enabled) {
      this.statusValue = { state: 'off', urls: [], activeConnections: 0, hasPassword: config.password.length > 0 }
      void this.stop(generation)
      return
    }
    // Move to `starting` synchronously so observers never read a stale
    // `running` snapshot while the old server is being replaced.
    this.statusValue = {
      state: 'starting',
      urls: [],
      activeConnections: 0,
      hasPassword: config.password.length > 0,
    }
    void this.start(config, generation)
  }

  /** Current status snapshot (called from the status RPC). */
  getStatus(): GatewayStatus {
    const status = { ...this.statusValue }
    return {
      ...status,
      activeConnections: this.server === undefined ? 0 : this.countConnections(),
      hasPassword: this.current?.password !== undefined && this.current.password.length > 0,
    }
  }

  /** Close the gateway and every open socket. */
  async stop(generation = ++this.generation): Promise<void> {
    await this.closeServer()
    if (this.statusValue.state !== 'error') {
      this.statusValue = {
        state: 'off',
        urls: [],
        activeConnections: 0,
        hasPassword: this.current?.password !== undefined && this.current.password.length > 0,
      }
    }
  }

  /** Close the active server and destroy its sockets without touching status. */
  private async closeServer(): Promise<void> {
    const server = this.server
    this.server = undefined
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    if (server === undefined) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Connections that refuse to drain are destroyed above.
    })
  }

  private async start(config: GatewayConfig, generation: number): Promise<void> {
    // A configuration change restarts the gateway: close the previous server
    // (and its sockets) before binding the new one.
    await this.closeServer()
    if (generation !== this.generation) return
    let tls: TlsMaterial
    try {
      tls = this.loadTls(config)
    } catch (error) {
      this.fail(generation, error)
      return
    }
    const server = https.createServer({ cert: tls.cert, key: tls.key }, (req, res) => {
      this.handleRequest(req, res, config)
    })
    server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head, config)
    })
    server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
    server.on('error', (error) => {
      if (generation !== this.generation) return
      this.fail(generation, error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve)
        server.once('error', reject)
        server.listen(config.port, '0.0.0.0')
      })
    } catch (error) {
      if (generation !== this.generation) return
      server.close()
      this.fail(generation, error)
      return
    }
    if (generation !== this.generation) {
      server.close()
      return
    }
    this.server = server
    const port = (server.address() as net.AddressInfo).port
    this.statusValue = {
      state: 'running',
      port,
      fingerprint: tls.fingerprint,
      urls: lanIpv4Addresses().map(ip => `https://${ip}${port === 443 ? '' : `:${port}`}`),
      activeConnections: this.countConnections(),
      hasPassword: config.password.length > 0,
    }
  }

  private fail(generation: number, error: unknown): void {
    if (generation !== this.generation) return
    const message = error instanceof Error ? error.message : String(error)
    this.statusValue = {
      state: 'error',
      error: message,
      urls: [],
      activeConnections: 0,
      hasPassword: this.current?.password !== undefined && this.current.password.length > 0,
    }
  }

  private countConnections(): number {
    if (this.server === undefined) return 0
    let count = 0
    this.server.getConnections((_error, value) => {
      count = value
    })
    return count
  }

  private loadTls(config: GatewayConfig): TlsMaterial {
    if (config.tlsMode === 'provided') {
      if (config.certPath.length === 0 || config.keyPath.length === 0) {
        throw new Error('provided TLS mode requires both certificate and key paths')
      }
      const cert = readFileSync(config.certPath, 'utf8')
      const key = readFileSync(config.keyPath, 'utf8')
      let fingerprint: string
      try {
        const der = new X509Certificate(cert).raw
        fingerprint = createHash('sha256').update(der).digest('hex').match(/.{2}/g)!.join(':').toUpperCase()
      } catch {
        fingerprint = 'unavailable'
      }
      return { cert, key, fingerprint }
    }
    return this.loadOrCreateSelfSigned()
  }

  private loadOrCreateSelfSigned(): TlsMaterial {
    const { dataDir } = this.options
    const certPath = join(dataDir, 'cert.pem')
    const keyPath = join(dataDir, 'key.pem')
    try {
      const cert = readFileSync(certPath, 'utf8')
      const key = readFileSync(keyPath, 'utf8')
      const parsed = new X509Certificate(cert)
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
      if (new Date(parsed.validTo).getTime() - Date.now() > sevenDaysMs) {
        const fingerprint = createHash('sha256')
          .update(parsed.raw)
          .digest('hex')
          .match(/.{2}/g)!
          .join(':')
          .toUpperCase()
        return { cert, key, fingerprint }
      }
    } catch {
      // Missing or unparsable material: regenerate below.
    }
    const { cert, key, fingerprint } = createSelfSignedCertificate({
      commonName: 'dsh-lan-gateway',
      altNames: ['127.0.0.1', '::1', ...lanIpv4Addresses()],
    })
    mkdirSync(dirname(certPath), { recursive: true })
    writeFileSync(certPath, cert, { mode: 0o644 })
    writeFileSync(keyPath, key, { mode: 0o600 })
    return { cert, key, fingerprint }
  }

  private authorized(req: http.IncomingMessage, config: GatewayConfig): boolean {
    return credentialsMatch(parseBasicAuth(req.headers.authorization), {
      username: config.username,
      password: config.password,
    })
  }

  private denied(res: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
    res.writeHead(status, headers)
    res.end(body)
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse, config: GatewayConfig): void {
    if (!this.authorized(req, config)) {
      this.denied(res, 401, 'Unauthorized\n', { 'www-authenticate': BASIC_CHALLENGE, 'content-type': 'text/plain; charset=utf-8' })
      return
    }
    if (!isAllowed(req.socket.remoteAddress, config.allowlist)) {
      this.denied(res, 403, 'Forbidden\n')
      return
    }
    const pathname = (req.url ?? '/').split('?')[0] ?? '/'
    if (isPrivilegedApiPath(pathname)) {
      // The harness pins the settings/credentials plane to loopback; a
      // Host-rewriting proxy would smuggle it through, so refuse it here.
      this.denied(res, 403, 'Forbidden\n')
      return
    }
    this.proxyRequest(req, res)
  }

  private proxyRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const targetPort = this.options.targetPort()
    const loopbackHost = `127.0.0.1:${String(targetPort)}`
    const loopbackOrigin = `http://${loopbackHost}`
    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      const key = name.toLowerCase()
      if (HOP_BY_HOP.has(key)) continue
      if (key === 'host') continue
      if (key === 'origin') continue
      if (value === undefined) continue
      headers[name] = value
    }
    headers.host = loopbackHost
    if (req.headers.origin !== undefined) headers.origin = loopbackOrigin

    const upstream = http.request({
      host: '127.0.0.1',
      port: targetPort,
      path: req.url,
      method: req.method,
      headers,
    })
    upstream.on('response', (upstreamRes) => {
      for (const name of Object.keys(upstreamRes.headers)) {
        if (HOP_BY_HOP.has(name)) delete upstreamRes.headers[name]
      }
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    })
    upstream.on('error', (error) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      this.denied(res, 502, `Bad Gateway\n${error instanceof Error ? error.message : String(error)}\n`)
    })
    req.on('error', () => upstream.destroy())
    req.pipe(upstream)
  }

  private handleUpgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    config: GatewayConfig,
  ): void {
    if (!this.authorized(req, config)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (!isAllowed((socket as net.Socket).remoteAddress, config.allowlist)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const targetPort = this.options.targetPort()
    const loopbackHost = `127.0.0.1:${String(targetPort)}`
    const loopbackOrigin = `http://${loopbackHost}`
    const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`]
    for (const [name, value] of Object.entries(req.headers)) {
      const key = name.toLowerCase()
      if (key === 'host') {
        lines.push(`Host: ${loopbackHost}`)
        continue
      }
      if (key === 'origin') {
        lines.push(`Origin: ${loopbackOrigin}`)
        continue
      }
      if (UPGRADE_SKIP.has(key)) continue
      const values = Array.isArray(value) ? value : [value]
      for (const entry of values) {
        if (entry !== undefined) lines.push(`${name}: ${entry}`)
      }
    }
    lines.push('', '')
    const upstream = net.connect(targetPort, '127.0.0.1')
    upstream.on('connect', () => {
      upstream.write(lines.join('\r\n'))
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => upstream.destroy())
    upstream.on('close', () => socket.destroy())
  }
}

/** Resolve the default data directory: $DSH_HOME/lan-gateway, else ~/.dsh/lan-gateway. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.DSH_HOME ?? join(homedir(), '.dsh'), 'lan-gateway')
}
