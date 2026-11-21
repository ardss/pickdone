// PickDone capture endpoint contract. Only explicit local loopback ports are trusted.
export const CAPTURE_HOST = '127.0.0.1'
export const CAPTURE_PORT = 7789
export const CAPTURE_PATH = '/capture'
export const DEFAULT_CAPTURE_ENDPOINT = 'http://' + CAPTURE_HOST + ':' + CAPTURE_PORT + CAPTURE_PATH

export function validateCaptureEndpoint (value) {
  let url
  try { url = new URL(String(value || '').trim()) } catch {
    throw new Error('Enter a valid loopback capture URL')
  }
  const host = url.hostname.toLowerCase()
  const port = Number(url.port)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(host) ||
      !/^\d+$/.test(url.port) || port < 1 || port > 65535 ||
      url.pathname !== CAPTURE_PATH || url.search || url.hash || url.username || url.password) {
    throw new Error('Only http://127.0.0.1:<port>/capture or localhost is allowed')
  }
  return 'http://' + host + ':' + port + CAPTURE_PATH
}
