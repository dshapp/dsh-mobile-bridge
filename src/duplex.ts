/**
 * The decrypted side of one device connection, shaped as a socket.
 *
 * Handing this to `node:http` is what makes HTTP/1.1 parsing, keep-alive and
 * WebSocket upgrades free: the harness never learns the traffic arrived over
 * Noise instead of TCP.
 */

import { Duplex } from 'node:stream'
import type { MuxStream } from './mux.ts'
import { NOISE_TAG_LEN, type NoiseTransport } from './noise.ts'
import { MAX_NOISE_PLAINTEXT } from './wire.ts'

/** A Noise transport presented as a socket-like Duplex. */
export class NoiseSocket extends Duplex {
  constructor(private readonly stream: MuxStream, private readonly transport: NoiseTransport) {
    super()
    void this.pump()
  }

  /** node:http and ws poke these on every socket they adopt. */
  setTimeout(): this {
    return this
  }

  setNoDelay(): this {
    return this
  }

  setKeepAlive(): this {
    return this
  }

  get remoteAddress(): string {
    return 'mobile'
  }

  override _read(): void {
    // Delivery is driven by pump(); backpressure lives in the mux window.
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    void this.seal(chunk).then(() => { done() }, (error: unknown) => { done(error as Error) })
  }

  /**
   * Seal a corked batch as one Noise message.
   *
   * node:http correlates a response head with its first body chunk, and
   * without this each half became its own message — two cipher setups and two
   * mux frames where one would do.
   */
  override _writev(chunks: { chunk: Buffer, encoding: BufferEncoding }[], done: (error?: Error | null) => void): void {
    const joined = chunks.length === 1
      ? chunks[0]?.chunk ?? Buffer.alloc(0)
      : Buffer.concat(chunks.map(({ chunk }) => chunk))
    void this.seal(joined).then(() => { done() }, (error: unknown) => { done(error as Error) })
  }

  private async seal(data: Buffer): Promise<void> {
    let rest = data
    while (rest.length > 0) {
      const take = Math.min(rest.length, MAX_NOISE_PLAINTEXT)
      // Reserve the length prefix, then seal straight in behind it.
      const frame = Buffer.allocUnsafe(2 + take + NOISE_TAG_LEN)
      const sealed = this.transport.sealInto(rest.subarray(0, take), frame, 2)
      frame.writeUInt16BE(sealed, 0)
      await this.stream.write(frame.subarray(0, 2 + sealed))
      rest = rest.subarray(take)
    }
  }

  override _final(done: (error?: Error | null) => void): void {
    this.stream.close()
    done()
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.stream.close()
    done(error)
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const header = await this.stream.readExactly(2)
        if (header === undefined) break
        const body = await this.stream.readExactly(header.readUInt16BE(0))
        if (body === undefined) break
        const plaintext = this.transport.decrypt(body)
        if (plaintext.length > 0) this.push(plaintext)
      }
    } catch {
      // A forged or truncated frame ends this connection and nothing else.
    }
    this.push(null)
    this.stream.close()
  }
}
