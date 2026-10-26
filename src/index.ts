/**
 * dsh mobile access — the Mac half.
 *
 * Phones reach this harness through a public `dsh-proxy` that only reads a
 * 37-byte routing preamble. Everything that matters happens here: one Noise_IK
 * handshake per connection both encrypts the channel and proves which device is
 * calling, and the decrypted bytes are handed straight to node:http. No port is
 * opened, no certificate exists, no cookie is forged, and no extra process runs.
 *
 * @module dsh-mobile-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-api-gateway/types'
import { localDeviceName, registerControlApi } from './api.ts'
import { registerControlPage } from './web.ts'
import { createMobileServer } from './http.ts'
import { DevicePeers } from './peers.ts'
import { serveStream } from './session.ts'
import { DeviceRegistry, loadIdentity } from './store.ts'
import { ProxyTunnel } from './tunnel.ts'

/** Stable Cordis plugin name. */
export const name = 'mobile-bridge'

/** Services this plugin cannot work without. */
export const inject = ['connection', 'credentials', 'typertGateway']

/** Public dsh-proxy the bridge dials when no `proxyHost` is configured. */
export const DEFAULT_PROXY_HOST = 'dshproxy.wuhaolin.cn'

/** Port of the default proxy. */
export const DEFAULT_PROXY_PORT = 8787

/**
 * Static public key of the default proxy, base64. It is pinned only while the
 * host is left at its default: a self-hosted proxy has its own key.
 */
export const DEFAULT_PROXY_PUBLIC_KEY = 'pAzEKmp+wwUyMLhAaff+0UHSRb69n8RwvzYDeCkEd0A='

/** Where the public proxy is, and how long a pairing lasts. */
export interface Config {
  /** Public proxy host phones dial. */
  proxyHost?: string
  /** Public proxy port. Bare TCP, no TLS. */
  proxyPort?: number
  /**
   * Optional base64 proxy static public key to pin. Defaults to the default
   * proxy's key when `proxyHost` is unset; an empty string disables pinning.
   */
  proxyPublicKey?: string
  /** Days a paired device stays valid. */
  deviceTtlDays?: number
  /** Name phones show for this Mac; defaults to the computer's own name. */
  deviceName?: string
  /**
   * Extra exact `/api` paths phones may reach, on top of the built-in
   * allowlist. The RPC channel itself is always open; this only widens the
   * plugin-registered routes, which are otherwise default-deny.
   */
  apiAllowlist?: string[]
  /**
   * Milliseconds a new mobile connection may spend on the preamble and the
   * Noise handshake before it is dropped. A stream that is opened but never
   * authenticates would otherwise hold one of the proxy's per-bridge slots
   * forever, which is enough to lock a real phone out.
   */
  handshakeTimeoutMs?: number
}

/**
 * Start the tunnel and serve paired devices for as long as dsh runs.
 * @param ctx - host plugin context.
 * @param config - proxy address and pairing lifetime.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const proxyHost = config.proxyHost ?? DEFAULT_PROXY_HOST
  const proxyPort = config.proxyPort ?? DEFAULT_PROXY_PORT
  const proxyPublicKey = config.proxyPublicKey
    ?? (config.proxyHost === undefined ? DEFAULT_PROXY_PUBLIC_KEY : '')
  const deviceTtlDays = config.deviceTtlDays ?? 180
  const deviceName = (config.deviceName ?? '').trim() || localDeviceName()
  const handshakeTimeoutMs = config.handshakeTimeoutMs ?? 10_000

  const identity = await loadIdentity(ctx.credentials)
  const devices = await DeviceRegistry.load(ctx.credentials, deviceTtlDays)
  // A paired phone is its owner's other screen: it speaks as the owner, like
  // the browser does, and answers forwarded prompts (permission requests).
  // Peers are owned by this plugin's context, so unloading it disposes them.
  const peers = new DevicePeers(() => ctx.connection.createPeer({
    principal: { kind: 'owner' },
    interactions: 'answer',
  }))
  const { server, close } = createMobileServer(
    ctx.connection.createSharedFetchHandler('/api'),
    ctx.typertGateway.wireStream,
    config.apiAllowlist === undefined ? {} : { apiAllowlist: config.apiAllowlist },
  )

  const tunnel = new ProxyTunnel({
    host: proxyHost,
    port: proxyPort,
    identity,
    ...proxyPublicKey === '' ? {} : { proxyPublicKey: Buffer.from(proxyPublicKey, 'base64') },
    onStream: (stream) => {
      void serveStream(stream, { identity, devices, peers, server, handshakeTimeoutMs }).catch((error: unknown) => {
        // A device that fails here gets nothing back; the operator still needs
        // to see why, so this is a warning rather than a silent drop.
        ctx.logger.warn(error)
        stream.close()
      })
    },
    onError: (error) => { ctx.logger.debug(error) },
  })
  ctx.effect(() => {
    tunnel.start()
    return async () => {
      tunnel.close()
      await close()
    }
  }, 'mobile-bridge: proxy tunnel')
  const control = { identity, devices, tunnel, proxyHost, proxyPort, deviceName }
  registerControlApi(ctx, control)
  // The same screen in a browser, when this composition serves one.
  registerControlPage(ctx, control)
  // The routing key is an identifier, not a secret — but a log is not the
  // place for it, and the Mac app already gets it from `mobileBridge/status`.
  ctx.logger.info('mobile bridge ready via %s:%d', proxyHost, proxyPort)
}
