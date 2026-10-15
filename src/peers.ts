/**
 * Who a phone's calls speak for.
 *
 * Since dsh 0.2 every call into the shared `/api` handler and every Remote
 * stream names the Peer it is made as — the handler reads `peer.signal` before
 * it does anything, and the Remote-stream carrier closes with its Peer. The web
 * carrier gets one from the browser cookie; a phone has no cookie, so the Peer
 * comes from here, after the Noise handshake has proved which device is calling.
 *
 * One Peer per *device*, not per connection. A phone opens separate tunnel
 * connections for its RPC calls and for its event stream, and the harness
 * only accepts the answer to a forwarded event (`$events/result`) from the
 * same Peer that holds the event stream. A Peer per connection would make
 * every permission prompt on the phone unanswerable.
 *
 * The Peer lives exactly as long as the device has a connection open: the
 * first connection creates it, the last one to go disposes it, which also ends
 * every Remote stream it held. Revoking a device hangs up its connections, so
 * revocation disposes the Peer by the same path.
 */

import type { ConnectionFetchHandler } from '@deepseek-ai/dsh-client-connection'

/** The Peer a request is dispatched as, as the shared handler names it. */
export type MobilePeer = Parameters<ConnectionFetchHandler['fetch']>[1]

/** One connection's hold on its device's Peer. */
export interface PeerLease {
  readonly peer: MobilePeer
  /** Give the hold back; safe to call more than once. */
  readonly release: () => void
}

interface Entry {
  readonly peer: MobilePeer
  holders: number
}

/** Device id → its shared Peer, reference-counted by live connections. */
export class DevicePeers {
  readonly #create: () => MobilePeer
  readonly #entries = new Map<string, Entry>()

  /**
   * @param create - mints a fresh Peer; called once per device presence.
   */
  constructor(create: () => MobilePeer) {
    this.#create = create
  }

  /**
   * Take a hold on this device's Peer, creating it for the first connection.
   * @param deviceId - the authenticated device.
   * @returns the Peer and the release this connection must call when it ends.
   */
  acquire(deviceId: string): PeerLease {
    let entry = this.#entries.get(deviceId)
    if (entry === undefined || entry.peer.signal.aborted) {
      entry = { peer: this.#create(), holders: 0 }
      this.#entries.set(deviceId, entry)
    }
    entry.holders += 1
    const held = entry
    let released = false
    return {
      peer: held.peer,
      release: () => {
        if (released) return
        released = true
        held.holders -= 1
        if (held.holders > 0) return
        // A newer Peer may already have replaced this one (the old one was
        // disposed underneath us); only remove the entry that is ours.
        if (this.#entries.get(deviceId) === held) this.#entries.delete(deviceId)
        void held.peer.dispose().catch(() => undefined)
      },
    }
  }

  /** Devices that currently hold a Peer; for tests and diagnostics. */
  get size(): number {
    return this.#entries.size
  }
}

/**
 * Socket → Peer, for the node:http server that never sees the handshake.
 *
 * The decrypted socket is the one object both sides share: the session binds
 * it before handing it to node:http, and every request and upgrade on it
 * carries it as `req.socket`. A WeakMap keeps the binding exactly as long as
 * the socket itself.
 */
const socketPeers = new WeakMap<object, MobilePeer>()

/** Record which Peer a connection's traffic speaks for. */
export function bindSocketPeer(socket: object, peer: MobilePeer): void {
  socketPeers.set(socket, peer)
}

/** The Peer bound to a connection, or undefined for one that never authenticated. */
export function socketPeer(socket: object): MobilePeer | undefined {
  return socketPeers.get(socket)
}
