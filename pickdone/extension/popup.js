/* global chrome */
import { DEFAULT_CAPTURE_ENDPOINT, validateCaptureEndpoint } from './shared/endpoint-contract.js'
import { probeDoor } from './shared/door-probe.js'
const key = document.getElementById('apiKey')
const endpoint = document.getElementById('endpoint')
const message = document.getElementById('endpointError')
const connState = document.getElementById('connState')

// J3 sentinel (qa-r7 P1): the 7789 port conflict must be USER-VISIBLE with retry guidance.
// The probe proves the endpoint answers as the REAL PickDone door (X-PickDone-Door /
// X-PickDone-Port identity headers) and classifies unreachable / foreign-process /
// port-moved states. Rendered on popup open and via the explicit check button.
async function renderConnState () {
  const r = await probeDoor(endpoint.value.trim() || DEFAULT_CAPTURE_ENDPOINT)
  connState.className = r.state === 'ok' ? 'good' : 'bad'
  connState.textContent = r.message
  return r
}
document.getElementById('checkConn').addEventListener('click', renderConnState)
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
load().then(renderConnState)
refresh()
