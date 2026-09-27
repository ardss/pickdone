/**
 * Whole-card drag + double-click summon methods for TomatoFloatPage (structure-size ratchet):
 * pure relocation from the page component's `methods` — a plain methods object spread into the
 * component, so every method keeps the same `this` (the component instance) and behavior is
 * unchanged. The drag/`_dragging` instance fields live on the component exactly as before.
 */
/* Whole-card drag — left button only, excluding button area/menu/dialog; exclude first, then setPointerCapture
   (capture redirects subsequent clicks to the captured element, so buttons would never receive the click) */
export const tomatoFloatDragMethods = {
  startDrag (e) {
    if (this._dragging) this.stopDrag()
    if (e.button !== 0) return
    const t = e.target
    if (this._isCardInteractive(t)) return
    this._dragging = true
    this._dragPointerId = e.pointerId
    this._dragTarget = e.currentTarget
    if (this._dragTarget.setPointerCapture) {
      try { this._dragTarget.setPointerCapture(this._dragPointerId) } catch (err) { /* already released, etc. */ }
    }
    if (window.todoAPI) window.todoAPI.startTomatoFloatDrag()
    e.preventDefault()
  },
  /* Interactive areas on the card (buttons/menu/dialog) — one shared exclusion list for drag and double-click */
  _isCardInteractive (t) {
    return !!(t && t.closest && (t.closest('.tomato__corner') || t.closest('.tf-menu') || t.closest('.tomato__knob') || t.closest('.tomato__task-x') || t.closest('.tf-abandon') || t.closest('.tf-noise')))
  },
  /* Double-click empty card area = summon main window (added 2026-09-02): the float window is non-activatable (focusable:false),
     summoning goes through the main process showMainOrLock (covering lock-screen state redirect to the lock window,
     and all branches for rebuilding a destroyed main window) */
  onCardDblClick (e) {
    const t = e.target
    if (this._isCardInteractive(t)) return
    if (window.todoAPI && window.todoAPI.showMainFromFloat) window.todoAPI.showMainFromFloat()
  },
  stopDrag (e) {
    if (!this._dragging) return
    if (e && e.pointerId != null && e.pointerId !== this._dragPointerId) return
    this._dragging = false
    const t = this._dragTarget
    if (t && t.hasPointerCapture && t.hasPointerCapture(this._dragPointerId)) t.releasePointerCapture(this._dragPointerId)
    this._dragPointerId = null
    this._dragTarget = null
    if (window.todoAPI) window.todoAPI.stopTomatoFloatDrag()
  }
}
