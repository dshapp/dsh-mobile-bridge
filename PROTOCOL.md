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

## 2. Noise

| link            | pattern | who learns what                                  |
|-----------------|---------|--------------------------------------------------|
| bridge ↔ proxy  | `Noise_XX_25519_ChaChaPoly_SHA256` | proxy learns bridgeKey, proven |
| phone ↔ bridge  | `Noise_IK_25519_ChaChaPoly_SHA256` | bridge learns deviceId, proven; phone verifies bridgeKey |

Handshake and transport messages are framed `[u16 BE len][message]`, so one
Noise message is at most 65535 bytes (plaintext ≤ 65519).

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
keep-alive and `Upgrade` work unchanged. Two things are reachable:

- `POST /api/<endpoint>` — the shared Fetch channel (harness RPC envelope).
- `GET /api/remote.mux` — the Gateway's Remote-stream WebSocket.

Anything outside `/api` answers 404.

## 5. Pairing

```
dshm://<proxyHost>:<proxyPort>/<base64url bridgeKey>#<base64url pairingToken>
```

The token is 32 random bytes, valid 5 minutes, single use, memory only. The
device's X25519 public key becomes its id and is stored with a 180-day
expiry; revoking it takes effect on the next handshake.
