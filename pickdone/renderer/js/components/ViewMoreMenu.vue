<template>

  <div v-if="hasMenu" class="view-more-wrap">
    <button class="view-more-btn" :class="{on:open}" :title="$t('viewMore.title')" :aria-label="$t('viewMore.title')" aria-haspopup="menu"
            :aria-expanded="open ? 'true' : 'false'" @click.stop="toggle($event)">
      <svg viewBox="0 0 4 16" width="4" height="16" aria-hidden="true"><circle cx="2" cy="2" r="1.6"/><circle cx="2" cy="8" r="1.6"/><circle cx="2" cy="14" r="1.6"/></svg>
    </button>
    <div v-if="open" ref="pop" class="view-more-pop" role="menu" :aria-label="$t('viewMore.titleMenu')"
         @keydown="onMenuKeydown">
      <!-- [D17-DOM4] mutually-exclusive sort entries are menuitemradio inside a role=group (was
           menuitemcheckbox, which promises independent check state). [fix 2026-10-09] Space
           activation is owned by main.js's document capture handler (roles allowlisted in
           maint/d26 contract; in-file keydown helpers are Enter-only since D27) — these roles
           were added to that allowlist so Space still activates them. Non-sort toggles stay
           menuitemcheckbox. -->
      <div v-if="sortItems.length" role="group" :aria-label="$t('viewMore.sortGroup')">
        <div v-for="(it,i) in sortItems" :key="'s'+i" class="vm-item" role="menuitemradio" tabindex="0"
             :class="{active:isActive(it)}" :aria-checked="isActive(it)&&!it.info ? 'true' : 'false'"
             @click.stop="click(it)" @keydown="onItemKey(it, $event)">
          {{it.label}} <b v-if="isActive(it)&&!it.info">✓</b>
        </div>
      </div>
      <template v-for="(it,i) in otherItems" :key="i">
        <div v-if="it.sep" class="vm-sep"></div>
        <div v-else class="vm-item" role="menuitemcheckbox" tabindex="0"
             :class="{active:isActive(it)}" :aria-checked="isActive(it)&&!it.info ? 'true' : 'false'"
             @click.stop="click(it)" @keydown="onItemKey(it, $event)">
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
import { clampPopPosition } from '../utils/popPos.js' // [A1] viewport clamp (left AND top)
import { roleButtonActivate } from '../utils/roleButtonKey.js' // [D17-DOM4] Enter activation; Space comes from main.js's capture handler (roles allowlisted)

const SORT_VALUE = {
  'viewMore.sortCustom': 'custom',
  'viewMore.sortByCreated': 'created',
  'viewMore.sortByDifficulty': 'difficulty'
}

// [component-fixes] pure-start (U-13: first calendar menu entry must not be a separator)
const MENUS = {
  'todo-list-today': [
    { labelKey: 'viewMore.sortCustom', group: 'sort' },
    { labelKey: 'viewMore.sortByCreated', group: 'sort' },
    { labelKey: 'viewMore.sortByDifficulty', group: 'sort' },
    { sep: true },
    { labelKey: 'viewMore.showCompleted', toggle: 'showComplete' },
    { labelKey: 'viewMore.showNoDate', toggle: 'showNoDate' },
    { labelKey: 'viewMore.checkFollowColor', toggle: 'isCompleteCheckboxColorFollow' }
  ],
  // [Removed todo-list-recent]: the view does not exist in the route table so this menu block never matches (dead key, cleaned up along with views/registry.js consolidation)
  'todo-list-category': [
    { labelKey: 'viewMore.showNoDate', toggle: 'showNoDate' },
    { labelKey: 'viewMore.showCompleted', toggle: 'showComplete' },
    { labelKey: 'viewMore.checkFollowColor', toggle: 'isCompleteCheckboxColorFollow' }
  ],
  'todo-list-calendar': [
    // U-13: no leading separator — the menu used to open with a stray line above the first item
    { labelKey: 'statsE.ViewMoreMenu.showCompletedMenuItem', toggle: 'isShowCalendarCompleted' },
    { labelKey: 'statsE.ViewMoreMenu.privacyBlurMenuItem', toggle: 'isShowCalendarPrivacyMode' }
    // [fix 2026-10-09] removed the dead "holiday badges" toggle: no consumer of showHolidayMarkers
    // exists (rendering was never implemented; the setting was removed from SettingsModal 2026-09-25)
  ]
  // The todo box has no menu: sorting/order/categories are already provided by the header toolbar dropdown, another copy in the menu would be pure duplication
}
// [component-fixes] pure-end

export default {
  name: 'ViewMoreMenu',
  data () { return { open: false, items: [] } },
  computed: {
    routeName () { return this.$route.name },
    // When this page has no menu items, do not render the button at all (e.g. the todo box: the toolbar already has all view controls)
    hasMenu () { return !!(MENUS[this.routeName] && MENUS[this.routeName].length) },
    // [D17-DOM4] mutually-exclusive sort items split out of the flat list so they can render as
    // menuitemradio inside their own role=group; separators and toggles stay in original order
    sortItems () { return this.items.filter(it => it.group === 'sort') },
    otherItems () { return this.items.filter(it => it.group !== 'sort') }
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
          // [maint-0925 A13] clamp to the viewport on the left side: near the left edge clientX-190
          // went negative and the pop was cut off / off-screen
          // [A1] top is clamped too now (height measured in the SAME $nextTick): near a window's
          // bottom edge the old clientY+8 pushed items below the viewport and unreachable.
          const pos = clampPopPosition(e.clientX, e.clientY, el.offsetHeight, window.innerWidth, window.innerHeight)
          el.style.left = pos.left + 'px'
          el.style.top = pos.top + 'px'
          const first = el.querySelector('.vm-item[tabindex="0"]')
          if (first) first.focus()
        }
      })
    },
    // [R13] single close path that returns focus to the ⋮ trigger: the menu used to close with the
    // trigger unreached on every path except Escape (item click, outside mousedown), dropping
    // keyboard users at <body> after activating a menu item. The OUTSIDE-mousedown closer opts out
    // (closeMenu(false)): that user clicked elsewhere on the page — silently yanking focus (and
    // possibly scroll-into-view) back to the ⋮ button is a surprise; their focus already moved to
    // whatever they clicked.
    closeMenu (refocus = true) {
      if (!this.open) return
      this.open = false
      if (!refocus) return
      this.$nextTick(() => {
        const btn = this.$el && this.$el.querySelector('.view-more-btn')
        if (btn) btn.focus()
      })
    },
    /* [D17-DOM4] menu item activation: Enter here; Space is owned by main.js's document capture
       handler (menuitemradio/menuitemcheckbox are allowlisted there — a second Space layer here
       would double-activate and cancel out, see the maint/d26 ownership contract). */
    onItemKey (it, e) { roleButtonActivate(() => { this.click(it) }, { stop: true }).call(this, e) },
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
        this.closeMenu()
      }
    },
    isActive (it) {
      const st = this.$store.state.settings
      if (it.toggle) return !!st[it.toggle]
      if (it.group === 'sort') return st.sortMode === SORT_VALUE[it.labelKey]
      return false
    },
    click (it) {
      if (it.toggle) {
        this.$store.commit('settings/updateSettings', { [it.toggle]: !this.$store.state.settings[it.toggle] })
        this.$store.dispatch('todo/computeViews')
      } else if (it.group === 'sort') {
        this.$store.commit('settings/updateSettings', { sortMode: SORT_VALUE[it.labelKey] })
        this.$store.dispatch('todo/computeViews')
      }
      // [R13] same focus-return close path as Escape (item activation used to strand focus)
      this.closeMenu()
    },
    onDocDown (e) {
      if (this.open && !e.target.closest('.view-more-pop') && !e.target.closest('.view-more-btn')) this.closeMenu(false)
    }
  },
  mounted () { document.addEventListener('mousedown', this.onDocDown, true) },
  beforeUnmount () { document.removeEventListener('mousedown', this.onDocDown, true) },

}
</script>
<style>/* 图标缩到 14:24 方钮与行内其他元素(22px 视图钮/日期格)齐平,不再独自凸出 */

/* ============ 页面 ⋮ 视图设置菜单（设计稿 pure-icon-button--more + custom-menu） ============ */
.view-more-wrap { position: relative; align-self: flex-start; }
.view-more-btn {
  width: 30px; height: 39px; border: 0; background: none; border-radius: var(--radius-md);
  display: inline-flex; align-items: center; justify-content: center; color: var(--text-2);
}
.view-more-btn svg { fill: currentColor; }
.view-more-btn:hover, .view-more-btn.on { background: var(--gray-bg); color: var(--text-1); }
.view-more-pop {
  position: fixed; z-index: var(--z-viewmenu); min-width: 200px; background: var(--panel, #fff);
  border-radius: var(--radius-md); box-shadow: var(--shadow-pop); padding: 6px;
}
.vm-item { padding: 8px 14px; border-radius: var(--radius-md); font-size: var(--fs-sm); color: var(--text-1); cursor: pointer; display: flex; justify-content: space-between; }
.vm-item:hover { background: var(--brand-light); color: var(--brand); }
.vm-item.active { color: var(--brand); }
.vm-sep { height: 1px; background: var(--line); margin: 5px 8px; }
</style>
