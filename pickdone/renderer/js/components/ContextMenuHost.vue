<template>

  <transition name="pop">
    <div v-if="m.visible" class="ctx-menu" role="menu" :style="{left:pos.x+'px', top:pos.y+'px'}"
         @keydown.esc.stop="$store.commit('ui/closeMenu')" @keydown.down="onKeydown" @keydown.up="onKeydown">
      <template v-for="(it,i) in m.items" :key="i">
        <div v-if="it.sep" class="ctx-item sep" role="separator"></div>
        <div v-else class="ctx-item" :class="{danger:it.danger}"
             role="menuitem" tabindex="0"
             @click.stop="exec(it)"
             @keydown="onItemKey(it, $event)">
          <app-icon v-if="it.icon" :name="it.icon" :size="13" class="ctx-ico"/>{{it.label}}</div>
      </template>
    </div>
  </transition>
</template>

<script lang="ts">
/** Global context menu host */
import { roleButtonActivate } from '../utils/roleButtonKey.js' // [maint/d23 FIX-3b a11y sweep] Space joins Enter

export default {
  name: 'ContextMenuHost',
  components: { AppIcon: window.AppIcon },
  data: () => ({ pos: { x: 0, y: 0 } }),
  computed: {
    m () { return this.$store.state.ui.contextMenu }
  },
  watch: {
    // [d21-A3] watch the menu object by IDENTITY, not just 'm.visible': ui/openMenu REPLACES the
    // object wholesale, so a reopen-while-open (visible stays true) used to skip re-clamping,
    // refocusing, and left a stale _lastTrigger. Identity change fires on replacement; the
    // 'm.visible' watcher below still owns the close path (closeMenu mutates visible in place).
    m (v) { if (v && v.visible) this.onMenuOpen() },
    'm.visible' (v) {
      if (v) {
        this.onMenuOpen()
      } else {
        this.restoreFocus()
      }
    }
  },
  mounted () {
    this._onDown = e => {
      if (this.m.visible && !e.target.closest('.ctx-menu')) this.$store.commit('ui/closeMenu')
    }
    this._onBlur = () => this.$store.commit('ui/closeMenu')
    window.addEventListener('mousedown', this._onDown, true)
    window.addEventListener('blur', this._onBlur)
    // After the list scrolls, a menu pinned to the original screen coordinates would point at the wrong item: close immediately on any scroll
    this._onScroll = () => { if (this.m.visible) this.$store.commit('ui/closeMenu') }
    window.addEventListener('scroll', this._onScroll, true)
    window.addEventListener('wheel', this._onScroll, { capture: true, passive: true })
  },
  beforeUnmount () {
    window.removeEventListener('mousedown', this._onDown, true)
    window.removeEventListener('blur', this._onBlur)
    window.removeEventListener('scroll', this._onScroll, true)
    window.removeEventListener('wheel', this._onScroll, { capture: true, passive: true } as any)
  },
  methods: {
    // [maint/d23 FIX-3b a11y sweep] ARIA menuitem pattern: BOTH Enter and Space activate
    // (Space was dead before and just sat on a non-interactive div). App-wide contract
    // handler from utils/roleButtonKey.js.
    onItemKey (it, e) {
      roleButtonActivate(() => this.exec(it), { stop: true }).call(this, e)
    },
    // [d21-A3] shared open path (used by both the m-identity watcher and the 'm.visible' watcher):
    // record the trigger, place at raw coords, then clamp into the viewport and focus the first item
    onMenuOpen () {
      // Focus restore (a11y): remember the trigger so keyboard focus can return here on close
      const ae = document.activeElement as HTMLElement | null
      this._lastTrigger = ae && typeof ae.focus === 'function' ? ae : null
      // Place at the original coordinates first, then clamp back into the viewport once the menu's real size is measured: otherwise menus near the bottom/right edge would overflow the screen and become unselectable
      this.pos = { x: this.m.x, y: this.m.y }
      this.$nextTick(() => {
        const el = this.$el && this.$el.querySelector ? this.$el.querySelector('.ctx-menu') || this.$el : null
        if (!el) return
        const w = el.offsetWidth
        const h = el.offsetHeight
        const x = Math.max(8, Math.min(this.m.x, window.innerWidth - w - 8))
        const y = Math.max(8, Math.min(this.m.y, window.innerHeight - h - 8))
        this.pos = { x, y }
        const first = el.querySelector('.ctx-item[tabindex="0"]')
        if (first) first.focus()
      })
    },
    // [d21-A5] a throwing menu handler must not leave the menu wedged open: close runs in finally
    exec (it) {
      try { it.fn && it.fn() } finally { this.$store.commit('ui/closeMenu') }
    },
    // Return keyboard focus to the element that opened the menu (no-op if it was removed from the DOM)
    restoreFocus () {
      const t = this._lastTrigger
      this._lastTrigger = null
      if (t && document.contains(t)) {
        try { t.focus() } catch (e) { /* element may be unfocusable */ }
      }
    },
    onKeydown (e) {
      // [maint/d23 FIX-3b a11y sweep] role-pin the roving list: separators carry .ctx-item too
      // (class .sep), so select real menuitems only — a separator must never take roving focus
      const items = [...this.$el.querySelectorAll('.ctx-item[role="menuitem"]')]
      const idx = items.indexOf(document.activeElement)
      // D14-A10: Tab used to walk focus out of the open menu — intercept it as roving (Shift
      // reverses), and add Home/End jumps, matching the dialogA11y keyboard contract elsewhere
      if (e.key === 'Tab') {
        e.preventDefault()
        if (!items.length) return
        if (idx < 0) { items[0].focus(); return }
        const next = e.shiftKey
          ? items[(idx - 1 + items.length) % items.length]
          : items[(idx + 1) % items.length]
        next.focus()
      } else if (e.key === 'Home') {
        e.preventDefault()
        if (items.length) items[0].focus()
      } else if (e.key === 'End') {
        e.preventDefault()
        if (items.length) items[items.length - 1].focus()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (idx >= 0) items[(idx + 1) % items.length].focus()
        else if (items.length) items[0].focus()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (idx >= 0) items[(idx - 1 + items.length) % items.length].focus()
        else if (items.length) items[items.length - 1].focus()
      }
    }
  },

}
</script>
<style>.ctx-menu { transform-origin: top left; }
</style>
