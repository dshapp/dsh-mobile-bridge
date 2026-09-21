/**
 * Run the real bridge against a local proxy.
 *
 * Everything under test is shipped bridge code: ProxyTunnel dials the proxy
 * and runs Noise_XX, serveStream does the per-device Noise_IK and the pairing
 * check, createMobileServer is the node:http server the decrypted bytes are
 * fed into. Only two things are stubbed, because they belong to the harness
 * rather than to the bridge: the credential store (in memory here) and the
 * /api handler (an echo, so a round trip is checkable).
 */

import { createMobileServer } from '../src/http.ts'
import { serveStream } from '../src/session.ts'
import { DeviceRegistry, loadIdentity } from '../src/store.ts'
import { ProxyTunnel } from '../src/tunnel.ts'

const host = process.env.PROXY_HOST ?? '127.0.0.1'
const port = Number(process.env.PROXY_PORT ?? '27101')

/** In-memory stand-in for ctx.credentials. */
function credentials(): any {
  const store = new Map<string, unknown>()
  return {
    async readRecord(key: string) {
      return store.get(key)
    },
    async modifyRecord(key: string, mutate: (current: unknown) => Promise<unknown>) {
      const next = await mutate(store.get(key))
      if (next !== undefined) store.set(key, next)
      return store.get(key)
    },
  }
}

/** Stand-in for ctx.connection.createSharedFetchHandler('/api'). */
const api: any = {
  requestBodyMode: () => 'buffered',
  async fetch(request: Request) {
    const url = new URL(request.url)
    const text = await request.text()
    return new Response(
      JSON.stringify({ reachedHandler: request.url, pathname: url.pathname, host: url.host }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  },
}

const wireStream: any = { subscribe: () => () => {} }

const creds = credentials()
const identity = await loadIdentity(creds)
const devices = await DeviceRegistry.load(creds, 180)
const { server } = createMobileServer(api, wireStream, {})

const pairing = devices.createPairing()

const tunnel = new ProxyTunnel({
  host,
  port,
  identity,
  onStream: (stream: any) => {
    void serveStream(stream, { identity, devices, server, handshakeTimeoutMs: 10_000 })
      .catch((error: any) => {
        console.error('bridge: stream failed:', error?.message ?? error)
        stream.close()
      })
  },
  onError: (error: any) => { console.error('bridge: link error:', error?.message ?? error) },
})
tunnel.start()

// The client needs both of these, so hand them over on stdout.
setTimeout(() => {
  console.log(JSON.stringify({
    ready: true,
    connected: tunnel.connected,
    bridgeKey: identity.publicKey.toString('base64url'),
    pairingToken: pairing.token,
  }))
}, 1200)

process.on('SIGTERM', () => { tunnel.close(); process.exit(0) })
