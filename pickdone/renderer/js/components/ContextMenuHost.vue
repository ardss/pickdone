<template>

  <transition name="pop">
    <div v-if="m.visible" class="ctx-menu" role="menu" :style="{left:pos.x+'px', top:pos.y+'px'}"
         @keydown.esc="$store.commit('ui/closeMenu')" @keydown.down="onKeydown" @keydown.up="onKeydown">
      <template v-for="(it,i) in m.items" :key="i">
        <div v-if="it.sep" class="ctx-item sep" role="separator" aria-disabled="true"></div>
        <div v-else class="ctx-item" :class="{danger:it.danger}"
             role="menuitem" tabindex="0"
             @click.stop="exec(it)"
             @keydown.enter.prevent="exec(it)">
          <app-icon v-if="it.icon" :name="it.icon" :size="13" class="ctx-ico"/>{{it.label}}</div>
      </template>
    </div>
  </transition>
</template>

<script lang="ts">
/** Global context menu host */
export default {
  name: 'ContextMenuHost',
  components: { AppIcon: window.AppIcon },
  data: () => ({ pos: { x: 0, y: 0 } }),
  computed: {
    m () { return this.$store.state.ui.contextMenu }
  },
  watch: {
    'm.visible' (v) {
      if (v) {
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
    exec (it) { it.fn && it.fn(); this.$store.commit('ui/closeMenu') },
    // Return keyboard focus to the element that opened the menu (no-op if it was removed from the DOM)
    restoreFocus () {
      const t = this._lastTrigger
      this._lastTrigger = null
      if (t && document.contains(t)) {
        try { t.focus() } catch (e) { /* element may be unfocusable */ }
      }
    },
    onKeydown (e) {
      const items = [...this.$el.querySelectorAll('.ctx-item[tabindex="0"]')]
      const idx = items.indexOf(document.activeElement)
      if (e.key === 'ArrowDown') {
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
