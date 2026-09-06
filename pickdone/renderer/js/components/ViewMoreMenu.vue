<template>

  <div v-if="hasMenu" class="view-more-wrap">
    <button class="view-more-btn" :class="{on:open}" :title="$t('viewMore.title')" :aria-label="$t('viewMore.title')" aria-haspopup="menu"
            :aria-expanded="open ? 'true' : 'false'" @click.stop="toggle($event)">
      <svg viewBox="0 0 4 16" width="4" height="16" aria-hidden="true"><circle cx="2" cy="2" r="1.6"/><circle cx="2" cy="8" r="1.6"/><circle cx="2" cy="14" r="1.6"/></svg>
    </button>
    <div v-if="open" ref="pop" class="view-more-pop" role="menu" :aria-label="$t('viewMore.titleMenu')"
         @keydown="onMenuKeydown">
      <template v-for="(it,i) in items" :key="i">
        <div v-if="it.sep" class="vm-sep"></div>
        <div v-else class="vm-item" role="menuitemcheckbox" tabindex="0"
             :class="{active:isActive(it)}" :aria-checked="isActive(it)&&!it.info ? 'true' : 'false'"
             @click.stop="click(it)" @keydown.enter.prevent.stop="click(it)">
          {{it.label}} <b v-if="isActive(it)&&!it.info">✓</b>
        </div>
      </template>
    </div>
  </div>
</template>

<script lang="ts">
/**
 * Page ⋮ view settings menu -- aligned with the PureIconButton--more + custom-menu reference:
 * Menu items differ per route and all map to real settings/actions (no decoration)
 */

const SORT_VALUE = {
  'viewMore.sortCustom': 'custom',
  'viewMore.sortByCreated': 'created',
  'viewMore.sortByDifficulty': 'difficulty'
}

const MENUS = {
  'todo-list-today': [
    { labelKey: 'viewMore.sortCustom', group: 'sort' },
    { labelKey: 'viewMore.sortByCreated', group: 'sort' },
    { labelKey: 'viewMore.sortByDifficulty', group: 'sort' },
    { sep: true },
    { labelKey: 'viewMore.showCompleted', toggle: 'showComplete' },
    { labelKey: 'viewMore.showNoDate', toggle: 'showNoDate' },
    { labelKey: 'viewMore.checkFollowColor', toggle: 'isCompleteCheckboxColorFollow' },
    { sep: true },
  ],
  // [Removed todo-list-recent]: the view does not exist in the route table so this menu block never matches (dead key, cleaned up along with views/registry.js consolidation)
  'todo-list-category': [
    { labelKey: 'viewMore.showNoDate', toggle: 'showNoDate' },
    { labelKey: 'viewMore.showCompleted', toggle: 'showComplete' },
    { labelKey: 'viewMore.checkFollowColor', toggle: 'isCompleteCheckboxColorFollow' }
  ],
  'todo-list-calendar': [
    { labelKey: 'statsE.ViewMoreMenu.monthViewMenuItem', info: true },
    { sep: true },
    { labelKey: 'statsE.ViewMoreMenu.showCompletedMenuItem', toggle: 'isShowCalendarCompleted' },
    { labelKey: 'statsE.ViewMoreMenu.privacyBlurMenuItem', toggle: 'isShowCalendarPrivacyMode' },
    { labelKey: 'statsE.ViewMoreMenu.holidayBadgesMenuItem', toggle: 'showHolidayMarkers' }
  ]
  // The todo box has no menu: sorting/order/categories are already provided by the header toolbar dropdown, another copy in the menu would be pure duplication
}

export default {
  name: 'ViewMoreMenu',
  data () { return { open: false, items: [] } },
  computed: {
    routeName () { return this.$route.name },
    // When this page has no menu items, do not render the button at all (e.g. the todo box: the toolbar already has all view controls)
    hasMenu () { return !!(MENUS[this.routeName] && MENUS[this.routeName].length) }
  },
  methods: {
    toggle (e) {
      if (this.open) { this.open = false; return }
      this.items = (MENUS[this.routeName] || []).map(it => ({ ...it, label: it.labelKey ? this.$t(it.labelKey) : it.label }))
      if (!this.items.length) { this.$message.info(this.$t('viewMore.title') + ' · N/A'); return }
      this.open = true
      this._x = e.clientX; this._y = e.clientY
      this.$nextTick(() => {
        const el = this.$refs.pop
        if (el) {
          el.style.left = Math.min(e.clientX - 190, window.innerWidth - 220) + 'px'
          el.style.top = (e.clientY + 8) + 'px'
          const first = el.querySelector('.vm-item[tabindex="0"]')
          if (first) first.focus()
        }
      })
    },
    onMenuKeydown (e) {
      const items = [...this.$el.querySelectorAll('.vm-item[tabindex="0"]')]
      if (!items.length) return
      const idx = items.indexOf(document.activeElement)
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        items[(idx + 1) % items.length].focus()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        items[(idx - 1 + items.length) % items.length].focus()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.open = false
        const btn = this.$el.querySelector('.view-more-btn')
        if (btn) btn.focus()
      }
    },
    isActive (it) {
      const st = this.$store.state.settings
      if (it.toggle) return !!st[it.toggle]
      if (it.group === 'sort') return st.sortMode === SORT_VALUE[it.labelKey]
      return false
    },
    click (it) {
      if (it.info) { this.$message.info(it.label); return }
      if (it.toggle) {
        this.$store.commit('settings/updateSettings', { [it.toggle]: !this.$store.state.settings[it.toggle] })
        this.$store.dispatch('todo/computeViews')
      } else if (it.group === 'sort') {
        this.$store.commit('settings/updateSettings', { sortMode: SORT_VALUE[it.labelKey] })
        this.$store.dispatch('todo/computeViews')
      }
      this.open = false
    },
    onDocDown (e) {
      if (this.open && !e.target.closest('.view-more-pop') && !e.target.closest('.view-more-btn')) this.open = false
    }
  },
  mounted () { document.addEventListener('mousedown', this.onDocDown, true) },
  beforeUnmount () { document.removeEventListener('mousedown', this.onDocDown, true) },

}
</script>
