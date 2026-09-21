/**
 * The client half of the end-to-end test, built from the mini-program's own
 * tunnel code.
 *
 * Everything here except the carrier is shipped client code: buildPreamble and
 * the Noise_IK handshake come from stream.ts, the HTTP/1.1 inside the tunnel
 * from http.ts. The carrier is a Node `ws` socket rather than
 * wx.connectSocket, because that API only exists inside WeChat - it plugs into
 * the same SocketFactory seam, which is exactly the seam wsSocket.ts uses.
 */

import WebSocket from 'ws';
import { dialTunnel } from '../../dsh-miniapp/src/transport/tunnel/stream';
import { TunnelHttpClient } from '../../dsh-miniapp/src/transport/tunnel/http';
import { generateKeyPair } from '../../dsh-miniapp/src/transport/tunnel/noise';
import type { SocketFactory, SocketHandlers, SocketLike } from '../../dsh-miniapp/src/transport/tunnel/socket';
import { randomBytes } from 'node:crypto';

const host = process.env.PROXY_HOST ?? '127.0.0.1';
const port = Number(process.env.PROXY_PORT ?? '27101');
const bridgeKey = Buffer.from(process.env.BRIDGE_KEY ?? '', 'base64url');
const pairingToken = Buffer.from(process.env.PAIRING_TOKEN ?? '', 'base64url');

/** The same shape wsSocket.ts implements, over Node's `ws`. */
class NodeWssFactory implements SocketFactory {
  connect(
    address: string,
    socketPort: number,
    timeoutMs: number,
    handlers: SocketHandlers,
  ): Promise<SocketLike> {
    return new Promise((resolve, reject) => {
      const url = 'wss://' + address + ':' + String(socketPort) + '/tunnel';
      // The local proxy runs a self-signed certificate.
      const socket = new WebSocket(url, { rejectUnauthorized: false });
      let open = false;
      let closed = false;
      const queued: Uint8Array[] = [];
      const timer = setTimeout(() => { reject(new Error('wss: timeout')); }, timeoutMs);
      const handle: SocketLike = {
        write(bytes: Uint8Array) {
          if (closed) return;
          if (!open) { queued.push(bytes.slice()); return; }
          socket.send(bytes);
        },
        close() {
          if (closed) return;
          closed = true;
          socket.close();
        },
      };
      socket.on('open', () => {
        open = true;
        for (const pending of queued.splice(0)) socket.send(pending);
        clearTimeout(timer);
        resolve(handle);
      });
      socket.on('message', (data: Buffer) => { handlers.onData(new Uint8Array(data)); });
      socket.on('close', () => { if (!closed) { closed = true; handlers.onClose(); } });
      socket.on('error', (error: Error) => {
        clearTimeout(timer);
        if (!open) reject(error);
        else if (!closed) { closed = true; handlers.onClose(error); }
      });
    });
  }
}

function say(step: string, detail: unknown): void {
  console.log(JSON.stringify({ step, detail }));
}

const deviceKey = generateKeyPair(length => new Uint8Array(randomBytes(length)));
say('device key generated', { deviceId: Buffer.from(deviceKey.publicKey).toString('base64url') });

const stream = await dialTunnel({
  factory: new NodeWssFactory(),
  address: host,
  port,
  bridgeKey: new Uint8Array(bridgeKey),
  deviceKey,
  pairingToken: new Uint8Array(pairingToken),
  random: length => new Uint8Array(randomBytes(length)),
});
say('noise_ik handshake complete', { throughProxy: host + ':' + String(port) });

const client = new TunnelHttpClient(stream, 'mobile.dsh');

const first = await client.request({
  method: 'POST',
  path: '/api/session/list',
  headers: { 'content-type': 'application/json' },
  body: new TextEncoder().encode(JSON.stringify({ limit: 3 })),
});
say('rpc reply', { status: first.status, body: new TextDecoder().decode(first.body) });

const second = await client.request({
  method: 'POST',
  path: '/api/mobileBridge/pair',
  headers: { 'content-type': 'application/json' },
  body: new TextEncoder().encode('{}'),
});
say('control plane must be refused', { status: second.status });

const big = new Uint8Array(400 * 1024).fill(0x41);
const third = await client.request({
  method: 'POST',
  path: '/api/session/search',
  headers: { 'content-type': 'application/json' },
  body: new TextEncoder().encode(JSON.stringify({ blob: Buffer.from(big).toString('base64') })),
});
say('bulk beyond one window', { status: third.status, sentBytes: big.length });

// --- the pairing rules, over the same live chain --------------------------

/** Dial again, so the one-shot pairing token's fate can be observed. */
async function dialAgain(key: typeof deviceKey, token: Uint8Array) {
  return await dialTunnel({
    factory: new NodeWssFactory(),
    address: host,
    port,
    bridgeKey: new Uint8Array(bridgeKey),
    deviceKey: key,
    pairingToken: token,
    random: length => new Uint8Array(randomBytes(length)),
    connectTimeoutMs: 5000,
  });
}

// A device the bridge already knows needs no token on later connections.
try {
  const again = await dialAgain(deviceKey, new Uint8Array(0));
  const reply = await new TunnelHttpClient(again, 'mobile.dsh').request({
    method: 'POST',
    path: '/api/session/list',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode('{}'),
  });
  say('paired device reconnects without a token', { status: reply.status });
} catch (error) {
  say('FAILED: paired device could not reconnect', { error: String(error) });
  process.exit(1);
}

// A device nobody paired must not get in, and the spent token must not work
// a second time.
const stranger = generateKeyPair(length => new Uint8Array(randomBytes(length)));
let strangerGotIn = false;
try {
  await dialAgain(stranger, new Uint8Array(pairingToken));
  strangerGotIn = true;
} catch (error) {
  say('unpaired device refused, spent token not reusable', { error: String(error).slice(0, 80) });
}
if (strangerGotIn) {
  say('FAILED: an unpaired device was served', {});
  process.exit(1);
}

process.exit(0);
