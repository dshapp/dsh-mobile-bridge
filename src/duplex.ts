/**
 * The decrypted side of one device connection, shaped as a socket.
 *
 * Handing this to `node:http` is what makes HTTP/1.1 parsing, keep-alive and
 * WebSocket upgrades free: the harness never learns the traffic arrived over
 * Noise instead of TCP.
 */

import { Duplex } from 'node:stream'
import type { MuxStream } from './mux.ts'
import type { NoiseTransport } from './noise.ts'
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
    void (async () => {
      try {
        let rest = chunk
        while (rest.length > 0) {
          const take = Math.min(rest.length, MAX_NOISE_PLAINTEXT)
          const sealed = this.transport.encrypt(rest.subarray(0, take))
          const frame = Buffer.alloc(2 + sealed.length)
          frame.writeUInt16BE(sealed.length, 0)
          sealed.copy(frame, 2)
          await this.stream.write(frame)
          rest = rest.subarray(take)
        }
        done()
      } catch (error) {
        done(error as Error)
      }
    })()
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
