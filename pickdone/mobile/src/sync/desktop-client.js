import { taskToDto, categoryToDto, episodeToDto } from './desktop-contract.js'

const encoders = { todos: taskToDto, categories: categoryToDto, work_episodes: episodeToDto }

// Transport is injected until the desktop lane publishes an authenticated HTTP route.
// It receives the AuthGate request shape, with a stable messageId for safe retries.
export function createDesktopSyncClient({ transport, deviceId, credentials, now = Date.now }) {
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