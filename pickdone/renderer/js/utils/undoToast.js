/** Shared "undo" toast: 5s auto-dismiss with hover-pause + a manual close (✕) control.
 *  EP's Message does not pause its timer on hover, so the toast could vanish right as the
 *  user moves the mouse up to click "Undo" — we therefore own the timer (duration: 0) and
 *  pause/resume it via the toast element's mouse events. Falls back to plain auto-dismiss
 *  behavior if the element cannot be reached. */
export const UNDO_TOAST_MS = 5000

/* H6 fix (2026-09-12): the keydown/keyup document listeners used to be installed per-toast and
 * never removed — one toast = two permanent document listeners, so they accumulated linearly
 * and stale listeners kept re-arming timers for already-closed messages. They are now a single
 * ref-counted pair: installed on the first toast, removed when the last toast closes. Each
 * toast registers a small controller; the shared handlers fan out to live toasts only. */
const activeToasts = new Set()
let keydownHandler = null
let keyupHandler = null

function installKeyListeners () {
  if (keydownHandler) return
  keydownHandler = () => activeToasts.forEach(t => t.pause())
  keyupHandler = () => activeToasts.forEach(t => t.resume())
  document.addEventListener('keydown', keydownHandler)
  document.addEventListener('keyup', keyupHandler)
}

function releaseKeyListeners () {
  if (activeToasts.size || !keydownHandler) return
  try {
    document.removeEventListener('keydown', keydownHandler)
    document.removeEventListener('keyup', keyupHandler)
  } catch { /* noop */ }
  keydownHandler = keyupHandler = null
}

export function showUndoToast (messageFn, children, { type = 'success', onDismiss } = {}) {
  const h = window.Vue.h
  let timer = null
  const arm = () => {
    timer = setTimeout(() => {
      timer = null
      try { msg.close() } catch { /* already gone */ }
    }, UNDO_TOAST_MS)
  }
  const controller = {
    pause: () => { if (timer) { clearTimeout(timer); timer = null } },
    resume: () => { if (!timer) arm() }
  }
  /** Single idempotent unregister path: patched close (auto-dismiss / ✕ / programmatic) AND the
   *  Element Plus Message onClose callback both land here. onClose matters because a route change
   *  unmounts the whole tree: EP destroys the Message without anyone calling msg.close(), which used
   *  to leave the controller in activeToasts forever and leaked the shared keydown/keyup listeners. */
  const unregister = () => {
    if (controller.pause) controller.pause = null // mark dead so late hover events can't re-arm
    if (activeToasts.delete(controller)) releaseKeyListeners()
    // onDismiss (2026-09-25): fires on EVERY close path (auto-dismiss timer / hover-paused expiry /
    // ✕ / EP onClose after route change). Callers like EditPanel.removeFile defer destructive
    // follow-ups (physical file deletion) to here instead of a fixed setTimeout, so a hover that
    // pauses the timer past their deadline can no longer race the undo.
    if (onDismiss) { try { onDismiss() } catch { /* dismiss hook must not break teardown */ } }
  }
  // Registered before messageFn so even an immediate onClose can't miss it
  activeToasts.add(controller)
  const msg = messageFn({
    type,
    duration: 0, // timer is managed below so it can pause on hover
    showClose: true,
    message: h('span', children),
    onClose: unregister
  })
  // Patch close as well: plain-object message mocks and older EP builds may not honor onClose
  const origClose = msg && typeof msg.close === 'function' ? msg.close.bind(msg) : null
  if (origClose) {
    msg.close = (...args) => {
      unregister()
      return origClose(...args)
    }
  }
  try {
    const el = msg && msg.$el
    if (el) {
      el.addEventListener('mouseenter', () => { if (timer) { clearTimeout(timer); timer = null } })
      el.addEventListener('mouseleave', () => { if (!timer) arm() })
      // Keyboard/screen-reader parity (2026-09-12): hover alone could not pause the timer, so keyboard users
      // never got the full 5s to reach the Undo button. Any key held/pressed pauses; keyup resumes. The toast
      // is also announced politely via role="status" (live region). No visual change.
      el.setAttribute('role', 'status')
      installKeyListeners()
    }
  } catch { /* hover-pause unavailable; toast just auto-dismisses */ }
  arm() // start the owned 5s timer once the message exists (arm's close needs msg)
  return msg
}
