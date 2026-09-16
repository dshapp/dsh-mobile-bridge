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
import { createMobileServer } from './http.ts'
import { serveStream } from './session.ts'
import { DeviceRegistry, encodeKey, loadIdentity } from './store.ts'
import { ProxyTunnel } from './tunnel.ts'

/** Stable Cordis plugin name. */
export const name = 'mobile-bridge'

/** Services this plugin cannot work without. */
export const inject = ['connection', 'credentials', 'typertGateway']

/** Where the public proxy is, and how long a pairing lasts. */
export interface Config {
  /** Public proxy host phones dial. */
  proxyHost?: string
  /** Public proxy port. Bare TCP, no TLS. */
  proxyPort?: number
  /** Optional base64 proxy static public key to pin. */
  proxyPublicKey?: string
  /** Days a paired device stays valid. */
  deviceTtlDays?: number
  /** Name phones show for this Mac; defaults to the computer's own name. */
  deviceName?: string
}

/**
 * Start the tunnel and serve paired devices for as long as dsh runs.
 * @param ctx - host plugin context.
 * @param config - proxy address and pairing lifetime.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const proxyHost = config.proxyHost ?? '127.0.0.1'
  const proxyPort = config.proxyPort ?? 8787
  const deviceTtlDays = config.deviceTtlDays ?? 180
  const deviceName = (config.deviceName ?? '').trim() || localDeviceName()

  const identity = await loadIdentity(ctx.credentials)
  const devices = await DeviceRegistry.load(ctx.credentials, deviceTtlDays)
  const { server, close } = createMobileServer(
    ctx.connection.createSharedFetchHandler('/api'),
    ctx.typertGateway.wireStream,
  )

  const tunnel = new ProxyTunnel({
    host: proxyHost,
    port: proxyPort,
    identity,
    ...config.proxyPublicKey === undefined ? {} : { proxyPublicKey: Buffer.from(config.proxyPublicKey, 'base64') },
    onStream: (stream) => {
      void serveStream(stream, { identity, devices, server }).catch((error: unknown) => {
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
  registerControlApi(ctx, { identity, devices, tunnel, proxyHost, proxyPort, deviceName })
  ctx.logger.info('mobile bridge key %s', encodeKey(identity.publicKey))
}
