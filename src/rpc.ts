/**
 * The RPC pipe: one WebSocket carrying many `/api` calls.
 *
 * A phone used to spend one HTTPS request per call, and the public proxy had
 * to parse and re-originate every one of them. One socket instead lets the
 * proxy splice bytes and never look inside, which is where nearly all of the
 * measured win comes from. Nothing about *authorisation* changes: every
 * framed call is put through {@link classifyApiRequest} exactly as if it had
 * arrived as its own request, so this pipe can never become a way around the
 * allowlist or a road to the control plane.
 *
 * Reconnection is the other half. A phone loses this socket constantly - the
 * screen locks, the app backgrounds, the network changes - so the pipe keeps
 * a small per-session cache of replies. A reconnecting client replays its
 * session id and asks for everything after the last id it saw. A call whose
 * id is already known is never executed twice: it returns the cached reply,
 * or joins the in-flight one. That makes a retry safe without asking every
 * caller to invent an idempotency key.
 */

import { randomBytes } from 'node:crypto'
import type { ConnectionFetchHandler } from '@deepseek-ai/dsh-client-connection'
import type { WebSocket } from 'ws'
import { classifyApiRequest, parseMobileUrl } from './http.ts'

/** A call the client asked for. */
export interface RpcCall {
  readonly t: 'call'
  /** Client-chosen, strictly increasing per session. A repeat is a retry. */
  readonly id: number
  /** The `/api/<namespace>/<method>` path, exactly as HTTP would use it. */
  readonly path: string
  /** JSON arguments; the pipe only ever sends `application/json`. */
  readonly body?: unknown
}

/** A reply, cached so a reconnecting client can be caught up. */
export interface RpcReply {
  readonly t: 'reply'
  readonly id: number
  readonly status: number
  readonly body: unknown
}

/** Replies held for one client session, oldest first. */
interface Session {
  readonly replies: RpcReply[]
  /** In-flight calls, so a retry joins rather than re-executes. */
  readonly inflight: Map<number, Promise<RpcReply>>
  bytes: number
  lastSeen: number
}

/** How much reply history one session may hold. */
const MAX_SESSION_BYTES = 4 * 1024 * 1024
/** How long a disconnected session stays resumable. */
const SESSION_TTL_MS = 10 * 60 * 1000
/**
 * Sessions held at once.
 *
 * Only paired devices reach this, but a paired device is still a device: one
 * that opens pipes in a loop would otherwise grow the store until the TTL
 * caught up. A phone needs one session, so this is many times what honest use
 * asks for, and the oldest goes first.
 */
const MAX_SESSIONS = 64

/**
 * Per-session reply history.
 *
 * Session ids are minted here rather than accepted from the client: a client
 * that chose its own could name someone else's and read their replies. 256
 * bits of randomness makes the id itself the capability.
 */
export class SessionStore {
  readonly #sessions = new Map<string, Session>()
  readonly #maxBytes: number
  readonly #ttlMs: number
  readonly #now: () => number

  // Written out rather than as parameter properties: this package runs
  // type-stripped, which does not support them.
  constructor(
    maxBytes: number = MAX_SESSION_BYTES,
    ttlMs: number = SESSION_TTL_MS,
    now: () => number = Date.now,
  ) {
    this.#maxBytes = maxBytes
    this.#ttlMs = ttlMs
    this.#now = now
  }

  /** Mint a new session and return its id. */
  open(): string {
    this.#expire()
    // Insertion order is age order, so the first key is the oldest session.
    while (this.#sessions.size >= MAX_SESSIONS) {
      const oldest = this.#sessions.keys().next()
      if (oldest.done === true) break
      this.#sessions.delete(oldest.value)
    }
    const id = randomBytes(32).toString('base64url')
    this.#sessions.set(id, { replies: [], inflight: new Map(), bytes: 0, lastSeen: this.#now() })
    return id
  }

  /** Reattach to an existing session, or `null` when it has expired. */
  resume(id: string): string | null {
    this.#expire()
    const session = this.#sessions.get(id)
    if (session === undefined) return null
    session.lastSeen = this.#now()
    return id
  }

  /** Replies with an id greater than `after`, oldest first. */
  since(id: string, after: number): RpcReply[] {
    const session = this.#sessions.get(id)
    if (session === undefined) return []
    return session.replies.filter(reply => reply.id > after)
  }

  /** A reply already computed for this id, if the client is retrying. */
  settled(id: string, callId: number): RpcReply | undefined {
    return this.#sessions.get(id)?.replies.find(reply => reply.id === callId)
  }

  /** An in-flight call with this id, so a retry joins instead of repeating. */
  inflight(id: string, callId: number): Promise<RpcReply> | undefined {
    return this.#sessions.get(id)?.inflight.get(callId)
  }

  /** Record a call as running, so a duplicate id joins it. */
  begin(id: string, callId: number, work: Promise<RpcReply>): void {
    this.#sessions.get(id)?.inflight.set(callId, work)
  }

  /** Record a finished reply, dropping the oldest history over the ceiling. */
  finish(id: string, reply: RpcReply): void {
    const session = this.#sessions.get(id)
    if (session === undefined) return
    session.inflight.delete(reply.id)
    session.lastSeen = this.#now()
    session.replies.push(reply)
    session.bytes += sizeOf(reply)
    // A long-lived session must not grow without bound, and the oldest
    // replies are the ones a reconnecting client is least likely to want.
    while (session.bytes > this.#maxBytes && session.replies.length > 1) {
      const dropped = session.replies.shift()
      if (dropped === undefined) break
      session.bytes -= sizeOf(dropped)
    }
  }

  /** Sessions currently resumable; for tests and diagnostics. */
  get size(): number {
    this.#expire()
    return this.#sessions.size
  }

  #expire(): void {
    const deadline = this.#now() - this.#ttlMs
    for (const [id, session] of this.#sessions) {
      if (session.lastSeen < deadline) this.#sessions.delete(id)
    }
  }
}

function sizeOf(reply: RpcReply): number {
  return JSON.stringify(reply).length
}

/** Whether a decoded frame is a well-formed call. */
export function isCall(frame: unknown): frame is RpcCall {
  if (typeof frame !== 'object' || frame === null) return false
  const candidate = frame as Record<string, unknown>
  return candidate.t === 'call'
    && Number.isSafeInteger(candidate.id)
    && (candidate.id as number) > 0
    && typeof candidate.path === 'string'
}

/**
 * Run one call against the shared handler, after the same policy an HTTP
 * request would face.
 *
 * The verdict mapping is deliberately identical to the HTTP path: `control`
 * is 403 and anything else unadmitted is 404, so a phone bug looks the same
 * whichever transport carried it.
 */
export async function dispatchCall(
  call: RpcCall,
  api: ConnectionFetchHandler,
  allowlist: ReadonlySet<string>,
): Promise<RpcReply> {
  const url = parseMobileUrl(call.path)
  if (url === null) {
    // The caller named an origin of its own; see parseMobileUrl.
    return { t: 'reply', id: call.id, status: 404, body: { error: 'refused' } }
  }
  const verdict = classifyApiRequest(url.pathname, 'POST', 'application/json', allowlist)
  if (verdict !== 'allow') {
    return {
      t: 'reply',
      id: call.id,
      status: verdict === 'control' ? 403 : 404,
      body: { error: 'refused' },
    }
  }
  try {
    const response = await api.fetch(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(call.body ?? {}),
    }))
    const text = await response.text()
    let body: unknown
    try {
      body = text.length === 0 ? null : JSON.parse(text)
    } catch {
      body = text
    }
    return { t: 'reply', id: call.id, status: response.status, body }
  } catch (error) {
    return {
      t: 'reply',
      id: call.id,
      status: 502,
      body: { error: error instanceof Error ? error.message : 'call failed' },
    }
  }
}

/**
 * Serve one RPC pipe.
 *
 * Writes are serialised through one chain so replies cannot interleave on the
 * wire, for the same reason the Remote-stream socket does it.
 */
export function serveRpcPipe(
  socket: WebSocket,
  api: ConnectionFetchHandler,
  allowlist: ReadonlySet<string>,
  store: SessionStore,
): void {
  let writes = Promise.resolve()

  const send = (message: unknown): void => {
    writes = writes.then(() => new Promise<void>((resolve) => {
      if (socket.readyState !== socket.OPEN) {
        resolve()
        return
      }
      socket.send(JSON.stringify(message), () => { resolve() })
    })).catch(() => undefined)
  }

  // The client learns its session id here and replays it to resume.
  let session = store.open()
  send({ t: 'ready', session })

  socket.on('message', (raw) => {
    let frame: unknown
    try {
      frame = JSON.parse(String(raw))
    } catch {
      send({ t: 'error', message: 'frame is not JSON' })
      return
    }
    if (typeof frame === 'object' && frame !== null && (frame as { t?: unknown }).t === 'resume') {
      const request = frame as { session?: unknown, after?: unknown }
      const wanted = typeof request.session === 'string' ? store.resume(request.session) : null
      if (wanted === null) {
        // Expired or unknown: the client keeps the fresh session it was given
        // at open and starts over, rather than silently losing replies.
        send({ t: 'resumeFailed', session })
        return
      }
      session = wanted
      const after = Number.isSafeInteger(request.after) ? request.after as number : 0
      const missed = store.since(wanted, after)
      send({ t: 'resumed', session: wanted, replayed: missed.length })
      for (const reply of missed) send(reply)
      return
    }
    if (!isCall(frame)) {
      send({ t: 'error', message: 'unknown frame' })
      return
    }
    const current = session
    // A repeated id is a retry across a reconnect, never a second call.
    const already = store.settled(current, frame.id)
    if (already !== undefined) {
      send(already)
      return
    }
    const running = store.inflight(current, frame.id)
    if (running !== undefined) {
      void running.then(send)
      return
    }
    const work = dispatchCall(frame, api, allowlist)
    store.begin(current, frame.id, work)
    void work.then((reply) => {
      store.finish(current, reply)
      send(reply)
    })
  })
}
