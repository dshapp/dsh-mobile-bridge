/**
 * The harness API, served to phones without a listening socket.
 *
 * A `node:http` server that never calls `listen()` gets its connections by
 * hand, so HTTP/1.1, keep-alive and upgrades come free while the only way in
 * remains a completed Noise handshake. Two things ride it: the shared `/api`
 * Fetch channel, and the Gateway's Remote-stream WebSocket.
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

/** Build the port-less HTTP server that mobile connections are fed into. */
export function createMobileServer(
  api: ConnectionFetchHandler,
  wireStream: TypertGatewayWireStream,
): { server: Server, close: () => Promise<void> } {
  const sockets = new WebSocketServer({ noServer: true })
  const server = createServer((req, res) => {
    void serve(req, res, api).catch(() => { res.destroy() })
  })
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://mobile.dsh').pathname
    if (path !== REMOTE_STREAM_MUX_PATH) {
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
 * Bridge one node:http request to the shared Fetch channel.
 * Mirrors the web carrier's own bridge, minus the browser trust fence: this
 * connection was authenticated by the Noise handshake, not by a cookie.
 */
async function serve(req: IncomingMessage, res: ServerResponse, api: ConnectionFetchHandler): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://mobile.dsh')
  if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
    res.writeHead(404)
    res.end()
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
