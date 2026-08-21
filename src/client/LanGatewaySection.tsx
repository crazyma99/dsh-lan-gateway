/**
 * The LAN Access settings section: master switch, live gateway status, and
 * the configuration form. Data arrives through the injected LanGatewayStore
 * (loopback-only /lan-gateway RPC) — the dsh Web settings plane does not
 * expose external plugin namespaces, so this plugin owns its transport.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { Button, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GatewayStatus } from '../gateway.ts'
import type { LanGatewayPublicConfig } from '../settings.ts'
import { LanGatewayStore } from './store.ts'
import type { LanGatewayKey } from './locales.ts'

export interface LanGatewaySectionInjected {
  readonly store: LanGatewayStore
  readonly connection: ConnectionHandle
  readonly t: (key: LanGatewayKey) => string
}

export interface LanGatewaySectionProps {
  readonly store: LanGatewayStore
  readonly connection: ConnectionHandle
  readonly t: (key: LanGatewayKey) => string
}

const style = {
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0' } as const,
  label: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13 } as const,
  muted: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 } as const,
  input: {
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l2)',
    color: 'var(--dsw-alias-label-primary)',
    borderRadius: 8,
    padding: '6px 10px',
    fontSize: 13,
    minWidth: 0,
  } as const,
  textarea: {
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l2)',
    color: 'var(--dsw-alias-label-primary)',
    borderRadius: 8,
    padding: '6px 10px',
    fontSize: 13,
    minHeight: 60,
    resize: 'vertical' as const,
  },
  card: {
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 10,
    padding: 12,
    margin: '8px 0',
    background: 'var(--dsw-alias-bg-layer-1)',
  } as const,
  error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 } as const,
  success: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 13 } as const,
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 } as const,
  warning: { color: 'var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-error-primary))', fontSize: 12 } as const,
}

function dotState(status: GatewayStatus): StateDotState {
  switch (status.state) {
    case 'running': return 'done'
    case 'starting': return 'ongoing'
    case 'error': return 'error'
    default: return 'warning'
  }
}

/** Capsule toggle switch in the DSH token vocabulary (ui-primitives has no
 * Switch, so the plugin ships its own). */
function Switch(props: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (next: boolean) => void
}) {
  // Geometry: 42x24 capsule with a 1px border -> 40x22 content box; the knob
  // is 18x18 with symmetric 2px padding on every side. All UA button styles
  // (padding, font, appearance) are reset so the metrics stay exact.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      style={{
        position: 'relative',
        boxSizing: 'border-box',
        alignSelf: 'center',
        flexShrink: 0,
        width: 42,
        height: 24,
        padding: 0,
        margin: 0,
        borderRadius: 12,
        border: '1px solid var(--dsw-alias-border-l2)',
        // WCAG 1.4.11 non-text contrast (>=3:1) in BOTH themes:
        // - ON track: the primary-button fill (near-black in light, near-white
        //   in dark), paired with the primary-foreground knob (white / black).
        // - OFF track: label-secondary (dark gray in light, light gray in
        //   dark) — >=4.9:1 against both panel colors and the knob.
        background: props.checked
          ? 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary))'
          : 'var(--dsw-alias-label-secondary)',
        cursor: props.disabled === true ? 'default' : 'pointer',
        opacity: props.disabled === true ? 0.45 : 1,
        appearance: 'none',
        font: 'inherit',
        transition: 'background 120ms ease',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: props.checked ? 20 : 2,
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: 'var(--dsw-alias-label-primary-foreground)',
          transition: 'left 120ms ease',
        }}
      />
    </button>
  )
}

/** Vertical label-above-content row inside the status card: long values
 * (fingerprint, URL list) can never squeeze the label or break the layout. */
function StatusItem(props: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, marginBottom: 3 }}>{props.label}</div>
      <div>{props.children}</div>
    </div>
  )
}

export function LanGatewaySection({ store, connection, t }: LanGatewaySectionProps) {
  const useSnapshot = bindSnapshotSelector(store)
  const snapshot = useSnapshot(s => s)
  const config = snapshot.config
  const status = snapshot.status
  const enabled = config?.enabled ?? false

  const [portDraft, setPortDraft] = useState<string>('')
  const [allowlistDraft, setAllowlistDraft] = useState<string>('')
  const [passwordDraft, setPasswordDraft] = useState<string>('')
  const [saveState, setSaveState] = useState<{ kind: 'saved' } | { kind: 'failed'; message: string } | undefined>(undefined)

  useEffect(() => {
    if (config !== undefined && portDraft === '') setPortDraft(String(config.port))
    if (config !== undefined && allowlistDraft === '' && config.allowlist.length > 0) {
      setAllowlistDraft([...config.allowlist].join('\n'))
    }
  }, [config, portDraft, allowlistDraft])

  useEffect(() => {
    void store.load()
  }, [store])

  useEffect(() => {
    if (enabled) {
      void store.pollStatus()
      store.startPolling()
      return () => store.stopPolling()
    }
    store.stopPolling()
    return undefined
  }, [enabled, store])

  const flash = (state: { kind: 'saved' } | { kind: 'failed'; message: string }): void => {
    setSaveState(state)
    setTimeout(() => setSaveState(undefined), 2500)
  }

  /** Write one field; a refused write (host validation) reports failure honestly. */
  const commit = async (field: keyof LanGatewayPublicConfig | 'password', value: unknown): Promise<boolean> => {
    try {
      const next = await store.setField(field, value)
      if (next !== undefined) {
        flash({ kind: 'saved' })
        void store.pollStatus()
        return true
      }
    } catch {
      // fall through to the failure flash
    }
    flash({ kind: 'failed', message: t('form.saveFailed') })
    return false
  }

  const commitPort = async (): Promise<void> => {
    const parsed = Number(portDraft)
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) return
    await commit('port', parsed)
  }

  const commitAllowlist = async (): Promise<void> => {
    const entries = allowlistDraft
      .split('\n')
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0)
    await commit('allowlist', entries)
  }

  const commitPassword = async (): Promise<void> => {
    if (passwordDraft.length > 0) {
      await commit('password', passwordDraft)
      setPasswordDraft('')
    }
  }

  const toggleEnabled = async (next: boolean): Promise<void> => {
    await commit('enabled', next)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 620 }}>
      <h2 style={{ color: 'var(--dsw-alias-label-primary)', fontSize: 16, margin: 0 }}>{t('title')}</h2>
      <p style={style.muted}>{t('description')}</p>

      {!connection.isLoopback && <div style={style.warning}>{t('form.readonly')}</div>}

      <div style={style.row}>
        <div>
          <div style={style.label}>{t('master.enabled')}</div>
          {!enabled && <div style={style.muted}>{t('master.disabledHint')}</div>}
        </div>
        <Switch
          checked={enabled}
          disabled={!connection.isLoopback}
          label={t('master.enabled')}
          onChange={next => { void toggleEnabled(next) }}
        />
      </div>

      {enabled && status !== undefined && (
        <div style={style.card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={style.label}>{t('status.label')}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <StateDot state={dotState(status)} />
              <span style={style.label}>{t(`status.${status.state}` as LanGatewayKey)}</span>
            </span>
          </div>
          {status.state === 'error' && (
            <StatusItem label={t('status.label')}>
              <div style={style.error}>{t('status.errorHint')}</div>
              {status.error !== undefined && <div style={{ ...style.mono, marginTop: 4 }}>{status.error}</div>}
            </StatusItem>
          )}
          {status.state === 'running' && (
            <>
              <StatusItem label={t('status.url')}>
                {status.urls.length === 0
                  ? <span style={style.muted}>—</span>
                  : status.urls.map(url => (
                    <a key={url} href={url} target="_blank" rel="noreferrer" style={{ ...style.mono, display: 'block' }}>{url}</a>
                  ))}
              </StatusItem>
              <StatusItem label={t('status.fingerprint')}>
                <code style={{ ...style.mono, display: 'block', wordBreak: 'break-all', lineHeight: 1.6 }}>
                  {status.fingerprint ?? '—'}
                </code>
              </StatusItem>
              <StatusItem label={t('status.connections')}>
                <span style={style.label}>{String(status.activeConnections)}</span>
              </StatusItem>
            </>
          )}
        </div>
      )}

      <fieldset disabled={!connection.isLoopback} style={{ border: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={style.row}>
          <div>
            <div style={style.label}>{t('form.port')}</div>
            <div style={style.muted}>{t('form.portHint')}</div>
          </div>
          <input
            type="number"
            value={portDraft}
            min={0}
            max={65535}
            disabled={!connection.isLoopback}
            onChange={event => setPortDraft(event.target.value)}
            onBlur={() => { void commitPort() }}
            style={{ ...style.input, width: 104, textAlign: 'right' }}
          />
        </div>

        <div style={style.row}>
          <div>
            <div style={style.label}>{t('form.tls')}</div>
            <div style={style.muted}>{t('form.tls.hint')}</div>
          </div>
          <select
            value={config?.tlsMode ?? 'self-signed'}
            disabled={!connection.isLoopback}
            onChange={event => { void commit('tlsMode', event.target.value) }}
            style={style.input}
          >
            <option value="self-signed">{t('form.tls.selfSigned')}</option>
            <option value="provided">{t('form.tls.provided')}</option>
          </select>
        </div>

        {config?.tlsMode === 'provided' && (
          <>
            <div style={style.row}>
              <span style={style.label}>{t('form.tls.certPath')}</span>
              <input
                type="text"
                defaultValue={config.certPath}
                disabled={!connection.isLoopback}
                onBlur={event => {
                  if (event.target.value !== config.certPath) void commit('certPath', event.target.value)
                }}
                style={{ ...style.input, width: 220 }}
              />
            </div>
            <div style={style.row}>
              <span style={style.label}>{t('form.tls.keyPath')}</span>
              <input
                type="text"
                defaultValue={config.keyPath}
                disabled={!connection.isLoopback}
                onBlur={event => {
                  if (event.target.value !== config.keyPath) void commit('keyPath', event.target.value)
                }}
                style={{ ...style.input, width: 220 }}
              />
            </div>
          </>
        )}

        <div style={style.row}>
          <span style={style.label}>{t('form.username')}</span>
          <input
            type="text"
            defaultValue={config?.username ?? 'dsh'}
            disabled={!connection.isLoopback}
            onBlur={event => {
              const value = event.target.value.trim()
              if (value.length > 0 && value !== config?.username) void commit('username', value)
            }}
            style={{ ...style.input, width: 220 }}
          />
        </div>

        <div style={style.row}>
          <div>
            <div style={style.label}>{t('form.password')}</div>
            <div style={style.muted}>{t('form.password.hint')}</div>
          </div>
          <input
            type="password"
            value={passwordDraft}
            placeholder={config?.hasPassword === true ? t('form.password.placeholder') : ''}
            disabled={!connection.isLoopback}
            onChange={event => setPasswordDraft(event.target.value)}
            onBlur={() => { void commitPassword() }}
            style={{ ...style.input, width: 220 }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div>
            <div style={style.label}>{t('form.allowlist')}</div>
            <div style={style.muted}>{t('form.allowlist.hint')}</div>
          </div>
          <textarea
            value={allowlistDraft}
            placeholder="192.168.1.0/24"
            disabled={!connection.isLoopback}
            onChange={event => setAllowlistDraft(event.target.value)}
            onBlur={() => { void commitAllowlist() }}
            style={style.textarea}
          />
          {config !== undefined && config.allowlist.length === 0 && (
            <div style={style.warning}>{t('form.warning.allowlistEmpty')}</div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 6 }}>
          <Button variant="primary" size="sm" disabled={!connection.isLoopback} onClick={() => {
            void commitPort()
            void commitAllowlist()
          }}>
            {t('form.save')}
          </Button>
          {saveState !== undefined && (
            saveState.kind === 'saved'
              ? <span style={style.success}>{t('form.saved')}</span>
              : <span style={style.error}>{saveState.message}</span>
          )}
        </div>
      </fieldset>
    </div>
  )
}
