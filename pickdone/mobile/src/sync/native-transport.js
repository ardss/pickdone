import { Capacitor, CapacitorHttp } from '@capacitor/core'

// The browser/PWA must keep fetch() and its browser Origin/CORS enforcement.
// The Capacitor Android/iOS runtime uses native HTTP, avoiding WebView
// mixed-content blocking when an explicitly paired local desktop uses HTTP.
// Never follow redirects: a scoped bearer token must never leak to a new host.
export function createBridgeFetch ({
  isNative = () => Capacitor.isNativePlatform(),
  nativeRequest = options => CapacitorHttp.request(options),
  webFetch = (url, options) => fetch(url, options)
} = {}) {
  return async function bridgeFetch (url, options = {}) {
    if (!isNative()) return webFetch(url, options)

    const data = typeof options.body === 'string'
      ? JSON.parse(options.body)
      : options.body
    const result = await nativeRequest({
      url,
      method: options.method || 'GET',
      headers: options.headers || {},
      ...(data !== undefined ? { data } : {}),
      connectTimeout: 12000,
      readTimeout: 15000,
      disableRedirects: true
    })

    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => {
        if (typeof result.data === 'string') {
          try { return JSON.parse(result.data) } catch { return {} }
        }
        return result.data || {}
      }
    }
  }
}

export const bridgeFetch = createBridgeFetch()
