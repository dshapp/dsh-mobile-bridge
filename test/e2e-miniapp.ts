/**
 * The mini-program client, against a local proxy and a real bridge.
 *
 * The point is to exercise `wsSocket.ts` itself, not a stand-in for it: the
 * only thing faked is `wx.connectSocket`, shimmed onto Node's `ws` with the
 * same callback shape WeChat gives. Everything above it - the write queue
 * before open, the ArrayBuffer copies, dialTunnel's preamble and Noise_IK,
 * the HTTP/1.1 inside the tunnel - is the shipped code.
 */

import WebSocket from 'ws';
import { dialTunnel } from '../../dsh-miniapp/src/transport/tunnel/stream';
import { TunnelHttpClient } from '../../dsh-miniapp/src/transport/tunnel/http';
import { generateKeyPair } from '../../dsh-miniapp/src/transport/tunnel/noise';
import { WeappWssSocketFactory, tunnelUrl } from '../../dsh-miniapp/src/transport/tunnel/wsSocket';
import { randomBytes } from 'node:crypto';

const host = process.env.PROXY_HOST ?? '127.0.0.1';
const port = Number(process.env.PROXY_PORT ?? '8787');
const bridgeKey = Buffer.from(process.env.BRIDGE_KEY ?? '', 'base64url');
const pairingToken = Buffer.from(process.env.PAIRING_TOKEN ?? '', 'base64url');

/**
 * Stand in for the platform's socket API.
 *
 * `rejectUnauthorized: false` matches what the WeChat devtools do when TLS
 * checking is switched off, which is how a self-signed local proxy is reached.
 * A real build talks to a real certificate and needs none of this.
 */
function installWxShim(): void {
  (globalThis as any).wx = {
    connectSocket(options: { url: string; timeout?: number }) {
      const socket = new WebSocket(options.url, { rejectUnauthorized: false });
      socket.binaryType = 'arraybuffer';
      const task = {
        send(args: { data: ArrayBuffer | string; fail?: (err: unknown) => void }) {
          try {
            socket.send(args.data as ArrayBuffer);
          } catch (error) {
            args.fail?.(error);
          }
        },
        close() { socket.close(); },
        onOpen(listener: () => void) { socket.on('open', listener); },
        onMessage(listener: (r: { data: ArrayBuffer | string }) => void) {
          socket.on('message', (data: Buffer | ArrayBuffer) => {
            // With binaryType 'arraybuffer' the payload arrives as an
            // ArrayBuffer, and `Uint8Array.set` takes an array-like: handed a
            // raw ArrayBuffer it silently copies nothing, so the tunnel reads
            // zeroes and the handshake looks truncated.
            const bytes = data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            const copy = new ArrayBuffer(bytes.byteLength);
            new Uint8Array(copy).set(bytes);
            listener({ data: copy });
          });
        },
        onClose(listener: () => void) { socket.on('close', listener); },
        onError(listener: (err: unknown) => void) { socket.on('error', listener); },
      };
      return task;
    },
  };
}

function say(step: string, detail: unknown): void {
  console.log(JSON.stringify({ client: 'miniapp', step, detail }));
}

installWxShim();
say('url the factory builds', { url: tunnelUrl(host, port) });

const deviceKey = generateKeyPair(length => new Uint8Array(randomBytes(length)));
const stream = await dialTunnel({
  factory: new WeappWssSocketFactory(),
  address: host,
  port,
  bridgeKey: new Uint8Array(bridgeKey),
  deviceKey,
  pairingToken: new Uint8Array(pairingToken),
  random: length => new Uint8Array(randomBytes(length)),
});
say('noise_ik through wx.connectSocket', { ok: true });

const client = new TunnelHttpClient(stream, 'mobile.dsh');
const reply = await client.request({
  method: 'POST',
  path: '/api/session/list',
  headers: { 'content-type': 'application/json' },
  body: new TextEncoder().encode(JSON.stringify({ limit: 2 })),
});
say('rpc reply', { status: reply.status, body: new TextDecoder().decode(reply.body).slice(0, 120) });

const refused = await client.request({
  method: 'POST',
  path: '/api/mobileBridge/pair',
  headers: { 'content-type': 'application/json' },
  body: new TextEncoder().encode('{}'),
});
say('control plane refused', { status: refused.status });

const big = new Uint8Array(300 * 1024).fill(0x42);
const bulk = await client.request({
  method: 'POST',
  path: '/api/session/search',
  headers: { 'content-type': 'application/json' },
  body: new TextEncoder().encode(JSON.stringify({ blob: Buffer.from(big).toString('base64') })),
});
say('bulk past one window', { status: bulk.status, sent: big.length });

process.exit(0);
