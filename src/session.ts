/**
 * One mobile connection: preamble check, Noise_IK responder handshake, then
 * plain HTTP. The handshake is the only authentication in the whole path —
 * a device that is neither whitelisted nor carrying a live pairing token is
 * dropped before a single byte of harness traffic is served.
 */

import type { Server } from 'node:http'
import { NoiseSocket } from './duplex.ts'
import type { MuxStream } from './mux.ts'
import { Handshake, type KeyPair } from './noise.ts'
import type { DeviceRegistry } from './store.ts'
import { HEAD_LEN, MAGIC_CLIENT, VERSION } from './wire.ts'

/** Collaborators one served stream needs. */
export interface SessionDeps {
  readonly identity: KeyPair
  readonly devices: DeviceRegistry
  readonly server: Server
  /**
   * Milliseconds the preamble and the Noise handshake may take, together.
   *
   * Without it an unauthenticated caller who knows the public bridge key can
   * send a valid preamble and then go silent, holding one of the proxy's
   * per-bridge stream slots forever — enough to lock the real phone out.
   */
  readonly handshakeTimeoutMs?: number
}

/** A new connection gets this long to prove it is a device. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000

/** Serve one stream opened by the proxy for a mobile client. */
export async function serveStream(stream: MuxStream, deps: SessionDeps): Promise<void> {
  const timeoutMs = deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
  // One deadline for the whole unauthenticated phase: the caller gets no
  // credit for starting a handshake, only for finishing one.
  const deadline = Date.now() + timeoutMs
  const preamble = await within(stream.readExactly(HEAD_LEN), deadline)
  if (
    preamble === undefined
    || !preamble.subarray(0, 4).equals(MAGIC_CLIENT)
    || preamble.readUInt8(4) !== VERSION
    || !preamble.subarray(5, HEAD_LEN).equals(deps.identity.publicKey)
  ) {
    stream.close()
    return
  }

  const handshake = new Handshake({
    pattern: 'IK',
    initiator: false,
    staticKey: deps.identity,
    prologue: preamble,
  })

  const first = await within(readFrame(stream), deadline)
  if (first === undefined) {
    stream.close()
    return
  }
  let pairingToken: Buffer
  try {
    pairingToken = handshake.read(first)
  } catch {
    stream.close()
    return
  }
  const deviceKey = handshake.remoteStatic
  const deviceId = deviceKey === undefined ? null : await deps.devices.authorize(deviceKey, pairingToken)
  if (deviceId === null) {
    stream.close()
    return
  }

  // Presence is the stream's lifetime: the phone is "here" exactly as long as
  // it holds a connection, and the release runs however the stream dies. The
  // registry keeps `dispose` so revoking the device hangs up on it at once.
  //
  // `split()` only yields keys once the handshake is complete, which the
  // responder's final `write()` below is what completes — so the disposer
  // closes the raw stream until the socket exists to close instead.
  let socket: NoiseSocket | undefined
  const release = deps.devices.attach(deviceId, () => {
    if (socket === undefined) stream.close()
    else socket.destroy()
  })
  stream.onEnd(release)

  await writeFrame(stream, handshake.write())
  socket = new NoiseSocket(stream, handshake.split())
  deps.server.emit('connection', socket)
}

/**
 * Race one unauthenticated read against a deadline.
 * @param read - the pending read.
 * @param deadline - epoch milliseconds it must finish by.
 * @returns the read's value, or `undefined` if the deadline passed first.
 */
function within<T>(read: Promise<T | undefined>, deadline: number): Promise<T | undefined> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve(undefined) }, remaining)
    timer.unref()
    void read.then(
      (value) => { clearTimeout(timer); resolve(value) },
      () => { clearTimeout(timer); resolve(undefined) },
    )
  })
}

async function readFrame(stream: MuxStream): Promise<Buffer | undefined> {
  const header = await stream.readExactly(2)
  if (header === undefined) return undefined
  return stream.readExactly(header.readUInt16BE(0))
}

async function writeFrame(stream: MuxStream, body: Buffer): Promise<void> {
  const frame = Buffer.alloc(2 + body.length)
  frame.writeUInt16BE(body.length, 0)
  body.copy(frame, 2)
  await stream.write(frame)
}
