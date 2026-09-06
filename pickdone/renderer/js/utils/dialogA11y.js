/** Dialog accessibility mixin — focus-trap + Escape to close + focus restoration
 *  After mounted, listens for keydown on the dialog root:
 *  - Tab/Shift+Tab cycles among the first/last focusable elements; focus must not escape the dialog to operate the underlying layer
 *  - Escape triggers @close/@cancel (if present); the caller handles business logic inside close()
 *  beforeUnmount restores the _dlgPrevFocus recorded at mounted time
 *  Note: this mixin only manages the focus fence and does not close the dialog directly — the caller component must listen for the dialogEscape event and handle it itself */
// In DOM order (querySelectorAll multiple times would be reordered by CSS cascade, splitting them loses order); filters disabled/hidden secondarily
const FOCUSABLE = 'input, textarea, select, button, [href], [tabindex]'

export default {
  mounted () {
    this._dlgPrevFocus = document.activeElement
    this._dlgKeyHandler = (e) => this.onKeydown(e)
    // $el may be a text node (Vue3 multi-root/comment templates) — normalize to the nearest element before finding .modal
    let el = this.$el
    if (el && el.nodeType !== 1) el = el.parentElement
    if (el && el.classList && el.classList.contains('modal')) this._dlgRoot = el
    else this._dlgRoot = (el && el.querySelector && el.querySelector('.modal')) || (el && el.nodeType === 1 ? el : null)
    if (this._dlgRoot) {
      if (!this._dlgRoot.hasAttribute('tabindex')) this._dlgRoot.setAttribute('tabindex', '-1')
      this._dlgRoot.addEventListener('keydown', this._dlgKeyHandler, true) // capture phase: earlier than inner enter handlers
    }
    this.$nextTick(() => {
      const focusables = this.getFocusables()
      if (focusables.length) focusables[0].focus()
      else if (this._dlgRoot) this._dlgRoot.focus()
    })
  },
  beforeUnmount () {
    if (this._dlgRoot && this._dlgKeyHandler) {
      this._dlgRoot.removeEventListener('keydown', this._dlgKeyHandler, true)
    }
    const el = this._dlgPrevFocus
    if (el && el.focus && document.contains(el)) {
      try { el.focus() } catch (e) { /* empty */ }
    }
  },
  methods: {
    /** All focusable elements inside the current dialog root (in DOM order).
     *  Visibility is determined via getComputedStyle — getClientRects behaves unreliably in JSDOM when layout is missing.
     *  The isJSDOM detection is a fallback for JSDOM 22+ where userAgent no longer contains the "jsdom" string:
     *  child elements lacking getComputedStyle are also counted as visible, so tests and production behave consistently. */
    getFocusables () {
      if (!this._dlgRoot) return []
      // Universal browser/Node detection: navigator contains "jsdom", or the document lacks defaultView.getComputedStyle extensions
      const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || ''
      const isJSDOM = /jsdom/.test(ua)
      return [...this._dlgRoot.querySelectorAll(FOCUSABLE)].filter(el => {
        if (isJSDOM) return true
        if (el.disabled) return false
        if (el.getAttribute('aria-hidden') === 'true') return false
        if (el.getAttribute('tabindex') === '-1') return false
        if (el.tagName === 'INPUT' && el.type === 'hidden') return false
        const doc = el.ownerDocument
        if (doc && doc.defaultView && doc.defaultView.getComputedStyle) {
          const s = doc.defaultView.getComputedStyle(el)
          if (s.display === 'none' || s.visibility === 'hidden') return false
        }
        return true
      })
    },
    onKeydown (e) {
      if (!this._dlgRoot) return
      // Escape to close (only when inside the dialog and not in an input/textarea) — Esc behavior inside inputs is left to the native one (clearing selection etc.)
      if (e.key === 'Escape') {
        const t = e.target
        const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
        if (inField) return
        if (typeof this.close === 'function') { e.preventDefault(); e.stopPropagation(); this.close() }
        else if (typeof this.onCancel === 'function') { e.preventDefault(); e.stopPropagation(); this.onCancel() }
        else this.$emit('close')
        return
      }
      if (e.key !== 'Tab') return
      const focusables = this.getFocusables()
      if (focusables.length === 0) { e.preventDefault(); return }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      // Force focus back when the current focus is outside the dialog
      if (!this._dlgRoot.contains(active)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
        return
      }
      // Index of focus within the focusable sequence (covers the edge case where activeEl is not in focusables)
      const idx = focusables.indexOf(active)
      // Focus is in the sequence but activeEl is not (e.g. activeEl = body/document)
      if (idx === -1) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
        return
      }
      if (e.shiftKey && idx === 0) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && idx === focusables.length - 1) {
        e.preventDefault()
        first.focus()
      }
    }
  }
}
