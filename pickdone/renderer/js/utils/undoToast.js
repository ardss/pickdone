/** Shared "undo" toast: 5s auto-dismiss with hover-pause + a manual close (✕) control.
 *  EP's Message does not pause its timer on hover, so the toast could vanish right as the
 *  user moves the mouse up to click "Undo" — we therefore own the timer (duration: 0) and
 *  pause/resume it via the toast element's mouse events. Falls back to plain auto-dismiss
 *  behavior if the element cannot be reached. */
export const UNDO_TOAST_MS = 5000

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
  try {
    const el = msg && msg.$el
    if (el) {
      el.addEventListener('mouseenter', () => { if (timer) { clearTimeout(timer); timer = null } })
      el.addEventListener('mouseleave', () => { if (!timer) arm() })
      // Keyboard/screen-reader parity (2026-09-12): hover alone could not pause the timer, so keyboard users
      // never got the full 5s to reach the Undo button. Any key held/pressed pauses; keyup resumes. The toast
      // is also announced politely via role="status" (live region). No visual change.
      el.setAttribute('role', 'status')
      const pause = () => { if (timer) { clearTimeout(timer); timer = null } }
      document.addEventListener('keydown', pause)
      document.addEventListener('keyup', () => { if (!timer) arm() })
    }
  } catch { /* hover-pause unavailable; toast just auto-dismisses */ }
  return msg
}
