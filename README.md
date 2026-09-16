# dsh-mobile-bridge

Serves this harness's `/api` to paired phones, over a Noise-encrypted tunnel to
a public [`dsh-proxy`](../dsh-proxy). It opens **no port**, writes **no state
file**, runs **no extra process**, and forges **no cookie**: it is a cordis
plugin that lives and dies with `dsh server`.

```
iPhone --bare TCP--> dsh-proxy --mux over Noise_XX--> this plugin --in process--> dsh
        Noise_IK, end to end between the phone and this plugin
```

- **Authentication is the handshake.** Noise_IK proves the device's static key
  (that key *is* the device id) and proves us to the device. A device that is
  neither whitelisted nor carrying a live pairing token is dropped before any
  harness traffic is served. No TLS, no certificate, no bearer token.
- **The proxy learns nothing.** It reads a 37-byte routing preamble and copies
  bytes; it cannot decrypt, and it stores nothing on disk.

See [PROTOCOL.md](PROTOCOL.md) for the wire format.

## Install

```sh
dsh plugin --profile web add dsh-mobile-bridge
```

## Config

```yaml
- id: mobile-bridge
  config:
    proxyHost: 127.0.0.1   # public proxy the phone dials
    proxyPort: 8787
    proxyPublicKey: ''     # optional base64 key to pin
    deviceTtlDays: 180
```

## Control API

Three exact routes on the shared channel, for the Mac app:

| route | answer |
|---|---|
| `POST /api/mobileBridge/status` | `bridgeKey`, proxy address, `connected`, paired `devices` |
| `POST /api/mobileBridge/pair` | one-shot `dshm://` pairing URL and its expiry |
| `POST /api/mobileBridge/revoke` | `{ removed }` for one `deviceId` |

## Develop

```sh
pnpm install
pnpm run check      # typecheck + build
dsh plugin --profile web add link:$PWD
```
