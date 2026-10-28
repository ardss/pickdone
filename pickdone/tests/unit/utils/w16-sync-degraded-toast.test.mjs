/**
 * W16 P3 regression (2026-10-28) — the one-shot degraded-sync toast must not be burned while
 * EP (Element Plus) is not ready yet.
 *
 * Bug: `shown.add(key)` sat BEFORE the `EP.ElMessage` availability check, so an event arriving
 * during early boot marked the alarm as shown without ever showing it — the session's single
 * warning about oplog-append failures / flush quarantine was lost for good.
 *
 * Fix: shown.add runs only after the toast was actually created.
 * Run: node --test tests/unit/utils/w16-sync-degraded-toast.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installSyncEventToasts } from '../../../renderer/js/utils/syncDegradedToast.js'

const i18n = { global: { t: key => key } }

function harness () {
  const events = []
  const toasts = []
  const EP = { ElMessage: {} }
  const toast = opts => { toasts.push(opts); return { close () {} } }
  installSyncEventToasts({ onSyncEvent: fn => events.push(fn), i18n, toast, EP })
  const fire = evt => events.forEach(fn => fn(evt))
  return { toasts, fire }
}

test('W16: event before EP is ready must NOT consume the one-shot alarm', () => {
  const events = []
  const toasts = []
  let epReady = false
  const EP = { get ElMessage () { return epReady ? {} : null } }
  const toast = opts => { toasts.push(opts); return { close () {} } }
  installSyncEventToasts({ onSyncEvent: fn => events.push(fn), i18n, toast, EP })
  const fire = evt => events.forEach(fn => fn(evt))

  fire({ type: 'sync-degraded' }) // EP not ready: no toast, and the alarm must stay unconsumed
  assert.equal(toasts.length, 0)
  epReady = true
  fire({ type: 'sync-degraded' }) // pre-fix: suppressed here ("already shown"), user never warned
  assert.equal(toasts.length, 1, 'the degraded toast must fire once EP is available')
  fire({ type: 'sync-degraded' }) // one-shot per type: still capped afterwards
  assert.equal(toasts.length, 1)
})

test('W16: one toast per type still holds once actually shown', () => {
  const h = harness()
  h.fire({ type: 'oplog-append-failed' })
  h.fire({ type: 'flush-quarantined' }) // different key: its own one-shot
  assert.equal(h.toasts.length, 2)
  h.fire({ type: 'oplog-append-failed' })
  h.fire({ type: 'flush-quarantined' })
  assert.equal(h.toasts.length, 2)
})

test('W16: unrelated event types never toast (the conflict listener owns sync-conflict)', () => {
  const h = harness()
  h.fire({ type: 'something-else' })
  h.fire(null)
  assert.equal(h.toasts.length, 0)
})
