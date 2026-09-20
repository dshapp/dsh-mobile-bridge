/**
 * The bridge's outbound link to the public proxy: one TCP connection carrying
 * a Noise_XX handshake and then the mux. Outbound means no inbound port, no
 * firewall hole, and no DNS name on this machine.
 */

import { connect, type Socket } from 'node:net'
import { Handshake, type KeyPair } from './noise.ts'
import { MuxLink, type MuxStream } from './mux.ts'
import { HEAD_LEN, MAGIC_BRIDGE, VERSION } from './wire.ts'

const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 10_000
const CONNECT_TIMEOUT_MS = 15_000

/** Everything the tunnel needs to reach and trust the proxy. */
export interface TunnelOptions {
  readonly host: string
  readonly port: number
  readonly identity: KeyPair
  /** Optional proxy static public key to pin, base64. */
  readonly proxyPublicKey?: Buffer
  readonly onStream: (stream: MuxStream) => void
  readonly onError: (error: Error) => void
}

/** A self-healing link to one proxy. */
export class ProxyTunnel {
  private socket: Socket | undefined
  private link: MuxLink | undefined
  private retry = RECONNECT_MIN_MS
  private timer: NodeJS.Timeout | undefined
  private stopped = false
  private paused = false
  private online = false
  /**
   * Bumped on every teardown. A mux link's close callback carries the value it
   * was created under, so a link dropped by suspend cannot resurface after a
   * resume has already installed a fresh one.
   */
  private generation = 0

  constructor(private readonly options: TunnelOptions) {}

  /** Whether the mux link is up right now. */
  get connected(): boolean {
    return this.online
  }

  /** Whether the operator cut mobile access: no link, and no reconnecting. */
  get isPaused(): boolean {
    return this.paused
  }

  /** Connect, and keep reconnecting until {@link close}. */
  start(): void {
    void this.dial()
  }

  /**
   * Cut the link and stay off until {@link resume}. Unlike {@link close} this
   * is reversible: it is the "cut mobile access" switch, so every stream a
   * phone holds dies with the link and none is re-established while paused.
   */
  suspend(): void {
    this.paused = true
    this.drop()
  }

  /** Reconnect after a {@link suspend}. A no-op once {@link close} ran. */
  resume(): void {
    if (this.stopped || !this.paused) return
    this.paused = false
    this.retry = RECONNECT_MIN_MS
    void this.dial()
  }

  /** Stop for good. */
  close(): void {
    this.stopped = true
    this.drop()
  }

  /** Tear down whatever is live, without deciding whether to reconnect. */
  private drop(): void {
    this.generation += 1
    clearTimeout(this.timer)
    this.timer = undefined
    this.link?.destroy()
    this.link = undefined
    this.socket?.destroy()
    this.socket = undefined
    this.online = false
  }

  private schedule(): void {
    if (this.stopped || this.paused) return
    const jitter = Math.floor(Math.random() * (this.retry / 2))
    const delay = this.retry + jitter
    this.retry = Math.min(this.retry * 2, RECONNECT_MAX_MS)
    this.timer = setTimeout(() => { void this.dial() }, delay)
    this.timer.unref()
  }

  private async dial(): Promise<void> {
    if (this.stopped || this.paused) return
    let socket: Socket
    try {
      socket = await open(this.options.host, this.options.port)
    } catch (error) {
      this.options.onError(error as Error)
      this.schedule()
      return
    }
    // A suspend (or close) during the dial owns the outcome: the socket must
    // not attach afterwards, or the cut would silently undo itself.
    if (this.stopped || this.paused) {
      socket.destroy()
      return
    }
    this.socket = socket
    try {
      const preamble = Buffer.alloc(HEAD_LEN)
      MAGIC_BRIDGE.copy(preamble, 0)
      preamble.writeUInt8(VERSION, 4)
      socket.write(preamble)

      const handshake = new Handshake({
        pattern: 'XX',
        initiator: true,
        staticKey: this.options.identity,
        prologue: preamble,
      })
      await writeFrame(socket, handshake.write())
      handshake.read(await readFrame(socket))
      await writeFrame(socket, handshake.write())

      const pinned = this.options.proxyPublicKey
      const remote = handshake.remoteStatic
      if (pinned !== undefined && (remote === undefined || !pinned.equals(remote))) {
        throw new Error('proxy static key does not match the pinned value')
      }
      const transport = handshake.split()
      this.retry = RECONNECT_MIN_MS
      this.online = true
      const generation = this.generation
      this.link = new MuxLink(socket, transport, this.options.onStream, () => {
        if (generation !== this.generation) return
        this.online = false
        this.link = undefined
        this.schedule()
      })
    } catch (error) {
      socket.destroy()
      this.online = false
      this.options.onError(error as Error)
      this.schedule()
    }
  }
}

function open(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    socket.setNoDelay(true)
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => { socket.destroy(new Error('proxy connect timed out')) })
    socket.once('connect', () => {
      socket.setTimeout(0)
      socket.off('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

/** Read one `[u16 len][data]` frame while the socket is still paused. */
export function readFrame(socket: Socket): Promise<Buffer> {
  return readBytes(socket, 2).then(head => readBytes(socket, head.readUInt16BE(0)))
}

/** Write one `[u16 len][data]` frame. */
export function writeFrame(socket: Socket, body: Buffer): Promise<void> {
  const out = Buffer.alloc(2 + body.length)
  out.writeUInt16BE(body.length, 0)
  body.copy(out, 2)
  return new Promise((resolve, reject) => {
    socket.write(out, error => { error ? reject(error) : resolve() })
  })
}

function readBytes(socket: Socket, need: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const chunk = need === 0 ? Buffer.alloc(0) : socket.read(need) as Buffer | null
      if (chunk === null) return
      cleanup()
      resolve(chunk)
    }
    const fail = (error?: Error): void => {
      cleanup()
      reject(error ?? new Error('proxy closed the connection'))
    }
    const cleanup = (): void => {
      socket.off('readable', attempt)
      socket.off('error', fail)
      socket.off('close', fail)
    }
    socket.on('readable', attempt)
    socket.once('error', fail)
    socket.once('close', fail)
    attempt()
  })
}
