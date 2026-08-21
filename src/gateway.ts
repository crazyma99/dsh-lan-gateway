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

import { createHash, createHmac, randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { networkInterfaces } from 'node:os'
import { Duplex } from 'node:stream'
import { credentialsMatch, parseBasicAuth } from './auth.ts'
import { isAllowed } from './cidr.ts'
import { createSelfSignedCertificate } from './selfsigned.ts'
import { LOGIN_PATH, loginPageHtml, pickLanguage, safeRedirect } from './login-page.ts'

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

const SESSION_COOKIE = 'lan_gateway_session'
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const LOGIN_BODY_LIMIT = 4096
const RATE_WINDOW_MS = 10 * 60 * 1000
const RATE_MAX_FAILURES = 5

/** Percent-decode one form field (application/x-www-form-urlencoded). */
function decodeFormField(text: string): string {
  return decodeURIComponent(text.replace(/\+/g, ' '))
}

/** Parse a login form body into plain fields. */
function parseLoginBody(body: string): { username?: string; password?: string; redirect?: string } {
  const out: Record<string, string> = {}
  for (const pair of body.split('&')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    out[decodeFormField(pair.slice(0, eq))] = decodeFormField(pair.slice(eq + 1))
  }
  return out
}

/** Extract one cookie value from a Cookie header. */
function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    if (!trimmed.startsWith(`${name}=`)) continue
    return trimmed.slice(name.length + 1)
  }
  return undefined
}

/** Whether a request is a browser navigation (GET + accepts text/html). */
function isHtmlNavigation(req: http.IncomingMessage): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  return String(req.headers.accept ?? '').includes('text/html')
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
  private sessionSecret: Buffer | undefined
  private readonly loginFailures = new Map<string, { count: number; windowStart: number }>()
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

  /** Live connection count from the tracked socket set (synchronous). */
  private countConnections(): number {
    return this.sockets.size
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

  /** Load or create the session signing secret (persisted 0600). */
  private getSessionSecret(): Buffer {
    if (this.sessionSecret !== undefined) return this.sessionSecret
    const path = join(this.options.dataDir, 'session.key')
    if (existsSync(path)) {
      try {
        const stored = readFileSync(path)
        if (stored.length === 32) {
          this.sessionSecret = stored
          return stored
        }
      } catch {
        // fall through to regeneration
      }
    }
    const secret = randomBytes(32)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, secret, { mode: 0o600 })
    this.sessionSecret = secret
    return secret
  }

  /** Per-credential signing key: a password change invalidates every session. */
  private sessionKey(config: GatewayConfig): Buffer {
    return createHmac('sha256', this.getSessionSecret())
      .update(`${config.username}\n${config.password}`)
      .digest()
  }

  /** Issue a fresh session token. */
  private issueSession(config: GatewayConfig): string {
    const expires = Date.now() + SESSION_MAX_AGE_MS
    const payload = `${String(expires)}.${randomBytes(12).toString('base64url')}`
    const signature = createHmac('sha256', this.sessionKey(config)).update(payload).digest('base64url')
    return `${payload}.${signature}`
  }

  /** Verify a session cookie against the active credentials, constant-time. */
  private validSession(header: string | undefined, config: GatewayConfig): boolean {
    const token = cookieValue(header, SESSION_COOKIE)
    if (token === undefined) return false
    const lastDot = token.lastIndexOf('.')
    if (lastDot < 0) return false
    const payload = token.slice(0, lastDot)
    const signature = token.slice(lastDot + 1)
    const expected = createHmac('sha256', this.sessionKey(config)).update(payload).digest()
    const actual = Buffer.from(signature, 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false
    const dot = payload.indexOf('.')
    const expires = Number(payload.slice(0, dot))
    return Number.isFinite(expires) && expires > Date.now()
  }

  /** Basic credentials OR a valid session cookie admit the request. */
  private authorized(req: http.IncomingMessage, config: GatewayConfig): boolean {
    if (credentialsMatch(parseBasicAuth(req.headers.authorization), {
      username: config.username,
      password: config.password,
    })) return true
    return this.validSession(req.headers.cookie, config)
  }

  private denied(res: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
    res.writeHead(status, headers)
    res.end(body)
  }

  /** Reject or throttle one failed login attempt per peer address. */
  private loginThrottled(address: string | undefined): boolean {
    const key = address ?? 'unknown'
    const now = Date.now()
    const entry = this.loginFailures.get(key)
    if (entry === undefined || now - entry.windowStart > RATE_WINDOW_MS) return false
    return entry.count > RATE_MAX_FAILURES
  }

  private recordLoginFailure(address: string | undefined): void {
    const key = address ?? 'unknown'
    const now = Date.now()
    const entry = this.loginFailures.get(key)
    if (entry === undefined || now - entry.windowStart > RATE_WINDOW_MS) {
      this.loginFailures.set(key, { count: 1, windowStart: now })
      return
    }
    entry.count += 1
  }

  private recordLoginSuccess(address: string | undefined): void {
    if (address !== undefined) this.loginFailures.delete(address)
  }

  private serveLoginPage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    error: 'credentials' | 'throttled' | undefined,
    redirect: string,
  ): void {
    const html = loginPageHtml({
      lang: pickLanguage(req.headers['accept-language']),
      redirect: safeRedirect(redirect),
      ...(error === undefined ? {} : { error }),
    })
    this.denied(res, error === undefined ? 200 : 401, html, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    })
  }

  /** Handle the login form submission; success mints a session cookie. */
  private handleLoginPost(req: http.IncomingMessage, res: http.ServerResponse, config: GatewayConfig): void {
    const remote = (req.socket as net.Socket).remoteAddress
    if (this.loginThrottled(remote)) {
      this.serveLoginPage(req, res, 'throttled', '/')
      return
    }
    let body = ''
    req.on('data', (chunk: Buffer) => {
      if (body.length < LOGIN_BODY_LIMIT) body += chunk.toString('utf8')
    })
    req.on('end', () => {
      const fields = parseLoginBody(body.slice(0, LOGIN_BODY_LIMIT))
      const redirect = safeRedirect(fields.redirect)
      const match = credentialsMatch(
        fields.username === undefined ? undefined : { username: fields.username, password: fields.password ?? '' },
        { username: config.username, password: config.password },
      )
      if (!match) {
        this.recordLoginFailure(remote)
        this.serveLoginPage(req, res, 'credentials', redirect)
        return
      }
      this.recordLoginSuccess(remote)
      const token = this.issueSession(config)
      res.writeHead(303, {
        location: redirect,
        'set-cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`,
        'cache-control': 'no-store',
      })
      res.end()
    })
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse, config: GatewayConfig): void {
    const pathname = (req.url ?? '/').split('?')[0] ?? '/'
    if (!this.authorized(req, config)) {
      // The login flow itself is the only unauthenticated surface.
      if (pathname === LOGIN_PATH) {
        if (req.method === 'POST') {
          this.handleLoginPost(req, res, config)
          return
        }
        this.serveLoginPage(req, res, undefined, safeRedirect(new URL(req.url ?? '/', 'http://localhost').searchParams.get('redirect') ?? undefined))
        return
      }
      // Browser navigations land on the styled login page instead of the
      // native Basic-Auth prompt; everything else gets a plain 401 (no
      // WWW-Authenticate, so the browser never pops the dialog).
      if (isHtmlNavigation(req)) {
        this.denied(res, 303, '', {
          location: `${LOGIN_PATH}?redirect=${encodeURIComponent(req.url ?? '/')}`,
          'cache-control': 'no-store',
        })
        return
      }
      this.denied(res, 401, JSON.stringify({ error: 'unauthorized' }), {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      return
    }
    if (!isAllowed(req.socket.remoteAddress, config.allowlist)) {
      this.denied(res, 403, 'Forbidden\n')
      return
    }
    // Sliding session: every authenticated response refreshes the cookie.
    const refreshed = this.validSession(req.headers.cookie, config)
      ? this.issueSession(config)
      : undefined
    this.proxyRequest(req, res, refreshed)
  }

  private proxyRequest(req: http.IncomingMessage, res: http.ServerResponse, refreshCookie?: string): void {
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
      const headers: http.OutgoingHttpHeaders = { ...upstreamRes.headers }
      if (refreshCookie !== undefined) {
        headers['set-cookie'] = [`${SESSION_COOKIE}=${refreshCookie}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`]
      }
      res.writeHead(upstreamRes.statusCode ?? 502, headers)
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
