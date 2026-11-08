/* global chrome */
import { DEFAULT_CAPTURE_ENDPOINT, validateCaptureEndpoint } from './shared/endpoint-contract.js'
const key = document.getElementById('apiKey')
const endpoint = document.getElementById('endpoint')
const message = document.getElementById('endpointError')
function notify (text, bad = false) {
  message.textContent = text
  message.style.color = bad ? '#b42318' : ''
}
async function load () {
  const v = await chrome.storage.local.get(['pdCaptureKey', 'pdCaptureEndpoint'])
  key.value = v.pdCaptureKey || ''
  endpoint.value = v.pdCaptureEndpoint || DEFAULT_CAPTURE_ENDPOINT
  try { validateCaptureEndpoint(endpoint.value) } catch (e) { notify(e.message, true) }
}
key.addEventListener('change', async () => {
  await chrome.storage.local.set({ pdCaptureKey: key.value.trim() })
})
endpoint.addEventListener('change', async () => {
  try {
    const safe = validateCaptureEndpoint(endpoint.value)
    await chrome.storage.local.set({ pdCaptureEndpoint: safe })
    endpoint.value = safe
    notify('Saved. Retry queued captures with this local port.')
  } catch (e) { notify(e.message + ' Previous address kept.', true) }
})
function render (entries) {
  const queued = entries.filter(e => e.status === 'queued')
  const failed = entries.filter(e => e.status === 'failed')
  document.getElementById('summary').textContent =
    queued.length + ' queued · ' + failed.length + ' failed'
  const ul = document.getElementById('entries')
  ul.innerHTML = ''
  for (const e of entries.slice(-20).reverse()) {
    const li = document.createElement('li')
    li.textContent = (e.status === 'failed' ? 'failed: ' : 'queued: ') +
      (e.title || e.canonicalUri) + ' (' + e.attempts + ' tries)'
    ul.appendChild(li)
  }
}
async function refresh () {
  const r = await chrome.runtime.sendMessage({ type: 'pd-queue-list' })
  render(r?.entries || [])
}
document.getElementById('flush').addEventListener('click', async () => {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'pd-queue-flush', force: true })
    await refresh()
    notify(r?.pending || r?.failedIds?.length
      ? 'Still pending: check desktop port and access key, then retry.'
      : 'Delivered ' + (r?.sent?.length || 0) + ' capture(s).', Boolean(r?.pending || r?.failedIds?.length))
  } catch { notify('Desktop unavailable. Check loopback address and retry.', true) }
})
load()
refresh()
