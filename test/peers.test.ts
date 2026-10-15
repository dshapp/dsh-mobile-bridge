/**
 * Every phone call is made as its device's Peer.
 *
 * dsh 0.2 requires a Peer on every `/api` call and every Remote stream: the
 * handler reads `peer.signal` first, so a carrier that passes none gets
 * `gateway/internal: Cannot read properties of undefined (reading 'signal')`
 * back for *everything* — which is what a phone saw as "can't reach your
 * Desktop" right after pairing. These tests hold the bridge to passing one,
 * and to sharing it across a device's connections (the harness only accepts
 * an event answer from the Peer that holds the event stream).
 */

import assert from 'node:assert/strict'
import { Duplex } from 'node:stream'
import { WebSocket } from 'ws'
import { createMobileServer, UplinkInbox } from '../src/http.ts'
import { bindSocketPeer, DevicePeers, socketPeer } from '../src/peers.ts'

const results: string[] = []
let failures = 0

async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run()
    results.push('PASS  ' + name)
  } catch (error) {
    failures += 1
    results.push('FAIL  ' + name + '\n      ' + String(error))
  }
}

/** A stand-in Peer: what the harness's createPeer returns, minus the scope. */
function fakePeer(id: string): any {
  const lifetime = new AbortController()
  return {
    id,
    principal: { kind: 'owner' },
    interactions: 'answer',
    signal: lifetime.signal,
    disposed: 0,
    async dispose() {
      this.disposed += 1
      lifetime.abort(new Error('disposed'))
    },
  }
}

/** One in-memory socket end, shaped like the NoiseSocket node:http adopts. */
class Wire extends Duplex {
  other: Wire | undefined
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.other?.push(chunk)
    done()
  }
  override _final(done: () => void): void {
    this.other?.push(null)
    done()
  }
  setTimeout(): this { return this }
  setNoDelay(): this { return this }
  setKeepAlive(): this { return this }
  get remoteAddress(): string { return 'mobile' }
}

function wirePair(): [Wire, Wire] {
  const a = new Wire()
  const b = new Wire()
  a.other = b
  b.other = a
  return [a, b]
}

/** Send one HTTP/1.1 request down a wire and collect the raw response. */
async function roundTrip(client: Wire, raw: string): Promise<string> {
  let received = ''
  const done = new Promise<string>((resolve) => {
    client.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8')
      const head = received.indexOf('\r\n\r\n')
      if (head < 0) return
      const length = /content-length: (\d+)/i.exec(received.slice(0, head))
      const want = length === null ? 0 : Number(length[1])
      if (received.length - head - 4 >= want) resolve(received)
    })
  })
  client.write(raw)
  return done
}

function post(path: string, body: string): string {
  return 'POST ' + path + ' HTTP/1.1\r\nhost: mobile.dsh\r\ncontent-type: application/json\r\n'
    + 'content-length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body
}

/** A shared /api handler that records the Peer each request was made as. */
function recordingApi(): { api: any, peers: unknown[] } {
  const peers: unknown[] = []
  const api = {
    requestBodyMode: () => 'buffered' as const,
    async fetch(_request: Request, peer: unknown) {
      peers.push(peer)
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }
  return { api, peers }
}

const wireStreamUnused: any = { open: async () => { throw new Error('unused') }, failure: () => ({}) }

await test('one device shares one Peer across its connections', () => {
  let created = 0
  const peers = new DevicePeers(() => fakePeer('p' + String(++created)))
  const rpc = peers.acquire('phone')
  const events = peers.acquire('phone')
  assert.equal(rpc.peer, events.peer, 'RPC and event connections must speak as the same Peer')
  assert.equal(created, 1)
  const other = peers.acquire('tablet')
  assert.notEqual(other.peer, rpc.peer, 'different devices never share a Peer')
})

await test('the Peer is disposed when the device\'s last connection ends', async () => {
  const peers = new DevicePeers(() => fakePeer('p'))
  const a = peers.acquire('phone')
  const b = peers.acquire('phone')
  a.release()
  assert.equal((a.peer as any).disposed, 0, 'one connection left: the Peer stays')
  b.release()
  b.release()
  await Promise.resolve()
  assert.equal((a.peer as any).disposed, 1, 'disposed exactly once, however often release runs')
  assert.equal(peers.size, 0)
})

await test('a device that comes back gets a fresh, live Peer', () => {
  let created = 0
  const peers = new DevicePeers(() => fakePeer('p' + String(++created)))
  const first = peers.acquire('phone')
  first.release()
  const again = peers.acquire('phone')
  assert.notEqual(again.peer, first.peer)
  assert.equal(again.peer.signal.aborted, false)
})

await test('an HTTP call is made as the socket\'s Peer', async () => {
  const { api, peers } = recordingApi()
  const { server } = createMobileServer(api, wireStreamUnused, {})
  const [client, socket] = wirePair()
  const peer = fakePeer('phone')
  bindSocketPeer(socket, peer)
  assert.equal(socketPeer(socket), peer)
  server.emit('connection', socket)
  const response = await roundTrip(client, post('/api/session/list',
    JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'session/list', payload: { args: {} } })))
  assert.match(response, /^HTTP\/1\.1 200/)
  assert.equal(peers.length, 1)
  assert.equal(peers[0], peer, 'the handler must receive the Peer, never undefined')
})

await test('a socket with no Peer never reaches the handler', async () => {
  const { api, peers } = recordingApi()
  const { server } = createMobileServer(api, wireStreamUnused, {})
  const [client, socket] = wirePair()
  server.emit('connection', socket)
  const response = await roundTrip(client, post('/api/session/list', '{}'))
  assert.match(response, /^HTTP\/1\.1 503/)
  assert.equal(peers.length, 0)
})

await test('a disposed Peer\'s socket is refused', async () => {
  const { api, peers } = recordingApi()
  const { server } = createMobileServer(api, wireStreamUnused, {})
  const [client, socket] = wirePair()
  const peer = fakePeer('phone')
  await peer.dispose()
  bindSocketPeer(socket, peer)
  server.emit('connection', socket)
  const response = await roundTrip(client, post('/api/session/list', '{}'))
  assert.match(response, /^HTTP\/1\.1 503/)
  assert.equal(peers.length, 0)
})

await test('a Remote stream opens as the Peer and carries uplink items', async () => {
  const calls: unknown[][] = []
  const wireStream: any = {
    // The harness's signature: (endpoint, payload, uplink, peer, signal).
    async open(endpoint: string, payload: unknown, uplink: AsyncIterable<unknown>, peer: unknown, signal: AbortSignal) {
      calls.push([endpoint, payload, peer, signal instanceof AbortSignal])
      return (async function* echo() {
        for await (const value of uplink) yield { echoed: value }
      })()
    },
    failure: (error: unknown) => ({ code: 'test', message: String(error), details: {} }),
  }
  const { api } = recordingApi()
  const { server, close } = createMobileServer(api, wireStream, {})
  const [client, socket] = wirePair()
  const peer = fakePeer('phone')
  bindSocketPeer(socket, peer)
  server.emit('connection', socket)
  const ws = new WebSocket('ws://mobile.dsh/api/remote.mux', { createConnection: () => client as any })
  const frames: any[] = []
  const ended = new Promise<void>((resolve, reject) => {
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data))
      frames.push(frame)
      if (frame.type === 'end') resolve()
      if (frame.type === 'error') reject(new Error(JSON.stringify(frame)))
    })
    ws.on('error', reject)
  })
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  ws.send(JSON.stringify({ type: 'open', streamId: 's1', endpoint: 'session/watch', payload: { args: {} } }))
  ws.send(JSON.stringify({ type: 'item', streamId: 's1', value: 1 }))
  ws.send(JSON.stringify({ type: 'item', streamId: 's1', value: 2 }))
  ws.send(JSON.stringify({ type: 'end', streamId: 's1' }))
  await ended
  assert.deepEqual(calls, [['session/watch', { args: {} }, peer, true]])
  assert.deepEqual(frames, [
    { type: 'item', streamId: 's1', value: { echoed: 1 } },
    { type: 'item', streamId: 's1', value: { echoed: 2 } },
    { type: 'end', streamId: 's1' },
  ])
  ws.terminate()
  await close()
})

await test('disposing the Peer hangs up its Remote-stream socket', async () => {
  const wireStream: any = {
    async open(_e: string, _p: unknown, _u: unknown, _peer: unknown, signal: AbortSignal) {
      return (async function* forever() {
        await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }) })
      })()
    },
    failure: () => ({ code: 'x', message: 'x', details: {} }),
  }
  const { api } = recordingApi()
  const { server, close } = createMobileServer(api, wireStream, {})
  const [client, socket] = wirePair()
  const peer = fakePeer('phone')
  bindSocketPeer(socket, peer)
  server.emit('connection', socket)
  const ws = new WebSocket('ws://mobile.dsh/api/remote.mux', { createConnection: () => client as any })
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  ws.send(JSON.stringify({ type: 'open', streamId: 's1', endpoint: 'session/watch', payload: { args: {} } }))
  const closed = new Promise<number>((resolve) => { ws.once('close', (code) => { resolve(code) }) })
  await peer.dispose()
  assert.equal(await closed, 1001)
  await close()
})

await test('the uplink inbox fails its stream past the byte ceiling', async () => {
  let overflowed: Error | undefined
  const inbox = new UplinkInbox(10, (error) => { overflowed = error })
  inbox.push('a', 6)
  inbox.push('b', 6)
  assert.ok(overflowed instanceof Error)
  await assert.rejects(async () => { for await (const _ of inbox) { /* drain */ } }, /overflow/)
})

await test('the uplink inbox yields in order and ends cleanly', async () => {
  const inbox = new UplinkInbox(1024, () => {})
  const seen: unknown[] = []
  const reading = (async () => { for await (const value of inbox) seen.push(value) })()
  inbox.push(1, 1)
  inbox.push(2, 1)
  inbox.end()
  await reading
  assert.deepEqual(seen, [1, 2])
})

console.log(results.join('\n'))
console.log(failures === 0 ? '\nALL PASSED' : '\n' + failures + ' FAILED')
if (failures > 0) process.exitCode = 1
process.exit()
