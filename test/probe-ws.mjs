// Adversarial probes against a live proxy, over raw TLS so every WebSocket
// byte is under our control.
import tls from 'node:tls';

const PORT = Number(process.env.PORT ?? '27201');
const HOST = '127.0.0.1';

function connect() {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: HOST, port: PORT, rejectUnauthorized: false }, () => resolve(socket));
    socket.on('error', reject);
  });
}

function upgrade(socket) {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      resolve({ head: buffer.subarray(0, end).toString(), rest: buffer.subarray(end + 4) });
    };
    socket.on('data', onData);
    socket.write(
      'GET /tunnel HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\n' +
      'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
  });
}

/** Build a frame by hand: opcode, payload, and whether to mask. */
function frame(opcode, payload, masked = true, declaredLength = null) {
  const length = declaredLength ?? payload.length;
  const head = [];
  head.push(0x80 | opcode);
  const maskBit = masked ? 0x80 : 0x00;
  if (length < 126) head.push(maskBit | length);
  else if (length <= 0xffff) { head.push(maskBit | 126); head.push((length >> 8) & 0xff); head.push(length & 0xff); }
  else {
    head.push(maskBit | 127);
    const big = Buffer.alloc(8);
    big.writeBigUInt64BE(BigInt(length));
    for (const b of big) head.push(b);
  }
  const parts = [Buffer.from(head)];
  if (masked) {
    const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
    parts.push(mask);
    const out = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) out[i] = payload[i] ^ mask[i % 4];
    parts.push(out);
  } else {
    parts.push(Buffer.from(payload));
  }
  return Buffer.concat(parts);
}

const results = [];

// --- 1. does --max-clients-per-ip bound live tunnels? --------------------
{
  const held = [];
  let upgraded = 0;
  for (let i = 0; i < 6; i += 1) {
    try {
      const socket = await connect();
      const { head } = await upgrade(socket);
      if (head.startsWith('HTTP/1.1 101')) upgraded += 1;
      held.push(socket);
    } catch {
      // refused before TLS: that is the ceiling working
    }
  }
  results.push({ probe: 'concurrent tunnels from one IP with --max-clients-per-ip 2', upgraded });
  for (const socket of held) socket.destroy();
}

// --- 2. an oversized ping ------------------------------------------------
{
  const socket = await connect();
  await upgrade(socket);
  let echoed = 0;
  socket.on('data', (chunk) => { echoed += chunk.length; });
  socket.write(frame(0x9, Buffer.alloc(200 * 1024, 0x41)));
  await new Promise(r => setTimeout(r, 1200));
  results.push({ probe: 'ping with a 200 KiB payload (RFC caps control frames at 125)', bytesEchoedBack: echoed });
  socket.destroy();
}

// --- 3. an unmasked client frame ----------------------------------------
{
  const socket = await connect();
  await upgrade(socket);
  let closed = false;
  socket.on('close', () => { closed = true; });
  socket.write(frame(0x2, Buffer.from('DSHC'), false));
  await new Promise(r => setTimeout(r, 800));
  results.push({ probe: 'unmasked client frame (RFC requires masking)', connectionClosed: closed });
  socket.destroy();
}

// --- 4. a frame that declares 900 MB ------------------------------------
{
  const socket = await connect();
  await upgrade(socket);
  let closed = false;
  socket.on('close', () => { closed = true; });
  socket.write(frame(0x2, Buffer.alloc(16), true, 900 * 1024 * 1024));
  await new Promise(r => setTimeout(r, 800));
  results.push({ probe: 'frame declaring 900 MB', connectionClosed: closed });
  socket.destroy();
}

// --- 5. a slow frame that declares just under the cap -------------------
{
  const socket = await connect();
  await upgrade(socket);
  // header only, body dribbled: how much will the proxy hold for us?
  socket.write(frame(0x2, Buffer.alloc(0), true, 15 * 1024 * 1024).subarray(0, 10));
  await new Promise(r => setTimeout(r, 500));
  results.push({ probe: 'header declaring 15 MiB, body withheld', note: 'proxy buffers up to MAX_FRAME per connection' });
  socket.destroy();
}

console.log(JSON.stringify(results, null, 1));
process.exit(0);
