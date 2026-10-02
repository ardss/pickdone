/**
 * SideNav.vue method/computed bodies, extracted verbatim (size-ratchet split; pure move).
 * Every function takes the component instance (`vm`) as its first argument and mutates it
 * exactly the way the original `this`-bound method did -- no logic was reordered or renamed.
 */
import { NAV_LABEL } from './navConfig.js'
import { commit as commitCommand } from '../../utils/commandBus.js'
import i18n from '../../i18n/index.js'

/* ===== computed bodies ===== */

/* Project warning badge: number of projects with an approaching deadline/milestone due (within 7 days, including overdue) — the template previously referenced a never-declared projectWarn so the badge was always empty (confirmed by the template identifier guard's first run) */
export function projectWarn (vm) {
  const meta = vm.$store.state.category.projectMeta || {}
  const now = Date.now()
  const WEEK = 7 * 86400000
  let n = 0
  for (const id of Object.keys(meta)) {
    const m = meta[id] || {}
    if ((m.deadline && m.deadline - now < WEEK) || (m.nextMilestone && m.nextMilestone.date && m.nextMilestone.date - now < WEEK)) n++
  }
  return n
}

export function userNameMasked (vm) {
  const u = vm.user || {}
  // The default name is not persisted (otherwise the first-run language would be frozen); translated live in the current language
  if (u.userNameDefault) return vm.$t('statsA.core.offlineUser')
  return u.userName || vm.$t('statsE.SideNav.notSignedIn')
}

export function avatarChar (vm) { return (userNameMasked(vm) || '·').trim().charAt(0).toUpperCase() || '·' }

export function avatarStyle (vm) {
  // Hash the username into a fixed hue so the same user keeps a stable color, with no offline avatar file dependency
  let h = 0
  for (const ch of String(userNameMasked(vm))) h = (h * 31 + ch.charCodeAt(0)) % 360
  return { background: `linear-gradient(135deg, hsl(${h},62%,58%), hsl(${(h + 40) % 360},62%,46%))` }
}

/* ===== method bodies ===== */

export function navLabel (vm, n) {
  const v = NAV_LABEL[n] || ''
  return (v && v.i18n) ? i18n.global.t(v.i18n) : v
}

/* Experimental nav items carry their disclaimer (the string already written for the settings
   toggle) as a tooltip — label when collapsed, hint when expanded — and as aria text, so a
   developer hovering the bare "今日·实验" entry can tell what it is without opening settings.
   Returns '' for ordinary items: they keep the previous no-hint behavior. */
export function navHint (vm, n) {
  return n === 'todo-list-today-x' ? i18n.global.t('statsE.SettingsModal.sTodayX') : ''
}

/* Full aria-label: visible label plus the hint when one exists so screen readers announce both;
   null for ordinary items (falls back to the element's text content). */
export function navAria (vm, n) {
  const hint = navHint(vm, n)
  return hint ? `${navLabel(vm, n)} — ${hint}` : null
}

/* Clicking the search icon while collapsed: expand the sidebar and hand focus to the search input.
   In narrow windows (<920px) the expanded state uses the drawer overlay (CSS media query, absolutely positioned over the main column without squeezing the layout),
   so it can be expanded and focused directly at any width */
export function expandAndFocusSearch (vm) {
  if (!vm.collapsed) return
  vm.toggleCollapse()
  vm.$nextTick(() => {
    const input = vm.$refs.searchInput
    if (input) { input.focus(); input.select() }
  })
}

/* Whole search box click (user-finalized: clicking again collapses it) --
   clicking the input/clear button does not trigger; collapsed = expand + focus; expanded = collapse the sidebar */
export function onSearchClick (vm, e) {
  if (e.target.tagName === 'INPUT' || e.target.closest('.main-nav-search__clear')) return
  if (vm.collapsed) vm.expandAndFocusSearch()
  else vm.toggleCollapse()
}

/* Esc inside the input: clear text first if any; if empty (or already cleared) collapse the sidebar and dismiss the search box */
export function onSearchEsc (vm) {
  if (String(vm.$store.state.todo.search || '').trim()) { vm.clearSearch(); return }
  const input = vm.$refs.searchInput
  if (input) input.blur()
  if (!vm.collapsed) vm.toggleCollapse()
}

/* Reference MainNavSearch: typing writes to the store and navigates to the search page immediately; go back when cleared */
export function onSearchInput (vm, v) {
  vm.$store.commit('todo/setSearch', v)
  const w = String(v || '').trim()
  // Snapshot the view we are leaving when entering search, so clearing can navigate back deterministically ($router.back() is unreliable: empty history stack misfires)
  if (w && vm.$route.name !== 'todo-list-search') {
    vm._searchReturnRoute = { name: vm.$route.name, params: { ...vm.$route.params } }
    vm.go('todo-list-search')
  }
  if (!w && vm.$route.name === 'todo-list-search') vm._returnFromSearch()
}

export function clearSearch (vm) {
  vm.$store.commit('todo/setSearch', '')
  if (vm.$route.name === 'todo-list-search') vm._returnFromSearch()
}

export function createCategory (vm) {
  const name = vm.$t('statsE.SideNav.newCategory')
  vm.$store.commit('category/addCategory', { categoryName: name })
  const list = vm.$store.state.category.list
  vm.catEditing = list[list.length - 1].categoryId
  vm.newCatName = name
  vm.$nextTick(() => {
    const inp = vm.$el.querySelector('.sn-cat-edit')
    if (inp) { inp.focus(); inp.select() }
  })
}

/** New tag: same position and interaction as "New Category"; the tag itself is still derived from #xxx in content, empty tags are stored in meta as placeholders.
 *  [D13 A4] the userTags meta put used to be fire-and-forget (.catch(() => {})): on a write
 *  failure the placeholder tag lived in memory only and silently disappeared after restart.
 *  The put is now awaited — on failure the in-memory setUserTags is rolled back and the failure
 *  is surfaced (same shape as the awaited-command R3 pattern). */
export async function createTag (vm) {
  try {
    const { value } = await vm.$prompt(vm.$t('statsE.SideNav.tagAutoCreateHint'), vm.$t('statsG.SideNav.newTagTitle'), {
      inputValue: '', inputPattern: /\S/, inputErrorMessage: vm.$t('statsE.SideNav.tagNameEmptyError')
    })
    const name = (value || '').trim().replace(/^#+/, '')
    if (!name) return
    const prev = vm.$store.state.ui.userTags.slice()
    const list = prev.slice()
    if (!list.includes(name) && !vm.tags.some(t => t.name === name)) list.push(name)
    vm.$store.commit('ui/setUserTags', list)
    if (window.todoAPI && window.todoAPI.dbCall) {
      try {
        await commitCommand("meta", "put", ['userTags', JSON.stringify(list)])
      } catch (e) {
        vm.$store.commit('ui/setUserTags', prev)
        vm.$message.error(vm.$t('statsG.SideNav.syncFailMsg') + ((e && e.message) ? `: ${e.message}` : ''))
      }
    }
  } catch { /* cancelled */ }
}

export function addCategory (vm) {
  const name = vm.newCatName.trim() || (vm.$t('statsE.SideNav.categoriesLabel') + (vm.categories.length + 1))
  vm.$store.commit('category/addCategory', { categoryName: name })
  vm.newCatName = ''
}

// Empty name used to silently keep the old name; warn and keep editing so the user notices (see SideNav.saveCatEdit)
export function saveCatEdit (vm, c) {
  if (vm.catEditing !== c.categoryId) return // blur fires after Esc-cancel: nothing left to save
  const n = vm.newCatName.trim()
  if (!n) {
    vm.$message.warning(vm.$t('statsG.SideNav.catNameEmptyWarn'))
    // [D13 A12] the warning kept catEditing set, but blur had already fired — the inline editor
    // sat unfocused (a zombie input the keyboard could not reach). Re-focus it so the user can
    // type immediately (same $nextTick refocus shape as startCatEdit/HabitView).
    vm.$nextTick(() => {
      const inp = vm.$el.querySelector('.sn-cat-edit')
      if (inp) inp.focus()
    })
    return
  }
  vm.$store.commit('category/updateCategory', { categoryId: c.categoryId, categoryName: n })
  vm.catEditing = null
}

export function startCatEdit (vm, c) {
  vm.catEditing = c.categoryId
  vm.newCatName = c.categoryName
  vm.$nextTick(() => {
    const inp = vm.$el.querySelector('.sn-cat-edit')
    if (inp) { inp.focus(); inp.select() }
  })
}

/* ===== Sync: the icon spins for exactly the sync duration, then turns into a checkmark in place on completion;
   the result is clearly fed back via a top-right notification (success/failure); the checkmark is only an icon-state supplement ===== */
export async function syncNow (vm) {
  if (vm.spinning || vm.$store.state.todo.isSyncing) return
  vm.spinning = true
  try {
    await vm.$store.dispatch('todo/syncTodos')
    vm.syncDone = true
    clearTimeout(vm._syncDoneTimer)
    vm._syncDoneTimer = setTimeout(() => { vm.syncDone = false }, 1400)
    vm.$notify({ title: vm.$t('statsE.SideNav.syncCompleteMsg'), message: vm.$t('statsG.SideNav.syncDoneMsg'), type: 'success', duration: 2000 })
  } catch (e) {
    vm.$notify({ title: vm.$t('statsE.SideNav.syncFailedMsg'), message: (e && e.message) || vm.$t('statsG.SideNav.syncFailMsg'), type: 'error', duration: 4000 })
  } finally { vm.spinning = false }
}

/* ===== Direct sidebar category operations (replacing the old "Manage Categories" modal) ===== */
export function dragStartCat (vm, o, e) {
  vm.catDragId = o.categoryId
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', String(o.categoryId))
}

export function dragOverCat (vm, o, e) {
  if (vm.catDragId == null || vm.catDragId === o.categoryId) return
  vm.dragOverId = o.categoryId
  // Decide whether to insert before or after the target based on the mouse being in the row's upper/lower half
  const rect = e.currentTarget.getBoundingClientRect()
  vm.dragPos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

export function dropOnCat (vm, o, e) {
  const from = vm.catDragId
  const pos = vm.dragPos || 'before'
  vm.catDragId = null
  vm.dragOverId = null
  vm.dragPos = null
  if (from == null || from === o.categoryId) return
  const ids = vm.hierarchical.map(c => c.categoryId)
  const fi = ids.indexOf(from); const ti = ids.indexOf(o.categoryId)
  if (fi < 0 || ti < 0) return
  ids.splice(fi, 1)
  let insertAt = ids.indexOf(o.categoryId)
  if (pos === 'after') insertAt += 1
  ids.splice(insertAt, 0, from)
  vm.$store.commit('category/reorder', ids)
}

export function trashDragOver (vm, e) {
  if (vm.catDragId == null) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  vm.trashHot = true
}

export function dropOnTrash (vm) {
  const id = vm.catDragId
  vm.catDragId = null
  vm.dragOverId = null
  vm.trashHot = false
  const c = vm.$store.getters['category/byId'](id)
  if (c) vm.delCat(c)
}
