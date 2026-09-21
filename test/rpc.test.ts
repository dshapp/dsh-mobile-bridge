/**
 * The RPC pipe's contract: authorisation is unchanged, and a retry never runs
 * a call twice.
 *
 * The first group is the one that matters for security. A pipe that carried
 * calls straight to the handler would be a way around the mobile allowlist
 * and a road to the control plane, so every framed call is put through the
 * same classifier an HTTP request faces, and these tests hold it there.
 */

import assert from 'node:assert/strict'
import { parseMobileUrl } from '../src/http.ts'
import { dispatchCall, isCall, SessionStore, type RpcReply } from '../src/rpc.ts'

const results: string[] = []
let failures = 0

async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run()
    results.push('PASS  ' + name)
  } catch (error) {
    failures += 1
    results.push('FAIL  ' + name + '\n      ' + String(error))
  }
}

/** The bridge's real default allowlist, as createMobileServer builds it. */
const allowlist = new Set([
  '/api/file',
  '/api/session/uploadFileBinary',
  '/api/remote.mux',
  '/api/rpc.mux',
  '/api/changes.summary',
  '/api/changes.diff',
])

/** A handler that records what reached it and answers with the path. */
function recordingApi(): { api: any, seen: string[] } {
  const seen: string[] = []
  const api = {
    requestBodyMode: () => 'buffered' as const,
    fetch: async (request: Request) => {
      seen.push(new URL(request.url).pathname)
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  }
  return { api, seen }
}

await test('an allowed RPC path reaches the handler', async () => {
  const { api, seen } = recordingApi()
  const reply = await dispatchCall(
    { t: 'call', id: 1, path: '/api/session/list', body: {} }, api, allowlist)
  assert.equal(reply.status, 200)
  assert.deepEqual(seen, ['/api/session/list'])
})

await test('the control plane is refused with 403 and never reaches the handler', async () => {
  const { api, seen } = recordingApi()
  const reply = await dispatchCall(
    { t: 'call', id: 1, path: '/api/mobileBridge/pair', body: {} }, api, allowlist)
  assert.equal(reply.status, 403)
  assert.deepEqual(seen, [], 'the control plane must not be dispatched')
})

await test('a path outside the allowlist is refused with 404', async () => {
  const { api, seen } = recordingApi()
  const reply = await dispatchCall(
    { t: 'call', id: 1, path: '/api/changes.open', body: {} }, api, allowlist)
  assert.equal(reply.status, 404)
  assert.deepEqual(seen, [])
})

await test('a traversal path cannot smuggle in the control plane', async () => {
  const { api, seen } = recordingApi()
  const reply = await dispatchCall(
    { t: 'call', id: 1, path: '/api/session/../mobileBridge/pair', body: {} }, api, allowlist)
  assert.equal(reply.status, 403, 'URL normalisation must not open a side door')
  assert.deepEqual(seen, [])
})

await test('a query string does not change the verdict', async () => {
  const { api, seen } = recordingApi()
  const reply = await dispatchCall(
    { t: 'call', id: 1, path: '/api/mobileBridge/revoke?x=1', body: {} }, api, allowlist)
  assert.equal(reply.status, 403)
  assert.deepEqual(seen, [])
})

await test('a handler failure becomes 502, not a dropped pipe', async () => {
  const api = {
    requestBodyMode: () => 'buffered' as const,
    fetch: async () => { throw new Error('harness is down') },
  }
  const reply = await dispatchCall(
    { t: 'call', id: 4, path: '/api/session/list', body: {} }, api as any, allowlist)
  assert.equal(reply.status, 502)
  assert.equal(reply.id, 4)
})

await test('malformed frames are rejected', () => {
  assert.equal(isCall({ t: 'call', id: 1, path: '/api/a/b' }), true)
  assert.equal(isCall({ t: 'call', id: 0, path: '/api/a/b' }), false, 'ids start at 1')
  assert.equal(isCall({ t: 'call', id: 1.5, path: '/api/a/b' }), false)
  assert.equal(isCall({ t: 'call', id: 1 }), false)
  assert.equal(isCall({ t: 'resume', session: 'x', after: 0 }), false)
  assert.equal(isCall(null), false)
})


await test('a request target naming its own origin is refused', () => {
  // `//elsewhere/api/session/list` parses as host=elsewhere with an
  // allowlisted pathname. Classifying on the pathname and fetching the whole
  // URL would let a caller choose the origin.
  assert.equal(parseMobileUrl('//elsewhere/api/session/list'), null)
  assert.equal(parseMobileUrl('https://elsewhere/api/session/list'), null)
  assert.equal(parseMobileUrl('//user:pw@elsewhere/api/session/list'), null)
  assert.equal(parseMobileUrl('/api/session/list')?.pathname, '/api/session/list')
  assert.equal(parseMobileUrl('http://mobile.dsh/api/session/list')?.pathname, '/api/session/list')
})

await test('a smuggled origin never reaches the handler', async () => {
  const { api, seen } = recordingApi()
  const reply = await dispatchCall(
    { t: 'call', id: 1, path: '//elsewhere/api/session/list', body: {} }, api, allowlist)
  assert.equal(reply.status, 404)
  assert.deepEqual(seen, [], 'the handler must not be reached at all')
})

// ------------------------------------------------------------------ sessions

function reply(id: number, body: unknown = { ok: true }): RpcReply {
  return { t: 'reply', id, status: 200, body }
}

await test('resume replays only what the client has not seen', () => {
  const store = new SessionStore()
  const session = store.open()
  for (const id of [1, 2, 3]) store.finish(session, reply(id))
  assert.deepEqual(store.since(session, 1).map(r => r.id), [2, 3])
  assert.deepEqual(store.since(session, 3).map(r => r.id), [])
})

await test('a retried id returns the cached reply instead of running again', () => {
  const store = new SessionStore()
  const session = store.open()
  store.finish(session, reply(7, { once: true }))
  const settled = store.settled(session, 7)
  assert.deepEqual(settled?.body, { once: true })
  assert.equal(store.settled(session, 8), undefined)
})

await test('a retry of an in-flight id joins it rather than repeating it', async () => {
  const store = new SessionStore()
  const session = store.open()
  let runs = 0
  const work = (async () => { runs += 1; return reply(1) })()
  store.begin(session, 1, work)
  const joined = store.inflight(session, 1)
  assert.ok(joined, 'the in-flight call must be joinable')
  await joined
  await work
  assert.equal(runs, 1, 'the call must have run exactly once')
})

await test('an unknown or expired session cannot be resumed', () => {
  let clock = 1_000_000
  const store = new SessionStore(4 * 1024 * 1024, 1000, () => clock)
  const session = store.open()
  assert.equal(store.resume(session), session)
  assert.equal(store.resume('not-a-session'), null)
  clock += 5000
  assert.equal(store.resume(session), null, 'the session must expire')
  assert.equal(store.size, 0)
})

await test('reply history is bounded, dropping the oldest first', () => {
  const store = new SessionStore(200, 60_000)
  const session = store.open()
  for (let id = 1; id <= 40; id += 1) store.finish(session, reply(id, 'x'.repeat(40)))
  const kept = store.since(session, 0)
  assert.ok(kept.length < 40, 'history must be trimmed')
  assert.equal(kept.at(-1)?.id, 40, 'the newest reply is always kept')
  assert.ok((kept[0]?.id ?? 0) > 1, 'the oldest replies are the ones dropped')
})

await test('the session store is bounded', () => {
  const store = new SessionStore()
  const first = store.open()
  for (let i = 0; i < 200; i += 1) store.open()
  assert.ok(store.size <= 64, 'sessions held: ' + String(store.size))
  assert.equal(store.resume(first), null, 'the oldest session is evicted first')
})

await test('session ids are unguessable and distinct', () => {
  const store = new SessionStore()
  const a = store.open()
  const b = store.open()
  assert.notEqual(a, b)
  assert.ok(a.length >= 43, 'a session id carries 256 bits')
})

console.log(results.join('\n'))
console.log(failures === 0 ? '\nALL PASSED' : '\n' + failures + ' FAILED')
if (failures > 0) process.exitCode = 1
