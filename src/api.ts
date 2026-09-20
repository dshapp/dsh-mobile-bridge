/**
 * The Mac app's control surface: exact routes on the shared `/api` channel,
 * answering the same envelope every other harness endpoint does. The app
 * therefore needs no new transport — and the bridge needs no port, no control
 * socket and no state file of its own.
 *
 * These are *control* routes, not phone routes: `pair` mints a pairing code,
 * `revoke` ejects a device, `rename` relabels one, and
 * `disconnect`/`connect` cut and restore the relay link itself. The mobile
 * server refuses `/api/mobileBridge/*` to phones
 * (see http.ts), so the only way in is the app's authenticated localhost web
 * channel. Phones are meant to reach the RPC channel, never this.
 */

import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { ProxyTunnel } from './tunnel.ts'
import { encodeKey, type DeviceRegistry, type Pairing } from './store.ts'
import type { KeyPair } from './noise.ts'

/** What the control routes need to answer. */
export interface ControlDeps {
  readonly identity: KeyPair
  readonly devices: DeviceRegistry
  readonly tunnel: ProxyTunnel
  readonly proxyHost: string
  readonly proxyPort: number
  /** This Mac's own name, the label a phone shows for the pairing. */
  readonly deviceName: string
}

/** Register status / pair / revoke / rename / disconnect / connect under `/api/mobileBridge`. */
export function registerControlApi(ctx: Context, deps: ControlDeps): void {
  route(ctx, 'status', () => status(deps))
  route(ctx, 'pair', () => ({
    ...pairingView(deps, deps.devices.createPairing()),
    deviceName: deps.deviceName,
  }))
  route(ctx, 'revoke', async (args) => {
    const deviceId = typeof args.deviceId === 'string' ? args.deviceId : ''
    return { removed: await deps.devices.revoke(deviceId) }
  })
  // A paired device's label is the operator's, not the bridge's: pairing seeds
  // a placeholder from the device key and this is how it becomes a real name.
  route(ctx, 'rename', async (args) => {
    const deviceId = typeof args.deviceId === 'string' ? args.deviceId : ''
    const label = typeof args.label === 'string' ? args.label : ''
    return { renamed: await deps.devices.rename(deviceId, label) }
  })
  // Cut and restore the relay link. Cutting hangs up every phone that is on it,
  // so it is the bridge's own act, not a client-side "hide the QR code".
  route(ctx, 'disconnect', () => {
    deps.tunnel.suspend()
    return { connected: deps.tunnel.connected }
  })
  route(ctx, 'connect', () => {
    deps.tunnel.resume()
    return { connected: deps.tunnel.connected }
  })
}

/**
 * Everything a pairing screen shows, in one read with no side effects.
 *
 * `pairing` is the live code or null — polling it is how a client learns that
 * the phone redeemed the code or that it went stale, without a local timer.
 */
function status(deps: ControlDeps): Record<string, unknown> {
  const pairing = deps.devices.activePairing()
  return {
    bridgeKey: encodeKey(deps.identity.publicKey),
    proxyHost: deps.proxyHost,
    proxyPort: deps.proxyPort,
    connected: deps.tunnel.connected,
    // Whether the operator cut mobile access. `connected` alone cannot say:
    // it is also false while the link is merely waiting to come up.
    disabled: deps.tunnel.isPaused,
    deviceName: deps.deviceName,
    now: Date.now(),
    pairing: pairing === null ? null : pairingView(deps, pairing),
    // `online` is the live connection count, not a guess from `lastSeenAt`.
    devices: deps.devices.list().map((device) => ({
      ...device,
      online: deps.devices.isOnline(device.deviceId),
    })),
  }
}

/**
 * The pairing as a client displays it: the exact text that goes into the QR.
 *
 * Drawing that text is the screen's job; the bridge owns what it says. The
 * proxy is a shared relay whose address names nothing, so this Mac's own name
 * rides along — the only moment a phone can learn it — and becomes the default
 * label of the pairing there.
 */
export function pairingView(deps: ControlDeps, pairing: Pairing): { url: string, expiresAt: number } {
  const key = encodeKey(deps.identity.publicKey)
  const name = deps.deviceName === '' ? '' : `?name=${encodeURIComponent(deps.deviceName)}`
  return {
    url: `dshm://${deps.proxyHost}:${String(deps.proxyPort)}/${key}${name}#${pairing.token}`,
    expiresAt: pairing.expiresAt,
  }
}

/**
 * This Mac's name as its owner knows it: the Sharing pane's computer name on
 * macOS, the network hostname anywhere else, with the mDNS suffix dropped.
 * @returns a human name, or the empty string when the machine has none.
 */
export function localDeviceName(): string {
  if (process.platform === 'darwin') {
    const name = runQuietly('/usr/sbin/scutil', ['--get', 'ComputerName'])
    if (name !== '') return name
  }
  return hostname().replace(/\.(local|lan)$/i, '').trim()
}

/** A best-effort command: a missing binary or a slow one yields no name. */
function runQuietly(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function route(
  ctx: Context,
  name: string,
  handle: (args: Record<string, unknown>) => unknown,
): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: `/api/mobileBridge/${name}`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readBody(request)
      const rpcId = typeof body.rpcId === 'string' ? body.rpcId : ''
      const payload = isRecord(body.payload) ? body.payload : {}
      const args = isRecord(payload.args) ? payload.args : {}
      try {
        const value = await handle(args)
        return json({ type: 'server-response', rpcId, result: { ok: true, value } })
      } catch (error) {
        return json({
          type: 'server-response',
          rpcId,
          result: { ok: false, error: { code: 'internal', message: String(error) } },
        })
      }
    },
  }), `mobile-bridge: /api/mobileBridge/${name}`)
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json()
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function json(body: unknown): Response {
  return Response.json(body)
}
