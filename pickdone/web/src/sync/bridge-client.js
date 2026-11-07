// Real HTTP transport for the desktop cross-platform bridge (Lane A contract, df9c4aae):
//   POST /crossplatform/pair  {challengeId, code, deviceId} -> {token, expiresAt, scope, csrfHeader}
//   POST /crossplatform/pull  {deviceId, messageId, payload:{}}            (READ scope)
//   POST /crossplatform/push  {deviceId, messageId, payload:{ops:[...]}}   (WRITE scope)
// Every gated request carries Authorization: Bearer <token>, the X-PickDone-Request CSRF
// header (the session nonce issued at pairing) and an Origin header (the desktop AuthGate
// allowlists browser origins). The browser adds Origin automatically; tests inject it via
// the fetch stub. messageId is a fresh uuid per logical request so retries stay idempotent.

export const PAIR_ROUTES = { pair: '/crossplatform/pair', pull: '/crossplatform/pull', push: '/crossplatform/push' }

function jsonHeaders(extra) {
  return { 'Content-Type': 'application/json', ...extra }
}

/** One-shot pairing: exchange the one-time challenge issued by the desktop for scoped credentials. */
export async function pairDesktop({ baseUrl, challengeId, code, deviceId, fetchImpl = fetch }) {
  if (!baseUrl) throw new TypeError('baseUrl required')
  if (!challengeId || !deviceId || code == null) throw new TypeError('challengeId, code and deviceId required')
  const res = await fetchImpl(baseUrl + PAIR_ROUTES.pair, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ challengeId, code: String(code), deviceId })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.ok) {
    throw new Error('pairing failed: ' + (body.error || ('HTTP ' + res.status)))
  }
  return {
    token: body.token,
    csrf: body.csrfHeader,
    expiresAt: Number(body.expiresAt || 0),
    scope: body.scope,
    deviceId
  }
}

export function createBridgeClient({ baseUrl, credentials, deviceId, fetchImpl = fetch, now = Date.now, uuid = () => crypto.randomUUID() }) {
  if (!baseUrl) throw new TypeError('baseUrl required')
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl required')
  if (!deviceId) throw new TypeError('deviceId required')

  function assertCredentials() {
    if (!credentials?.token || !credentials?.csrf || !credentials?.expiresAt) throw new Error('Pairing credentials required — pair with the desktop first')
    if (credentials.expiresAt <= now()) throw new Error('Pairing token expired — pair again with the desktop')
  }

  async function call(route, payload, scopeNeeded) {
    assertCredentials()
    if (scopeNeeded === 'WRITE' && credentials.scope !== 'WRITE') throw new Error('WRITE scope required — ask the desktop for a write-scoped pairing')
    const messageId = uuid()
    const res = await fetchImpl(baseUrl + route, {
      method: 'POST',
      headers: jsonHeaders({
        Authorization: 'Bearer ' + credentials.token,
        'X-PickDone-Request': credentials.csrf
      }),
      body: JSON.stringify({ deviceId, messageId, payload })
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.ok) {
      const err = new Error(body.error || ('HTTP ' + res.status))
      err.code = body.error
      if (body.retryAfterMs != null) err.retryAfterMs = body.retryAfterMs
      err.status = res.status
      throw err
    }
    return body.result
  }

  return {
    /** Full desktop snapshot -> {entities:{todos,categories,work_episodes,...}, pulledAt} */
    pull: () => call(PAIR_ROUTES.pull, {}, 'READ'),
    /** ops: [{entity, rows:[dto]}] (1..500 rows per op) -> {results:[{entity, outcomes}]} */
    push: ops => call(PAIR_ROUTES.push, { ops }, 'WRITE')
  }
}
