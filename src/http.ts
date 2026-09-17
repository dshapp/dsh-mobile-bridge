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
import type { ConnectionFetchHandler } from '@deepseek-ai/dsh-client-connection'
import type { TypertGatewayWireStream } from '@deepseek-ai/dsh-api-gateway/types'
import { WebSocketServer, type WebSocket } from 'ws'

/** The Gateway's one WebSocket route, mirrored here for mobile clients. */
const REMOTE_STREAM_MUX_PATH = '/api/remote.mux'
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
 * media and attachment reads, the binary upload the phone composer uses, and
 * the Gateway's Remote-stream socket.
 */
const DEFAULT_API_ALLOWLIST: readonly string[] = [
  '/api/file',
  '/api/session/uploadFileBinary',
  '/api/remote.mux',
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
  const sockets = new WebSocketServer({ noServer: true })
  const server = createServer((req, res) => {
    void serve(req, res, api, allowlist).catch(() => { res.destroy() })
  })
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://mobile.dsh').pathname
    // A WebSocket is not an RPC call: only the exact mux route, and only when
    // the operator has not removed it from the allowlist.
    if (path !== REMOTE_STREAM_MUX_PATH || !allowlist.has(path)) {
      socket.destroy()
      return
    }
    sockets.handleUpgrade(req, socket as Duplex, head, (websocket) => {
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
    request = new Request(url, {
      method,
      headers,
      ...chunks.length > 0 ? { body: Buffer.concat(chunks) } : {},
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
  const response = await api.fetch(request)
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
  if (response.body === null) {
    res.end()
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
