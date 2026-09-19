import { classifyApiRequest } from '../src/http.ts'

/**
 * The phone-facing allowlist policy, exercised against the exact paths the two
 * halves must agree on.
 *
 * Run with `npm test` — node's own test runner over the TypeScript entry, so
 * there is no build step between the source and the assertion.
 */

/** Mirrors DEFAULT_API_ALLOWLIST as the phone sees it. */
const ALLOWLIST: ReadonlySet<string> = new Set([
  '/api/file',
  '/api/session/uploadFileBinary',
  '/api/remote.mux',
  '/api/changes.summary',
  '/api/changes.diff',
])

let failures = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  expected ${String(expected)}, got ${String(actual)}`}`)
}

// —— 0.1.6 的改动文件路由：GET、两段路径，RPC 规则认不出它，只能靠白名单 ——
check('GET changes.summary is allowed', classifyApiRequest('/api/changes.summary', 'GET', undefined, ALLOWLIST), 'allow')
check('GET changes.diff is allowed', classifyApiRequest('/api/changes.diff', 'GET', undefined, ALLOWLIST), 'allow')
check(
  'changes.summary with a JSON content type is still allowed',
  classifyApiRequest('/api/changes.summary', 'GET', 'application/json', ALLOWLIST),
  'allow',
)
// 反证：同一条路径不在白名单里就是 404 的根因。
const WITHOUT: ReadonlySet<string> = new Set(['/api/file', '/api/session/uploadFileBinary', '/api/remote.mux'])
check(
  'changes.summary without the allowlist entry is denied',
  classifyApiRequest('/api/changes.summary', 'GET', undefined, WITHOUT),
  'deny',
)

// —— RPC 通道：POST + JSON，单段命名空间 ——
check('standard RPC POST is allowed', classifyApiRequest('/api/session/list', 'POST', 'application/json', ALLOWLIST), 'allow')
check('permission catalog RPC is allowed', classifyApiRequest('/api/permissionPresets/catalog', 'POST', 'application/json', ALLOWLIST), 'allow')
check('unarchive RPC is allowed', classifyApiRequest('/api/workspace/unarchiveSession', 'POST', 'application/json', ALLOWLIST), 'allow')
check('RPC without a JSON content type is denied', classifyApiRequest('/api/session/list', 'POST', 'text/plain', ALLOWLIST), 'deny')
check('RPC over GET is denied', classifyApiRequest('/api/session/list', 'GET', 'application/json', ALLOWLIST), 'deny')

// —— 控制面永远拒绝，哪怕它长得像 RPC ——
check('control plane pair is refused', classifyApiRequest('/api/mobileBridge/pair', 'POST', 'application/json', ALLOWLIST), 'control')
check('control plane revoke is refused', classifyApiRequest('/api/mobileBridge/revoke', 'POST', 'application/json', ALLOWLIST), 'control')

// —— 未列出的插件路由仍然默认拒绝 ——
check('changes.open is denied', classifyApiRequest('/api/changes.open', 'POST', 'application/json', ALLOWLIST), 'deny')
check('present.open is denied', classifyApiRequest('/api/present.open', 'POST', 'application/json', ALLOWLIST), 'deny')
check('present.host is denied', classifyApiRequest('/api/present.host', 'GET', undefined, ALLOWLIST), 'deny')

console.log('')
if (failures === 0) console.log('ALL PASSED')
else {
  console.log(`${failures} FAILED`)
  process.exitCode = 1
}
