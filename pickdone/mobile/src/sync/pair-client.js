import { taskToDto, categoryToDto, episodeToDto } from './pair-contract.js'
import { bridgeFetch } from './native-transport.js'

const encoders = { todos: taskToDto, categories: categoryToDto, work_episodes: episodeToDto }

// Transport is injected in unit tests; the HTTP session below is the real door against the
// desktop bridge routes (df9c4aae). Both feed the same request shape: AuthGate envelope with
// a stable messageId per logical request, so a retry after a flaky link can never double-apply.
export function createPairSyncClient({ transport, deviceId, credentials, now = Date.now }) {
  if (typeof transport !== 'function') throw new TypeError('transport required')
  if (!deviceId) throw new TypeError('deviceId required')
  function request(op, payload, messageId = crypto.randomUUID(), entity) {
    if (!credentials?.token || !credentials?.csrfNonce || !credentials?.expiresAt) throw new Error('Pairing credentials required')
    if (credentials.expiresAt <= now()) throw new Error('Pairing token expired')
    if (op === 'sync.push' && credentials.scope !== 'WRITE') throw new Error('WRITE scope required')
    if (!messageId) throw new TypeError('messageId required')
    return transport({ op, bearer: credentials.token, csrfHeader: credentials.csrfNonce, deviceId, messageId, payload, entity })
  }
  return {
    pull: (messageId) => request('sync.pull', undefined, messageId),
    push: (entity, row, messageId) => {
      if (!Object.hasOwn(encoders, entity)) throw new TypeError('unsupported entity')
      return request('sync.push', encoders[entity](row), messageId, entity)
    }
  }
}

// ---- real HTTP session against the desktop cross-platform bridge (Lane A df9c4aae) ----
//   POST /pair   {challengeId, code, deviceId} -> {token, expiresAt, scope, csrfHeader}
//   POST /pull   {deviceId, messageId, payload:{}}                 (READ scope)
//   POST /push   {deviceId, messageId, payload:{ops:[...]}}        (WRITE scope)
// Headers: Authorization bearer token + X-PickDone-Request CSRF nonce issued at pairing.
// The endpoint is whatever address the desktop pairing surface displays — loopback on the
// same machine, the controlled-LAN pairing address for another device. Never guessed here.

export const PAIR_ROUTES = Object.freeze({ pair: '/crossplatform/pair', pull: '/crossplatform/pull', push: '/crossplatform/push' })

export async function pairDesktop({ baseUrl, challengeId, code, deviceId, fetchImpl = bridgeFetch }) {
  if (!baseUrl) throw new TypeError('baseUrl required')
  if (!challengeId || !deviceId || code == null) throw new TypeError('challengeId, code and deviceId required')
  const res = await fetchImpl(baseUrl + PAIR_ROUTES.pair, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId, code: String(code), deviceId })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.ok) throw new Error('pairing failed: ' + (body.error || ('HTTP ' + res.status)))
  return { token: body.token, csrfNonce: body.csrfHeader, expiresAt: Number(body.expiresAt || 0), scope: body.scope, deviceId }
}

export function createBridgeSession({ baseUrl, credentials, deviceId, fetchImpl = bridgeFetch, now = Date.now, uuid = () => crypto.randomUUID() }) {
  if (!baseUrl) throw new TypeError('baseUrl required')
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl required')
  if (!deviceId) throw new TypeError('deviceId required')

  async function call(route, payload, scopeNeeded) {
    if (!credentials?.token || !credentials?.csrfNonce || !credentials?.expiresAt) throw new Error('Pairing credentials required — pair with the desktop first')
    if (credentials.expiresAt <= now()) throw new Error('Pairing token expired — pair again with the desktop')
    if (scopeNeeded === 'WRITE' && credentials.scope !== 'WRITE') throw new Error('WRITE scope required — request a write-scoped pairing on the desktop')
    const messageId = uuid()
    const res = await fetchImpl(baseUrl + route, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + credentials.token,
        'X-PickDone-Request': credentials.csrfNonce
      },
      body: JSON.stringify({ deviceId, messageId, payload })
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.ok) {
      const err = new Error(body.error || ('HTTP ' + res.status))
      err.code = body.error
      err.status = res.status
      if (body.retryAfterMs != null) err.retryAfterMs = body.retryAfterMs
      throw err
    }
    return body.result
  }

  return {
    /** -> {entities:{todos,categories,work_episodes,...}, pulledAt} */
    pull: () => call(PAIR_ROUTES.pull, {}, 'READ'),
    /** ops: [{entity, rows:[dto]}] (1..500 rows per op) -> {results:[{entity, outcomes}]} */
    push: ops => call(PAIR_ROUTES.push, { ops }, 'WRITE')
  }
}
