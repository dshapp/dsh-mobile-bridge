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
}

/** Serve one stream opened by the proxy for a mobile client. */
export async function serveStream(stream: MuxStream, deps: SessionDeps): Promise<void> {
  const preamble = await stream.readExactly(HEAD_LEN)
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

  const first = await readFrame(stream)
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
  if (deviceKey === undefined || !await deps.devices.authorize(deviceKey, pairingToken)) {
    stream.close()
    return
  }

  await writeFrame(stream, handshake.write())
  deps.server.emit('connection', new NoiseSocket(stream, handshake.split()))
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
