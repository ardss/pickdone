// PickDone capture extension — the delivery primitive.
// Chrome-free pure ESM (deps injected): the MV3 service worker wires it to chrome.storage,
// unit tests stub fetch. Every delivery POST carries the X-PickDone-Key handshake header
// read from where the user pasted the access key; without a stored key the header is simply
// omitted and the desktop server answers 401 (fail closed) — the queue then backs off.

export const KEY_HEADER = 'X-PickDone-Key'
export { DEFAULT_CAPTURE_ENDPOINT as DEFAULT_DELIVER_ENDPOINT } from './endpoint-contract.js'

/**
 * @param {object} deps
 * @param {() => Promise<string>} deps.getEndpoint  the POST target URL
 * @param {() => Promise<string>} deps.getKey  the stored access key ('' when none)
 * @param {(url: string, init: object) => Promise<{ok: boolean, status: number}>} [deps.fetchImpl]
 */
export function createDeliver ({ getEndpoint, getKey, fetchImpl = (u, i) => fetch(u, i) }) {
  return async function deliver (payload) {
    const endpoint = await getEndpoint()
    const headers = { 'Content-Type': 'application/json' }
    const key = await getKey()
    if (key) headers[KEY_HEADER] = key
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    })
    if (!res.ok) throw new Error(`delivery failed: HTTP ${res.status}`)
  }
}
