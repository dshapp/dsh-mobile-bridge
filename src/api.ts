/**
 * The Mac app's control surface: three exact routes on the shared `/api`
 * channel, answering the same envelope every other harness endpoint does. The
 * app therefore needs no new transport — and the bridge needs no port, no
 * control socket and no state file of its own.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ProxyTunnel } from './tunnel.ts'
import { encodeKey, type DeviceRegistry } from './store.ts'
import type { KeyPair } from './noise.ts'

/** What the control routes need to answer. */
export interface ControlDeps {
  readonly identity: KeyPair
  readonly devices: DeviceRegistry
  readonly tunnel: ProxyTunnel
  readonly proxyHost: string
  readonly proxyPort: number
}

/** Register status / pair / revoke under `/api/mobileBridge`. */
export function registerControlApi(ctx: Context, deps: ControlDeps): void {
  route(ctx, 'status', () => status(deps))
  route(ctx, 'pair', () => {
    const { token, expiresAt } = deps.devices.createPairing()
    const key = encodeKey(deps.identity.publicKey)
    return {
      url: `dshm://${deps.proxyHost}:${String(deps.proxyPort)}/${key}#${token}`,
      expiresAt,
    }
  })
  route(ctx, 'revoke', async (args) => {
    const deviceId = typeof args.deviceId === 'string' ? args.deviceId : ''
    return { removed: await deps.devices.revoke(deviceId) }
  })
}

function status(deps: ControlDeps): Record<string, unknown> {
  return {
    bridgeKey: encodeKey(deps.identity.publicKey),
    proxyHost: deps.proxyHost,
    proxyPort: deps.proxyPort,
    connected: deps.tunnel.connected,
    devices: deps.devices.list(),
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
