# dsh mobile access wire protocol (v1)

Three parties: the **phone**, the public **proxy** (`dsh-proxy`), and the
**bridge** (this plugin, inside `dsh server`). The proxy reads 37 plaintext
bytes per connection and never anything else.

## 1. Preamble — 37 bytes, plaintext

```
magic(4) ‖ ver(1) ‖ key(32)
```

| field | phone                     | bridge            |
|-------|---------------------------|-------------------|
| magic | `DSHC`                    | `DSHB`            |
| ver   | `1`                       | `1`               |
| key   | bridgeKey (routing key)   | 32 zero bytes     |

The preamble is also the Noise **prologue** on both links, so a proxy that
rewrote the routing key would break the handshake it forwards.

The key is a **routing identifier, not a secret**: a phone cannot pair without
it, but knowing it proves nothing and grants nothing. Every bridge is instead a
keypair proved by the XX handshake, and every phone a device key proved by the
IK handshake, so the key field is safe to show in a QR code and worth keeping
out of logs only because a log is not the place for it.

## 2. Noise

| link            | pattern | who learns what                                  |
|-----------------|---------|--------------------------------------------------|
| bridge ↔ proxy  | `Noise_XX_25519_ChaChaPoly_SHA256` | proxy learns bridgeKey, proven |
| phone ↔ bridge  | `Noise_IK_25519_ChaChaPoly_SHA256` | bridge learns deviceId, proven; phone verifies bridgeKey |

Handshake and transport messages are framed `[u16 BE len][message]`, so one
Noise message is at most 65535 bytes (plaintext ≤ 65519). During the handshake
alone a receiver may enforce a much smaller ceiling — the three XX messages are
a few hundred bytes — and the proxy rejects anything larger before allocating,
so an unauthenticated peer cannot name a large buffer per connection.

The phone's **first** handshake payload is either empty (already paired) or a
32-byte pairing token (first contact). Nothing else is carried in the
handshake — no bearer token, no timestamp, no signature.

## 3. mux — bridge ↔ proxy only

Inside the XX transport. The proxy is the only side that opens streams.

```
frame = streamId(u32 BE) ‖ kind(u8) ‖ len(u16 BE) ‖ rsv(u8) ‖ payload[len]
kind  = 0 OPEN | 1 DATA | 2 CLOSE | 3 WINDOW_UPDATE
```

- One frame per Noise message; payload ≤ 16384 bytes.
- Each stream starts with a 256 KiB receive window; the consumer returns credit
  with `WINDOW_UPDATE` (payload = u32 BE bytes consumed).
- `streamId 0` carries keepalives (`DATA`, empty) every 30s, which the proxy
  echoes back; 90s of silence ends the link and the bridge reconnects with
  backoff (0.5s → 10s, jittered).

A phone connection becomes one stream: the proxy writes the phone's 37-byte
preamble into it, then copies bytes both ways.

## 4. Inside the IK transport

Plain HTTP/1.1 — the bridge hands the decrypted stream to `node:http`, so
keep-alive and `Upgrade` work unchanged. An authenticated device may reach:

- `POST /api/<namespace>/<method>` — the shared Fetch channel (harness RPC
  envelope), with a JSON content type.
- The exact routes on the bridge's allowlist — `/api/file`,
  `/api/session/uploadFileBinary`, `/api/remote.mux`, `/api/changes.summary` and
  `/api/changes.diff` by default. The `changes.*` pair are `GET` reads, so the
  RPC rule below cannot admit them and they are listed one by one.

Two response-side optimisations ride the same channel, neither of which a phone
has to ask for: a compressible body is gzipped when the request says
`accept-encoding: gzip`, and a `session/list` request may declare
`_request.projections` to trim each row's projection block to the keys it reads
(the host keeps its full copy; a request that says nothing is forwarded
untouched).

Everything else answers 404. The bridge's own control plane under
`/api/mobileBridge/` answers 403 to a phone, even though its paths have the
RPC shape: those routes mint pairing codes and revoke devices, and belong to
the Mac app's authenticated localhost channel.

## 5. Pairing

```
dshm://<proxyHost>:<proxyPort>/<base64url bridgeKey>?name=<this Mac's name>#<base64url pairingToken>
```

The token is 32 random bytes, valid 5 minutes, single use, memory only, and at
most one is live at a time — minting a code retires the previous unused one, so
the code on screen is the only code that works. The device's X25519 public key
becomes its id and is stored with a 180-day expiry; revoking it denies the next
handshake *and* hangs up the connections the device already holds, so a phone
cannot outlive its own revocation by keeping one socket open.

`name` is percent-encoded and optional: the proxy is a shared relay whose
address identifies nothing, so the QR carries this Mac's own name and the phone
uses it as the default label for the pairing. A payload without it stays valid.
