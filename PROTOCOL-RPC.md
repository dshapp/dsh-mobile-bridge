# The RPC pipe (`/api/rpc.mux`)

One WebSocket carries every `/api` call a client makes. It exists so the
public proxy can splice bytes instead of parsing and re-originating an HTTP
request per call — that is where nearly all of the measured win comes from
(32 concurrent connections: 106 677 rps against 59 665, at 42 % of the CPU).

Every client speaks this: Android and the WeChat mini-program alike.

## Opening

```
GET /api/rpc.mux HTTP/1.1
Host: <your domain>
Connection: Upgrade
Upgrade: websocket
Authorization: Bearer <token from POST /pair>
Sec-WebSocket-Version: 13
Sec-WebSocket-Key: <16 random bytes, base64>
```

The token goes in the header, never the query string: a query lands in access
logs and `Referer`. `wx.connectSocket` and OkHttp both support request headers.

The proxy authenticates the token once, here, and then stops looking: after
the 101 it copies bytes. The bridge answers the upgrade and computes
`Sec-WebSocket-Accept` itself.

## Frames

Every frame is one JSON text message. Binary payloads do not belong here —
see *Bulk* below.

### Server → client, first frame

```json
{ "t": "ready", "session": "<43+ chars, base64url>" }
```

The session id is minted by the bridge, never chosen by the client: a client
that picked its own could name someone else's and read their replies. Store it;
it is what makes a reconnect resumable.

### Client → server, a call

```json
{ "t": "call", "id": 7, "path": "/api/session/list", "body": { } }
```

- `id` — an integer ≥ 1, strictly increasing within a session. **A repeated id
  is a retry, never a second call.**
- `path` — exactly the path an HTTP call would use. The bridge puts it through
  the same allowlist (`classifyApiRequest`), so the pipe grants nothing that
  `POST /api/...` would not.
- `body` — JSON arguments. Omitted means `{}`.

### Server → client, a reply

```json
{ "t": "reply", "id": 7, "status": 200, "body": { } }
```

`status` mirrors HTTP, including the refusals: **403** for the control plane,
**404** for a path outside the allowlist, **502** when the harness call threw.
A refusal is a reply, not a dropped socket.

### Client → server, resuming

```json
{ "t": "resume", "session": "<the id from ready>", "after": 6 }
```

Answered by one of:

```json
{ "t": "resumed",      "session": "...", "replayed": 2 }
{ "t": "resumeFailed", "session": "<the fresh id to use instead>" }
```

`resumed` is followed immediately by every reply with an id greater than
`after`, oldest first. `resumeFailed` means the session expired (10 minutes
idle) or never existed; the client keeps the fresh session it was handed at
open and starts its ids again.

## Retries are safe by construction

A phone loses this socket constantly — the screen locks, the app backgrounds,
the network changes. The hard case is a call that was in flight when the
socket died: the client cannot tell whether it ran.

It does not have to. On reconnect it resends the same `id`, and the bridge
either returns the reply it already computed or attaches to the call still
running. **A call with a given id executes exactly once per session**, so no
caller needs to invent an idempotency key.

Reply history is bounded (4 MiB per session, oldest dropped first). A client
that has been away long enough to fall off the end gets the replies that
remain; anything older it must ask for again.

## Bulk stays on HTTPS

File bodies do not go in frames. They keep their own routes:

| route | why not the pipe |
|---|---|
| `POST /api/session/uploadFileBinary` | `wx.uploadFile` is HTTPS-only and gives native progress |
| `GET /api/file` | `wx.downloadFile` likewise, and it streams |

The proxy streams both without buffering, and gives each one a tunnel it
closes afterwards rather than parking — a file transfer should not leave a
large-buffered tunnel and a bridge stream slot idling for a minute.

This is not per-client differentiation: Android and the mini-program behave
identically. It is a split by traffic shape, not by caller.

## Client checklist

1. `POST /pair` once; keep the bearer token.
2. Open the pipe; store the `session` from `ready`.
3. Keep a monotonic `id` counter and a map of unanswered calls.
4. On disconnect: reconnect, send `resume` with the highest id you have seen,
   then **resend every unanswered call with its original id**.
5. On `resumeFailed`: adopt the new session, reset the counter, and fail the
   unanswered calls up to the caller — they may or may not have run, and only
   the caller knows whether that is safe to repeat.
6. Use WebSocket ping/pong for liveness; do not invent a heartbeat frame.

## What the proxy knows

Nothing about any of this. It authenticates the upgrade, then splices bytes,
and it matches *any* `/api` upgrade rather than a list of socket names — so a
new socket can be added to the bridge behind the bridge's own allowlist with
no proxy change and no redeploy of the public component.

That is also what makes end-to-end encryption a later, purely client-and-Mac
decision: sealing these frames would need no proxy change at all.
