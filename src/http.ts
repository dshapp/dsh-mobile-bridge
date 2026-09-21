/**
 * The harness API, served to phones without a listening socket.
 *
 * A `node:http` server that never calls `listen()` gets its connections by
 * hand, so HTTP/1.1, keep-alive and upgrades come free while the only way in
 * remains a completed Noise handshake. Two things ride it: the shared `/api`
 * Fetch channel, and the Gateway's Remote-stream WebSocket.
 *
 * The share of that channel a phone may reach is decided here, not by the
 * harness: the web carrier wraps the same handler in a Host/Origin fence plus
 * browser authentication, and a phone has neither. What replaces them is
 * {@link classifyApiRequest} — an explicit allowlist for exact plugin routes,
 * the RPC channel left open, and the control plane refused outright.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import type { ConnectionFetchHandler } from '@deepseek-ai/dsh-client-connection'
import type { TypertGatewayWireStream } from '@deepseek-ai/dsh-api-gateway/types'
import { WebSocketServer, type WebSocket } from 'ws'
import { SessionStore, serveRpcPipe } from './rpc.ts'

/** The Gateway's one WebSocket route, mirrored here for mobile clients. */
const REMOTE_STREAM_MUX_PATH = '/api/remote.mux'
/**
 * The RPC pipe: one socket carrying every `/api` call a phone makes.
 *
 * It exists so the public proxy can splice bytes instead of re-originating an
 * HTTP request per call. Authorisation is unchanged - see {@link serveRpcPipe},
 * which puts every framed call through {@link classifyApiRequest}.
 */
const RPC_MUX_PATH = '/api/rpc.mux'
/** Same ceiling the web carrier applies to a buffered /api body. */
const MAX_REQUEST_BODY_BYTES = 300 * 1024 * 1024

/**
 * The bridge's own control plane. It exists for the Mac app, which reaches it
 * over the authenticated localhost web channel; a phone must never see it,
 * because `pair` mints pairing codes and `revoke` ejects devices.
 */
const CONTROL_API_PREFIX = '/api/mobileBridge/'

/**
 * Exact routes a phone may call. Plugin-registered routes are side doors that
 * bypass the RPC envelope, so they are default-deny and listed one by one:
 * media and attachment reads, the binary upload the phone composer uses, the
 * Gateway's Remote-stream socket, and the two read-only routes behind a turn's
 * changed-files card.
 *
 * The change routes are `GET` with two segments (`changes.summary`), so neither
 * the RPC rule (POST + JSON, exactly one segment) nor a wildcard would admit
 * them; they carry no arguments beyond their query and are reads only, which is
 * why they can be listed here as exact paths rather than kept behind a verb.
 */
const DEFAULT_API_ALLOWLIST: readonly string[] = [
  '/api/file',
  '/api/session/uploadFileBinary',
  '/api/remote.mux',
  '/api/rpc.mux',
  '/api/changes.summary',
  '/api/changes.diff',
]

/** One RPC endpoint segment, matching the harness's own grammar. */
const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/

/** Where one mobile request may go. */
export type ApiVerdict = 'allow' | 'deny' | 'control'

/** Extra exact `/api` paths phones may reach, merged with the defaults. */
export interface MobileServerOptions {
  readonly apiAllowlist?: readonly string[]
}

/**
 * Decide one mobile request's fate before it reaches the shared handler.
 *
 * Order is the policy: the control plane is refused first, so a path can never
 * be admitted by looking like an RPC endpoint (every `/api/mobileBridge/<x>`
 * is exactly the `<namespace>/<method>` shape the RPC rule accepts). Exact
 * routes are consulted next, so an allowlisted streaming route is not held to
 * the RPC rule's JSON content type. Only then does the RPC channel answer —
 * and it is `POST` + `application/json` there too, mirroring the harness.
 * @param pathname - request path, already URL-normalized.
 * @param method - HTTP method, upper case.
 * @param contentType - raw `content-type` header, if any.
 * @param allowlist - exact paths admitted to the phone.
 * @returns `control` for the refused control plane, else `allow` or `deny`.
 */
export function classifyApiRequest(
  pathname: string,
  method: string,
  contentType: string | undefined,
  allowlist: ReadonlySet<string>,
): ApiVerdict {
  if (pathname.startsWith(CONTROL_API_PREFIX)) return 'control'
  if (allowlist.has(pathname)) return 'allow'
  if (isRpcEndpoint(pathname) && method === 'POST' && isJson(contentType)) return 'allow'
  return 'deny'
}

/** Whether a path is exactly `/api/<namespace>/<method>`, as the harness means it. */
function isRpcEndpoint(pathname: string): boolean {
  if (!pathname.startsWith('/api/')) return false
  const segments = pathname.slice('/api/'.length).split('/')
  if (segments.length !== 2) return false
  return segments.every(segment =>
    segment !== '.' && segment !== '..' && ENDPOINT_SEGMENT.test(segment))
}

/** The harness's own test: `application/json`, ignoring any parameters. */
function isJson(contentType: string | undefined): boolean {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

/**
 * A compressed body below this size costs more header than it saves.
 *
 * Only applied when the upstream named a `content-length`; a streamed body has
 * no length to judge and is compressed on its content type alone.
 */
const MIN_GZIP_BYTES = 512

/**
 * Whether one `accept-encoding` header admits gzip.
 *
 * `gzip` beats `*` when both appear, and a `q=0` on either forbids it — the
 * phone sends a bare `gzip`, so this exists for correctness rather than for
 * any client the bridge has today.
 * @param acceptEncoding - the raw request header, if any.
 * @returns whether gzip may be used.
 */
function acceptsGzip(acceptEncoding: string | undefined): boolean {
  if (acceptEncoding === undefined) return false
  let gzip = -1
  let star = -1
  for (const part of acceptEncoding.split(',')) {
    const [rawName, ...params] = part.split(';')
    const name = rawName?.trim().toLowerCase()
    if (name !== 'gzip' && name !== '*') continue
    let quality = 1
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param)
      if (match !== null) quality = Number(match[1])
    }
    if (name === 'gzip') gzip = quality
    else star = quality
  }
  return (gzip >= 0 ? gzip : star) > 0
}

/**
 * Whether a body is worth deflating.
 *
 * Only text and JSON qualify: a Noise tunnel already pays the frame cost once,
 * and gzipping an attachment or an image spends CPU to make it larger. The
 * match is deliberately positive — an unknown content type is left alone.
 * @param contentType - raw `content-type` from the upstream response.
 * @returns whether gzip should be tried.
 */
function isCompressible(contentType: string | undefined): boolean {
  if (contentType === undefined) return false
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (mime.startsWith('text/')) return true
  return mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/javascript' ||
    mime === 'image/svg+xml' ||
    mime.endsWith('+json') ||
    mime.endsWith('+xml')
}

/**
 * Whether the upstream already declared this body small enough to skip.
 * @param contentLength - raw `content-length` from the upstream response.
 * @returns whether the body is known to be below {@link MIN_GZIP_BYTES}.
 */
function isNegligiblySmall(contentLength: string | null): boolean {
  if (contentLength === null) return false
  const size = Number(contentLength)
  return Number.isFinite(size) && size >= 0 && size < MIN_GZIP_BYTES
}

/** The one RPC whose rows carry a projection block a phone may ask to trim. */
const SESSION_LIST_PATH = '/api/session/list'

/**
 * The projection keys one caller asked this list to keep, or `null` for "all".
 *
 * A phone's list screen only draws a couple of keys, but a list row's projection
 * block is by far the largest part of the response (every key any panel might
 * need, for every Session). The host ignores unknown request fields, so the
 * caller declares what it reads as `_request.projections` and the bridge honours
 * it here; the host stays authoritative and a caller that says nothing keeps
 * today's full list. An empty declaration is meaningless, so it is treated as
 * "all" rather than "none".
 * @param pathname - request path, already URL-normalized.
 * @param method - HTTP method, upper case.
 * @param body - the request body when it was buffered, if any.
 * @returns the declared keys, or `null` to forward the response untouched.
 */
function requestedProjections(pathname: string, method: string, body: Buffer | null): string[] | null {
  if (pathname !== SESSION_LIST_PATH || method !== 'POST' || body === null || body.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'))
    const request = record(record(record(parsed)?.payload)?.args)?._request
    const declared = record(request)?.projections
    if (!Array.isArray(declared) || declared.length === 0) return null
    const keys = declared.filter((key): key is string => typeof key === 'string' && key.length > 0)
    return keys.length === 0 ? null : keys
  } catch {
    return null
  }
}

/** Narrow an unknown JSON value to a plain object. */
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Keep only the declared projection keys on every row of one `session/list`
 * response, preserving the envelope byte-for-byte otherwise.
 *
 * The body is buffered to rewrite it, so a response that is not the expected
 * JSON is forwarded unchanged; a failure can only make this a no-op, never a
 * broken reply.
 * @param response - the upstream Fetch response.
 * @param keys - projection keys to keep.
 * @returns a response carrying the trimmed list.
 */
async function trimListProjections(response: Response, keys: readonly string[]): Promise<Response> {
  const bytes = new Uint8Array(await response.arrayBuffer())
  const headers = new Headers(response.headers)
  deleteContentLength(headers)
  let body: string = ''
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    const items = record(record(record(parsed)?.result)?.value)?.items
    if (!Array.isArray(items)) return new Response(bytes, { status: response.status, headers })
    for (const item of items) {
      const block = record(record(item)?.projections)
      const values = record(block?.values)
      if (block === null || values === null) continue
      const kept: Record<string, unknown> = {}
      for (const key of keys) if (Object.hasOwn(values, key)) kept[key] = values[key]
      block.values = kept
    }
    body = JSON.stringify(parsed)
  } catch {
    return new Response(bytes, { status: response.status, headers })
  }
  return new Response(body, { status: response.status, headers })
}

/** Drop a now-stale framing header; a rewritten body computes its own length. */
function deleteContentLength(headers: Headers): void {
  headers.delete('content-length')
}

/** Build the port-less HTTP server that mobile connections are fed into. */
export function createMobileServer(
  api: ConnectionFetchHandler,
  wireStream: TypertGatewayWireStream,
  options: MobileServerOptions = {},
): { server: Server, close: () => Promise<void> } {
  const allowlist: ReadonlySet<string> = new Set([
    ...DEFAULT_API_ALLOWLIST,
    ...options.apiAllowlist ?? [],
  ])
  // OkHttp (the phone's client) offers `permessage-deflate` on every upgrade,
  // so this costs one negotiating header and turns the mux's JSON into deflate
  // frames. The threshold keeps small projection frames off the zlib path.
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 256 } })
  const server = createServer((req, res) => {
    void serve(req, res, api, allowlist).catch(() => { res.destroy() })
  })
  // Reply history outlives any one socket, because resuming a dropped pipe
  // is the whole point of keeping it.
  const rpcSessions = new SessionStore()
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://mobile.dsh').pathname
    // A WebSocket is not an RPC call: only the exact socket routes, and only
    // when the operator has not removed them from the allowlist.
    const known = path === REMOTE_STREAM_MUX_PATH || path === RPC_MUX_PATH
    if (!known || !allowlist.has(path)) {
      socket.destroy()
      return
    }
    sockets.handleUpgrade(req, socket as Duplex, head, (websocket) => {
      if (path === RPC_MUX_PATH) {
        serveRpcPipe(websocket, api, allowlist, rpcSessions)
        return
      }
      serveRemoteStreams(websocket, wireStream)
    })
  })
  const close = async (): Promise<void> => {
    for (const socket of sockets.clients) socket.terminate()
    await new Promise<void>((resolve) => { sockets.close(() => { resolve() }) })
    server.closeAllConnections()
  }
  return { server, close }
}

/**
 * Bridge one node:http request to the shared Fetch channel, after the mobile
 * capability policy has admitted it.
 *
 * This mirrors the web carrier's own bridge, but the fence in front of it is
 * different by necessity: the web side proves a browser session with a cookie
 * and a Host/Origin check, and this side has already proved a paired device
 * with the Noise handshake. The handshake says *who* is calling; the allowlist
 * in {@link classifyApiRequest} decides *what* they may call.
 */
async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  api: ConnectionFetchHandler,
  allowlist: ReadonlySet<string>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://mobile.dsh')
  const verdict = classifyApiRequest(url.pathname, req.method ?? 'GET', req.headers['content-type'], allowlist)
  if (verdict !== 'allow') {
    // `control` is a deliberate refusal, not a missing page: keep it distinct
    // in the status so a phone bug is diagnosable without leaking anything.
    res.writeHead(verdict === 'control' ? 403 : 404)
    res.end()
    // Drain the body so a keep-alive connection stays usable for the next call.
    req.resume()
    return
  }
  const abort = new AbortController()
  // 'close' on the response, not the request: request close fires as soon as
  // the body is consumed, which would abort every streaming response at open.
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
  const method = req.method ?? 'GET'
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([, value]) => typeof value === 'string') as [string, string][],
  )
  const mode = api.requestBodyMode({ method, url })
  // A declared projection allowlist only exists on a buffered body; a streamed
  // request cannot be inspected without consuming it, so it forwards as today.
  let listKeys: string[] | null = null
  let request: Request
  if (mode === 'buffered') {
    const chunks: Buffer[] = []
    let received = 0
    for await (const chunk of req) {
      received += (chunk as Buffer).byteLength
      if (received > MAX_REQUEST_BODY_BYTES) {
        res.writeHead(413, { connection: 'close' })
        res.end()
        req.destroy()
        return
      }
      chunks.push(chunk as Buffer)
    }
    const body = chunks.length > 0 ? Buffer.concat(chunks) : null
    listKeys = requestedProjections(url.pathname, method, body)
    request = new Request(url, {
      method,
      headers,
      ...body === null ? {} : { body },
      signal: abort.signal,
    })
  } else {
    request = new Request(url, {
      method,
      headers,
      body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
      signal: abort.signal,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })
  }
  const upstream = await api.fetch(request)
  // Honour a caller-declared projection allowlist before compressing: the
  // trimmed JSON is what the relay carries, and the host kept its full copy.
  const response = listKeys === null ? upstream : await trimListProjections(upstream, listKeys)
  const responseHeaders = new Headers(response.headers)
  // Compress before writing any header: the compressed length is unknown, so
  // `content-length` has to go and the framing becomes chunked. The web
  // carrier gzips these same responses; a phone used to be handed them raw.
  const gzip = response.body !== null &&
    method !== 'HEAD' &&
    !responseHeaders.has('content-encoding') &&
    acceptsGzip(req.headers['accept-encoding']) &&
    isCompressible(responseHeaders.get('content-type') ?? undefined) &&
    !isNegligiblySmall(responseHeaders.get('content-length'))
  if (gzip) {
    responseHeaders.delete('content-length')
    responseHeaders.set('content-encoding', 'gzip')
    const vary = responseHeaders.get('vary')
    responseHeaders.set('vary', vary === null ? 'accept-encoding' : `${vary}, accept-encoding`)
  }
  res.writeHead(response.status, Object.fromEntries(responseHeaders.entries()))
  if (response.body === null) {
    res.end()
    return
  }
  if (gzip) {
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
      createGzip(),
      res,
    ).catch(() => { res.destroy() })
    return
  }
  for await (const chunk of response.body) {
    if (!res.write(chunk)) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          res.off('drain', done)
          res.off('close', done)
          resolve()
        }
        res.once('drain', done)
        res.once('close', done)
      })
    }
  }
  res.end()
}

/** Serve the Gateway's multiplexed Remote streams over one WebSocket. */
function serveRemoteStreams(socket: WebSocket, wireStream: TypertGatewayWireStream): void {
  const streams = new Map<string, AbortController>()
  let writes = Promise.resolve()

  const send = (message: unknown): Promise<void> => {
    const delivery = writes.then(() => new Promise<void>((resolve, reject) => {
      if (socket.readyState !== socket.OPEN) {
        reject(new Error('mobile-bridge: Remote stream socket is closed'))
        return
      }
      socket.send(JSON.stringify(message), error => { error ? reject(error) : resolve() })
    }))
    writes = delivery.catch(() => undefined)
    return delivery
  }

  const pump = async (streamId: string, endpoint: string, payload: unknown, abort: AbortController): Promise<void> => {
    try {
      const source = await wireStream.open(endpoint, payload, abort.signal)
      for await (const value of source) await send({ type: 'item', streamId, value })
      if (!abort.signal.aborted) await send({ type: 'end', streamId })
    } catch (error) {
      if (!abort.signal.aborted && socket.readyState === socket.OPEN) {
        try {
          await send({ type: 'error', streamId, error: wireStream.failure(error) })
        } catch {
          socket.close(1011, 'Remote stream failure could not be delivered')
        }
      }
    } finally {
      streams.delete(streamId)
    }
  }

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      socket.close(1003, 'text messages required')
      return
    }
    let message: { type?: string, streamId?: string, endpoint?: string, payload?: unknown }
    try {
      message = JSON.parse(String(data)) as typeof message
    } catch {
      socket.close(1008, 'invalid Remote stream request')
      return
    }
    const streamId = message.streamId
    if (typeof streamId !== 'string') return
    if (message.type === 'cancel') {
      streams.get(streamId)?.abort(new Error('Remote stream cancelled'))
      return
    }
    if (message.type !== 'open' || typeof message.endpoint !== 'string' || streams.has(streamId)) return
    const abort = new AbortController()
    streams.set(streamId, abort)
    void pump(streamId, message.endpoint, message.payload, abort)
  })

  socket.once('close', () => {
    for (const abort of streams.values()) abort.abort(new Error('Remote stream socket closed'))
    streams.clear()
  })
  socket.once('error', () => { socket.terminate() })
}
