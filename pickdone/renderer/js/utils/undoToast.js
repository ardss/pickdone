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

export function showUndoToast (messageFn, children, { type = 'success' } = {}) {
  const h = window.Vue.h
  const msg = messageFn({
    type,
    duration: 0, // timer is managed below so it can pause on hover
    showClose: true,
    message: h('span', children)
  })
  let timer = null
  const arm = () => {
    timer = setTimeout(() => {
      timer = null
      try { msg.close() } catch { /* already gone */ }
    }, UNDO_TOAST_MS)
  }
  arm()
  const controller = {
    pause: () => { if (timer) { clearTimeout(timer); timer = null } },
    resume: () => { if (!timer) arm() }
  }
  activeToasts.add(controller)
  // Detach this toast's controller when it closes (auto-dismiss, ✕ button, or programmatic close)
  const origClose = msg && typeof msg.close === 'function' ? msg.close.bind(msg) : null
  if (origClose) {
    msg.close = (...args) => {
      activeToasts.delete(controller)
      releaseKeyListeners()
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
  return msg
}
