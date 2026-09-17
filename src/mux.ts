/**
 * Bridge half of the minimal mux carried by the proxy link. The proxy is the
 * only side that opens streams — one per mobile connection — so this half only
 * accepts them, moves bytes, and returns receive credit.
 */

import type { Duplex } from 'node:stream'
import { NOISE_TAG_LEN, type NoiseTransport } from './noise.ts'
import {
  FRAME_HEAD,
  KEEPALIVE_MS,
  KIND_CLOSE,
  KIND_DATA,
  KIND_OPEN,
  KIND_WINDOW,
  LINK_IDLE_MS,
  MAX_PAYLOAD,
  WINDOW,
} from './wire.ts'

const EMPTY = Buffer.alloc(0)

/**
 * Receive credit is returned in batches.
 *
 * Every WINDOW_UPDATE is a whole ChaCha message, so acknowledging each inbound
 * frame costs a cipher setup per frame and made pure credit accounting 28% of
 * everything the bridge sent. Batching lets the peer's credit dip at most this
 * far below the advertised 256 KiB window — far more than the 16 KiB one frame
 * needs, so it can never stall waiting for credit.
 */
const WINDOW_BATCH = WINDOW / 4

/** One logical connection from a phone, riding the bridge link. */
export class MuxStream {
  private buffered: Buffer[] = []
  private size = 0
  private ended = false
  private waiting: { need: number, resolve: (value: Buffer | undefined) => void } | undefined
  /** Bytes we may still send before the proxy returns credit. */
  private credit = WINDOW
  private drains: (() => void)[] = []
  private enders: (() => void)[] = []
  /** Inbound bytes received but not yet acknowledged with a WINDOW_UPDATE. */
  private unacked = 0

  constructor(readonly id: number, private readonly link: MuxLink) {}

  /** Read exactly `need` bytes, or undefined once the stream ends. */
  readExactly(need: number): Promise<Buffer | undefined> {
    const ready = this.take(need)
    if (ready !== undefined) return Promise.resolve(ready)
    if (this.ended) return Promise.resolve(undefined)
    return new Promise((resolve) => { this.waiting = { need, resolve } })
  }

  /** Send bytes to the phone, waiting while the proxy's window is full. */
  async write(data: Buffer): Promise<void> {
    let rest = data
    while (rest.length > 0) {
      const take = Math.min(rest.length, MAX_PAYLOAD)
      while (this.credit < take) {
        if (this.ended) return
        await new Promise<void>((resolve) => { this.drains.push(resolve) })
      }
      this.credit -= take
      this.link.send(this.id, KIND_DATA, rest.subarray(0, take))
      rest = rest.subarray(take)
    }
  }

  /**
   * Run `listener` once this stream ends, however it ends.
   * @param listener - called on local close, remote CLOSE, or a dropped link.
   */
  onEnd(listener: () => void): void {
    if (this.ended) listener()
    else this.enders.push(listener)
  }

  /** Close this stream on both ends. */
  close(): void {
    if (!this.ended) this.link.send(this.id, KIND_CLOSE)
    this.finish()
  }

  /** @internal Deliver one inbound chunk and return its receive credit. */
  push(chunk: Buffer): void {
    this.buffered.push(chunk)
    this.size += chunk.length
    this.settle()
    this.unacked += chunk.length
    if (this.unacked < WINDOW_BATCH) return
    const owed = this.unacked
    this.unacked = 0
    this.link.send(this.id, KIND_WINDOW, windowPayload(owed))
  }

  /** @internal Grant more send credit. */
  grant(bytes: number): void {
    this.credit += bytes
    const drains = this.drains
    this.drains = []
    for (const resolve of drains) resolve()
  }

  /** @internal End the stream without sending anything. */
  finish(): void {
    if (this.ended) return
    this.ended = true
    this.settle()
    const drains = this.drains
    this.drains = []
    for (const resolve of drains) resolve()
    const enders = this.enders
    this.enders = []
    for (const listener of enders) listener()
  }

  private settle(): void {
    const pending = this.waiting
    if (pending === undefined) return
    const ready = this.take(pending.need)
    if (ready !== undefined) {
      this.waiting = undefined
      pending.resolve(ready)
      return
    }
    if (this.ended) {
      this.waiting = undefined
      pending.resolve(undefined)
    }
  }

  /**
   * Take exactly `need` bytes, joining only the chunks that carry them.
   *
   * The caller peeks a 2-byte length prefix before every frame, and joining
   * the whole buffer to do that (up to the full 256 KiB window) copied about
   * 1.6 bytes for every byte that actually arrived.
   */
  private take(need: number): Buffer | undefined {
    if (this.size < need) return undefined
    if (need === 0) return EMPTY
    const first = this.buffered[0] as Buffer
    if (first.length >= need) {
      this.buffered[0] = first.subarray(need)
      if (this.buffered[0].length === 0) this.buffered.shift()
      this.size -= need
      return first.subarray(0, need)
    }
    const joined = Buffer.allocUnsafe(need)
    let offset = 0
    while (offset < need) {
      const chunk = this.buffered[0] as Buffer
      const used = Math.min(chunk.length, need - offset)
      chunk.copy(joined, offset, 0, used)
      offset += used
      if (used === chunk.length) this.buffered.shift()
      else this.buffered[0] = chunk.subarray(used)
    }
    this.size -= need
    return joined
  }
}

function windowPayload(bytes: number): Buffer {
  const payload = Buffer.alloc(4)
  payload.writeUInt32BE(bytes)
  return payload
}

/** One encrypted link to the proxy, demultiplexed into streams. */
export class MuxLink {
  private readonly streams = new Map<number, MuxStream>()
  private pending: Buffer = Buffer.alloc(0)
  /** Reused plaintext frame; send() is synchronous, so one buffer suffices. */
  private readonly scratch = Buffer.allocUnsafe(FRAME_HEAD + MAX_PAYLOAD)
  private keepalive: NodeJS.Timeout | undefined
  private idle: NodeJS.Timeout | undefined
  private closed = false

  constructor(
    private readonly socket: Duplex,
    private readonly transport: NoiseTransport,
    private readonly onStream: (stream: MuxStream) => void,
    private readonly onClose: () => void,
  ) {
    socket.on('data', chunk => { this.receive(chunk) })
    socket.on('error', () => { this.destroy() })
    socket.on('close', () => { this.destroy() })
    this.keepalive = setInterval(() => { this.send(0, KIND_DATA) }, KEEPALIVE_MS)
    this.keepalive.unref()
    this.touch()
  }

  /** Encrypt and write one mux frame. */
  send(id: number, kind: number, payload: Buffer = EMPTY): void {
    if (this.closed) return
    const plainLength = FRAME_HEAD + payload.length
    const frame = plainLength <= this.scratch.length ? this.scratch : Buffer.allocUnsafe(plainLength)
    frame.writeUInt32BE(id, 0)
    frame.writeUInt8(kind, 4)
    frame.writeUInt16BE(payload.length, 5)
    frame.writeUInt8(0, 7)
    if (payload.length > 0) payload.copy(frame, FRAME_HEAD)
    // Seal straight into the length-prefixed output: one allocation per frame
    // where encrypt() needed four, and no intermediate copies.
    const out = Buffer.allocUnsafe(2 + plainLength + NOISE_TAG_LEN)
    const sealed = this.transport.sealInto(frame.subarray(0, plainLength), out, 2)
    out.writeUInt16BE(sealed, 0)
    this.socket.write(out.subarray(0, 2 + sealed))
  }

  /** Tear the link down; the tunnel reconnects. */
  destroy(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.keepalive)
    clearTimeout(this.idle)
    for (const stream of this.streams.values()) stream.finish()
    this.streams.clear()
    this.socket.destroy()
    this.onClose()
  }

  private touch(): void {
    clearTimeout(this.idle)
    this.idle = setTimeout(() => { this.destroy() }, LINK_IDLE_MS)
    this.idle.unref()
  }

  private receive(chunk: Buffer): void {
    this.touch()
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    while (this.pending.length >= 2) {
      const length = this.pending.readUInt16BE(0)
      if (this.pending.length < 2 + length) return
      const sealed = this.pending.subarray(2, 2 + length)
      this.pending = this.pending.subarray(2 + length)
      let frame: Buffer
      try {
        frame = this.transport.decrypt(sealed)
      } catch {
        this.destroy()
        return
      }
      if (frame.length < FRAME_HEAD) {
        this.destroy()
        return
      }
      this.dispatch(frame)
    }
  }

  private dispatch(frame: Buffer): void {
    const id = frame.readUInt32BE(0)
    const kind = frame.readUInt8(4)
    const payload = frame.subarray(FRAME_HEAD)
    // streamId 0 carries only keepalives; receiving one already refreshed idle.
    if (id === 0) return
    switch (kind) {
      case KIND_OPEN: {
        const stream = new MuxStream(id, this)
        this.streams.set(id, stream)
        this.onStream(stream)
        return
      }
      case KIND_DATA: {
        this.streams.get(id)?.push(payload)
        return
      }
      case KIND_WINDOW: {
        if (payload.length === 4) this.streams.get(id)?.grant(payload.readUInt32BE(0))
        return
      }
      case KIND_CLOSE: {
        this.streams.get(id)?.finish()
        this.streams.delete(id)
        return
      }
      default:
    }
  }
}
