/**
 * The browser face of the bridge: the same Mobile Access screen the Mac app
 * shows, served by the plugin itself.
 *
 * Two exact routes on the composition's `webServer`, both behind the harness's
 * ordinary browser fence (`connection.requestRejection`): `/mobile` is the
 * page, `/mobile/qr` is the live pairing code as SVG. Nothing new is
 * authenticated — a browser that may open the harness may open this, and a
 * phone cannot reach either, because the mobile server refuses everything
 * outside its allowlist and the tunnel terminates before this carrier.
 *
 * The page talks to the existing `/api/mobileBridge/*` control routes, so the
 * plugin keeps exactly one source of truth and the page owns no state.
 *
 * `webServer` is optional: in a composition that serves no browsers (Electron,
 * a headless run) the page simply does not exist and the tunnel is unaffected.
 *
 * @module dsh-mobile-bridge/web
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import qrcode from 'qrcode-generator'
import { pairingView, type ControlDeps } from './api.ts'

/** The page itself. */
export const PAGE_PATH = '/mobile'
/** The pairing QR, live: whatever the bridge currently offers, or 404. */
export const QR_PATH = '/mobile/qr'

/**
 * Serve the Mobile Access page for as long as a web server exists.
 * @param ctx - plugin context; `connection` is already required by the bridge.
 * @param deps - the same control-plane dependencies the API routes use.
 */
export function registerControlPage(ctx: Context, deps: ControlDeps): void {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: PAGE_PATH,
      handler: (req, res) => {
        if (rejected(webCtx, req, res)) return
        if (!isRead(req)) {
          methodNotAllowed(req, res)
          return
        }
        res.statusCode = 200
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.setHeader('referrer-policy', 'no-referrer')
        res.setHeader('x-content-type-options', 'nosniff')
        res.setHeader(
          'content-security-policy',
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
          + "img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        )
        res.end(req.method === 'HEAD' ? undefined : PAGE_HTML)
      },
    }), `mobile-bridge: GET ${PAGE_PATH}`)

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: QR_PATH,
      handler: (req, res) => {
        if (rejected(webCtx, req, res)) return
        if (!isRead(req)) {
          methodNotAllowed(req, res)
          return
        }
        const pairing = deps.devices.activePairing()
        if (pairing === null) {
          // No code to draw: the screen says so, and a stale <img> must not
          // keep showing a token that no longer pairs anything.
          res.statusCode = 404
          res.end()
          return
        }
        const qr = qrcode(0, 'M')
        qr.addData(pairingView(deps, pairing).url)
        qr.make()
        res.statusCode = 200
        res.setHeader('content-type', 'image/svg+xml; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.setHeader('referrer-policy', 'no-referrer')
        res.end(req.method === 'HEAD' ? undefined : qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }))
      },
    }), `mobile-bridge: GET ${QR_PATH}`)

    // Announced on the console next to "dsh web: ..." so the page is findable
    // without reading the plugin source. `logger.info` does not reach the
    // terminal in this composition, and a page nobody can find is not shipped.
    const host = webCtx.webServer.host === '0.0.0.0' ? '127.0.0.1' : webCtx.webServer.host
    console.log(`dsh mobile access: http://${host}:${String(webCtx.webServer.port)}${PAGE_PATH}`)
  })
}

/** True when the ordinary browser fence refused the request. */
function rejected(ctx: Context, req: IncomingMessage, res: ServerResponse): boolean {
  const rejection = ctx.connection.requestRejection(req)
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}

function isRead(req: IncomingMessage): boolean {
  return req.method === 'GET' || req.method === 'HEAD'
}

function methodNotAllowed(req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 405
  res.setHeader('allow', 'GET, HEAD')
  res.end()
}

/**
 * One self-contained document: no CDN, no build step, no external asset, so the
 * bridge's whole console travels inside the plugin bundle and works offline.
 *
 * It is the Mac settings screen in HTML — relay state with cut/restore, the
 * paired phones with rename and revoke, and the pairing code — and it renders
 * only from `/api/mobileBridge/status`, the same read the Mac app polls.
 *
 * Everything here is deliberately plain: a classic script, string
 * concatenation, and no template literals, so the source stays one literal.
 */
const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Mobile Access</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #f5f5f7; --card: #fff; --text: #1d1d1f; --secondary: #6e6e73;
  --separator: rgba(0,0,0,.1); --accent: #007aff; --danger: #ff3b30;
  --done: #34c759; --warn: #ff9f0a; --shadow: 0 1px 2px rgba(0,0,0,.06);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1c1c1e; --card: #2c2c2e; --text: #f5f5f7; --secondary: #98989d;
    --separator: rgba(255,255,255,.14); --accent: #0a84ff; --danger: #ff453a;
    --done: #30d158; --warn: #ffd60a; --shadow: none;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 32px 20px 64px; background: var(--bg); color: var(--text);
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
  -webkit-font-smoothing: antialiased;
}
main { max-width: 560px; margin: 0 auto; }
h1 { font-size: 22px; font-weight: 700; letter-spacing: -.2px; margin: 0 0 16px; }
h2 { font-size: 13px; font-weight: 600; margin: 0; }
.card { background: var(--card); border-radius: 10px; box-shadow: var(--shadow); margin: 0 0 18px; overflow: hidden; }
.card > .row + .row, .list .row + .row { border-top: 1px solid var(--separator); }
.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; min-height: 46px; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 14px; border-bottom: 1px solid var(--separator); }
.label { min-width: 0; }
.label .name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.label .addr { color: var(--secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.value { display: flex; align-items: center; gap: 12px; flex: none; }
.status { display: inline-flex; align-items: center; gap: 7px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--secondary); flex: none; }
.dot.done { background: var(--done); }
.dot.warning { background: var(--warn); }
.dot.error { background: var(--danger); }
.dot.ongoing { background: var(--warn); animation: pulse 1.2s ease-in-out infinite; }
.dot.idle { background: var(--separator); border: 1px solid var(--secondary); }
@keyframes pulse { 50% { opacity: .3; } }
.muted { color: var(--secondary); }
.done-text { color: var(--done); }
.warn-text { color: var(--warn); }
button { font: inherit; color: var(--accent); background: none; border: 0; padding: 2px 0; cursor: pointer; }
button:hover { text-decoration: underline; }
button.danger { color: var(--danger); }
button.small { font-size: 12px; }
button:disabled { color: var(--secondary); cursor: default; text-decoration: none; }
.pairing { padding: 16px; text-align: center; }
.pairing img { width: 220px; height: 220px; border-radius: 8px; background: #fff; }
#pair-gone { padding: 24px 16px; }
#pair-gone .name { font-weight: 600; margin-bottom: 6px; }
.actions { margin-top: 12px; }
.hint, .note { color: var(--secondary); margin: 8px auto 0; max-width: 360px; }
.note { font-size: 12px; }
dialog { border: 0; border-radius: 12px; padding: 18px; width: 300px; background: var(--card); color: var(--text); box-shadow: 0 12px 40px rgba(0,0,0,.3); }
dialog::backdrop { background: rgba(0,0,0,.35); }
dialog h2 { font-size: 15px; margin-bottom: 12px; }
dialog label { display: block; color: var(--secondary); font-size: 12px; margin-bottom: 4px; }
dialog input { width: 100%; font: inherit; padding: 6px 8px; border: 1px solid var(--separator); border-radius: 6px; background: var(--bg); color: var(--text); }
dialog .buttons { display: flex; justify-content: flex-end; gap: 16px; margin-top: 16px; }
dialog .buttons .primary { font-weight: 600; }
[hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <h1 data-i18n="title">Mobile Access</h1>

  <section class="card">
    <div class="row">
      <div class="label">
        <div class="name" data-i18n="relay">Relay</div>
        <div class="addr" id="relay-addr"></div>
      </div>
      <div class="value">
        <span class="status"><span class="dot" id="relay-dot"></span><span id="relay-text"></span></span>
        <button id="relay-action" class="danger" hidden></button>
      </div>
    </div>
  </section>

  <section class="card">
    <div class="head">
      <h2 data-i18n="devices">Paired phones</h2>
      <button id="add" class="small" data-i18n="addDevice">Add Device</button>
    </div>
    <div class="list" id="device-list"></div>
  </section>

  <section class="card">
    <div class="pairing">
      <img id="qr" alt="" hidden>
      <div id="pair-gone" hidden>
        <div class="name" data-i18n="pair">Pair a Phone</div>
        <div class="muted" id="pair-gone-text"></div>
        <div class="actions"><button id="new-code" hidden data-i18n="newCode">New QR Code</button></div>
      </div>
      <div id="pair-actions" hidden>
        <div class="actions"><button id="copy" data-i18n="copy">Copy Pairing String</button></div>
        <p class="hint" id="pair-hint" hidden></p>
        <p class="note" id="pair-mac" hidden></p>
        <p class="note" id="pair-offline" hidden></p>
      </div>
    </div>
  </section>
</main>

<dialog id="rename">
  <form method="dialog">
    <h2 data-i18n="renamePhone">Rename Phone</h2>
    <label for="rename-input" data-i18n="phoneName">Phone Name</label>
    <input id="rename-input" maxlength="64" autocomplete="off" spellcheck="false">
    <div class="buttons">
      <button type="button" id="rename-cancel" data-i18n="cancel">Cancel</button>
      <button type="submit" value="ok" class="primary" data-i18n="save">Rename</button>
    </div>
  </form>
</dialog>

<script>
(function () {
  'use strict'

  var EN = {
    title: 'Mobile Access', relay: 'Relay', relayUp: 'Relay connected',
    relayDown: 'Relay disconnected', relayCut: 'Mobile access cut off',
    disconnect: 'Cut Mobile Access', reconnect: 'Restore Mobile Access',
    devices: 'Paired phones', addDevice: 'Add Device', noDevices: 'No paired devices',
    rename: 'Rename', revoke: 'Revoke', presenceOnline: 'Connected',
    justNow: 'Last seen just now', lastSeen: 'Last seen %s ago',
    minutes: '%dmin', hours: '%dh', days: '%dd',
    pair: 'Pair a Phone', copy: 'Copy Pairing String', copied: 'Copied',
    scanHint: 'Scan this code with DeepSeek Harness on iPhone. It is single use and expires in five minutes.',
    thisMac: 'Phones will see this Mac as \u201C%s\u201D',
    offline: 'Waiting for the relay connection; this code still works once it is up.',
    newCode: 'New QR Code',
    codeGone: 'This code is used up. Generate a new one to add another phone.',
    notInstalled: 'Plugin not installed', loading: 'Loading\u2026', failed: 'Something went wrong.',
    renamePhone: 'Rename Phone', phoneName: 'Phone Name', cancel: 'Cancel', save: 'Rename'
  }
  var ZH = {
    title: '\u79FB\u52A8\u7AEF\u8BBF\u95EE', relay: '\u4E2D\u8F6C\u670D\u52A1',
    relayUp: '\u5DF2\u8FDE\u4E0A\u4E2D\u8F6C', relayDown: '\u672A\u8FDE\u4E0A\u4E2D\u8F6C',
    relayCut: '\u5DF2\u5207\u65AD\u79FB\u52A8\u7AEF\u8BBF\u95EE',
    disconnect: '\u5207\u65AD\u79FB\u52A8\u7AEF\u8BBF\u95EE',
    reconnect: '\u6062\u590D\u79FB\u52A8\u7AEF\u8BBF\u95EE',
    devices: '\u5DF2\u914D\u5BF9\u7684\u624B\u673A', addDevice: '\u6DFB\u52A0\u8BBE\u5907',
    noDevices: '\u8FD8\u6CA1\u6709\u914D\u5BF9\u7684\u8BBE\u5907',
    rename: '\u91CD\u547D\u540D', revoke: '\u540A\u9500',
    presenceOnline: '\u5DF2\u8FDE\u63A5', justNow: '\u521A\u521A\u8FD8\u5728\u7EBF',
    lastSeen: '%s\u524D\u5728\u7EBF', minutes: '%d\u5206\u949F', hours: '%d\u5C0F\u65F6', days: '%d\u5929',
    pair: '\u914D\u5BF9\u624B\u673A', copy: '\u590D\u5236\u914D\u5BF9\u4E32', copied: '\u5DF2\u590D\u5236',
    scanHint: '\u7528 iPhone \u4E0A\u7684 DeepSeek Harness \u626B\u63CF\u6B64\u7801\u3002\u4E00\u7801\u4E00\u53F0\u8BBE\u5907\uFF0C5 \u5206\u949F\u540E\u5931\u6548\u3002',
    thisMac: '\u624B\u673A\u4E0A\u4F1A\u663E\u793A\u4E3A\u201C%s\u201D',
    offline: '\u5C1A\u672A\u8FDE\u4E0A\u4E2D\u8F6C\uFF0C\u8FDE\u4E0A\u540E\u6B64\u7801\u4F9D\u7136\u6709\u6548\u3002',
    newCode: '\u91CD\u65B0\u751F\u6210\u4E8C\u7EF4\u7801',
    codeGone: '\u8FD9\u5F20\u7801\u5DF2\u7ECF\u7528\u6389\u4E86\uFF0C\u518D\u52A0\u4E00\u53F0\u624B\u673A\u8BF7\u91CD\u65B0\u751F\u6210\u3002',
    notInstalled: '\u672A\u5B89\u88C5\u63D2\u4EF6', loading: '\u67E5\u627E\u4E2D\u2026',
    failed: '\u51FA\u9519\u4E86\u3002',
    renamePhone: '\u91CD\u547D\u540D\u624B\u673A', phoneName: '\u624B\u673A\u540D\u79F0',
    cancel: '\u53D6\u6D88', save: '\u91CD\u547D\u540D'
  }

  var zh = String(navigator.language || '').toLowerCase().indexOf('zh') === 0
  var S = zh ? ZH : EN

  function t(key) { return S[key] || EN[key] || key }

  function el(id) { return document.getElementById(id) }

  document.title = t('title')
  document.documentElement.lang = zh ? 'zh' : 'en'
  var labelled = document.querySelectorAll('[data-i18n]')
  for (var i = 0; i < labelled.length; i++) {
    labelled[i].textContent = t(labelled[i].getAttribute('data-i18n'))
  }

  var seq = 0
  var state = { phase: 'loading', status: null, error: '' }
  var autoPaired = false
  var minting = false
  var copied = false
  var renaming = null

  /** One control-plane call: the same envelope every harness endpoint speaks. */
  function call(name, args) {
    var rpcId = 'mobile-web-' + (++seq)
    return fetch('/api/mobileBridge/' + name, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcId: rpcId, method: 'mobileBridge/' + name, payload: { args: args || {} } })
    }).then(function (response) {
      return response.json().catch(function () { return null }).then(function (body) {
        var result = body && body.result
        if (!result || result.ok !== true) {
          var message = result && result.error && result.error.message
          throw new Error(message || ('HTTP ' + response.status))
        }
        return result.value
      })
    })
  }

  function phaseFor(error) {
    return String((error && error.message) || error).toLowerCase().indexOf('not found') >= 0 ? 'missing' : 'failed'
  }

  function presenceOf(device, now) {
    if (device.online) return t('presenceOnline')
    var diff = Math.max(0, (now || Date.now()) - device.lastSeenAt)
    var minute = 60000, hour = 3600000, day = 86400000
    if (diff < minute) return t('justNow')
    var elapsed
    if (diff < hour) elapsed = t('minutes').replace('%d', String(Math.floor(diff / minute)))
    else if (diff < day) elapsed = t('hours').replace('%d', String(Math.floor(diff / hour)))
    else elapsed = t('days').replace('%d', String(Math.floor(diff / day)))
    return t('lastSeen').replace('%s', elapsed)
  }

  function render() {
    var status = state.status
    var ready = state.phase === 'ready'

    el('relay-addr').textContent = ready && status.proxyHost
      ? status.proxyHost + (status.proxyPort ? ':' + status.proxyPort : '')
      : ''

    var dot = el('relay-dot')
    dot.className = 'dot'
    var text = el('relay-text')
    var action = el('relay-action')
    action.hidden = true
    action.removeAttribute('data-action')

    if (state.phase === 'loading') {
      dot.className = 'dot ongoing'
      text.className = 'muted'
      text.textContent = t('loading')
    } else if (state.phase === 'missing') {
      dot.className = 'dot warning'
      text.className = 'warn-text'
      text.textContent = t('notInstalled')
    } else if (state.phase === 'failed') {
      dot.className = 'dot error'
      text.className = 'warn-text'
      text.textContent = state.error || t('failed')
    } else {
      dot.className = 'dot ' + (status.connected ? 'done' : 'warning')
      text.className = status.connected ? 'done-text' : 'warn-text'
      text.textContent = status.connected ? t('relayUp') : (status.disabled ? t('relayCut') : t('relayDown'))
      if (status.connected) {
        action.hidden = false
        action.className = 'danger'
        action.textContent = t('disconnect')
        action.setAttribute('data-action', 'disconnect')
      } else if (status.disabled) {
        action.hidden = false
        action.className = ''
        action.textContent = t('reconnect')
        action.setAttribute('data-action', 'connect')
      }
    }

    renderDevices(ready ? status : null)
    renderPairing(ready ? status : null)
  }

  function renderDevices(status) {
    var list = el('device-list')
    list.textContent = ''
    var devices = (status && status.devices) || []
    if (devices.length === 0) {
      var empty = document.createElement('div')
      empty.className = 'row muted'
      empty.textContent = status ? t('noDevices') : ''
      list.appendChild(empty)
      return
    }
    for (var i = 0; i < devices.length; i++) list.appendChild(deviceRow(devices[i], status.now))
  }

  function deviceRow(device, now) {
    var row = document.createElement('div')
    row.className = 'row'

    var label = document.createElement('div')
    label.className = 'label'
    var name = document.createElement('div')
    name.className = 'name'
    name.textContent = device.label
    name.title = device.label
    label.appendChild(name)

    var value = document.createElement('div')
    value.className = 'value'
    var status = document.createElement('span')
    status.className = 'status'
    var dot = document.createElement('span')
    dot.className = 'dot ' + (device.online ? 'done' : 'idle')
    var presence = document.createElement('span')
    presence.className = device.online ? 'done-text' : 'muted'
    presence.textContent = presenceOf(device, now)
    status.appendChild(dot)
    status.appendChild(presence)

    var rename = document.createElement('button')
    rename.textContent = t('rename')
    rename.onclick = function () { openRename(device) }
    var revoke = document.createElement('button')
    revoke.className = 'danger'
    revoke.textContent = t('revoke')
    revoke.onclick = function () { revokeDevice(device) }

    value.appendChild(status)
    value.appendChild(rename)
    value.appendChild(revoke)
    row.appendChild(label)
    row.appendChild(value)
    return row
  }

  function renderPairing(status) {
    var pairing = status && status.pairing
    var qr = el('qr')
    var actions = el('pair-actions')
    var gone = el('pair-gone')

    if (!pairing) {
      qr.hidden = true
      qr.removeAttribute('src')
      actions.hidden = true
      gone.hidden = false
      // Blank while a code is being minted, so the first paint after load is
      // not a flash of "used up"; the state is honest the moment it settles.
      el('pair-gone-text').textContent = !status
        ? (state.phase === 'failed' ? state.error : '')
        : (minting ? '' : t('codeGone'))
      el('new-code').hidden = !status || minting
      return
    }

    var src = '/mobile/qr?v=' + encodeURIComponent(pairing.expiresAt)
    if (qr.getAttribute('src') !== src) qr.setAttribute('src', src)
    qr.hidden = false
    actions.hidden = false
    gone.hidden = true

    var hint = el('pair-hint')
    hint.hidden = false
    hint.textContent = t('scanHint')

    var mac = el('pair-mac')
    mac.hidden = !status.deviceName
    mac.textContent = status.deviceName ? t('thisMac').replace('%s', status.deviceName) : ''

    var offline = el('pair-offline')
    offline.hidden = status.connected === true
    offline.textContent = t('offline')

    el('copy').textContent = copied ? t('copied') : t('copy')
  }

  function refresh() {
    return call('status').then(function (value) {
      state = { phase: 'ready', status: value, error: '' }
      render()
      if (!autoPaired) {
        autoPaired = true
        // A live code from earlier is reused; the page only mints when there is
        // nothing left to scan — the same courtesy the Mac settings screen
        // extends when it is reopened on an outstanding code.
        if (!value.pairing) return pair()
      }
    }).catch(function (error) {
      state = { phase: phaseFor(error), status: null, error: String(error.message || error) }
      render()
    })
  }

  function act(name, args) {
    return call(name, args).then(function () { return refresh() }).catch(function (error) {
      state = { phase: phaseFor(error), status: null, error: String(error.message || error) }
      render()
    })
  }

  function pair() {
    minting = true
    render()
    return call('pair').then(function () {
      minting = false
      return refresh()
    }).catch(function (error) {
      minting = false
      state = { phase: phaseFor(error), status: null, error: String(error.message || error) }
      render()
    })
  }
  function revokeDevice(device) { return act('revoke', { deviceId: device.deviceId }) }

  function openRename(device) {
    renaming = device
    el('rename-input').value = device.label
    el('rename').showModal()
  }

  el('rename').addEventListener('close', function () {
    var device = renaming
    renaming = null
    if (device === null) return
    if (el('rename').returnValue !== 'ok') return
    var label = el('rename-input').value.trim()
    if (label === '' || label === device.label) return
    act('rename', { deviceId: device.deviceId, label: label })
  })

  el('rename-cancel').onclick = function () { el('rename').close('cancel') }
  el('add').onclick = function () { pair() }
  el('new-code').onclick = function () { pair() }
  el('relay-action').onclick = function () {
    var action = el('relay-action').getAttribute('data-action')
    if (action === 'disconnect') act('disconnect')
    else if (action === 'connect') act('connect')
  }
  el('copy').onclick = function () {
    var pairing = state.status && state.status.pairing
    if (!pairing) return
    var done = function () {
      copied = true
      render()
      setTimeout(function () { copied = false; render() }, 1500)
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(pairing.url).then(done, done)
    } else {
      var field = document.createElement('textarea')
      field.value = pairing.url
      document.body.appendChild(field)
      field.select()
      try { document.execCommand('copy') } catch (ignored) {}
      document.body.removeChild(field)
      done()
    }
  }

  refresh()
  setInterval(refresh, 3000)
})()
</script>
</body>
</html>
`

export type { ControlDeps }
