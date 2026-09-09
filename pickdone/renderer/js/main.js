import noisePlayer from './utils/noisePlayer.js'
import { deleteWithUndo } from './utils/confirm.js'
/** Entry: assembles store/router, initializes data, mounts global capabilities
 *  Vue 3 (global build runtime): createApp bootstrap, UI layer is Element Plus */
const Vue = window.Vue // vue3 global build (includes createApp and the runtime template compiler)
const ElementPlus = window.ElementPlus

import store from './store/index.js'
import { loadRuntime } from './store/runtimeState.js'
import router from './router.js'
import App from './app-root.vue'
import { setLunarLib } from './utils/repeat.js'
import { getHolidayList } from './utils/holidays.js'

// Vue2 compat layer (@vue/compat) fully removed: our own code has completed migration to Vue3 semantics,
// running entirely on Vue3 behavior (Element Plus is a native Vue3 library, modelValue/update:modelValue communication)

const app = Vue.createApp(App)

// Startup marks (2026-09-02): module evaluation done ≈ all sync vendor scripts parsed; per-stage timings visible in console
// (grep [Startup] in CDP/DevTools). Real first-entry-with-data cost = "total - idle wait"
const __bootT0 = performance.now()
const __bootMarks = []
function bootMark (name) {
  __bootMarks.push({ name, ms: Math.round(performance.now() - __bootT0) })
  try { console.info('[Startup]', name.padEnd(18), '+' + __bootMarks[__bootMarks.length - 1].ms + 'ms') } catch {}
}

// Unified renderer logging: buffered + throttled reporting to the main process to write renderer.log (diagnostic log export depends on this file)
import { logger, installGlobalErrorCapture } from './utils/logger.js'
app.config.errorHandler = (err, vm, info) => {
  window.__lastVueErr = { info, msg: String(err && err.message || err), stack: String(err && err.stack || '').slice(0, 600) }
  logger.error('[vue-error] ' + info + ' ' + (err && err.stack || err))
}
import AppIcon from './components/AppIcon.js'
app.component('app-icon', AppIcon)
app.component('pd-app-icon', AppIcon)
// Global view settings menu: used at the right end of the view-switch row on the Today page (layout header only uses it on non-today routes)
import ViewMoreMenu from './components/ViewMoreMenu.vue'
app.component('view-more-menu', ViewMoreMenu)

// Global announce: writes to the layout root component's aria-live region (accessibility screen-reader announcements)
// Templates can use dayjs / FMT directly (migration fallback so Vue2-era templates can access module imports)
app.config.globalProperties.dayjs = window.dayjs
import { FMT as _FMT } from './utils/core.js'
app.config.globalProperties.FMT = _FMT
app.config.globalProperties.$announce = function (m) {
  // this may be undefined (utility layers often pass a dereferenced reference: completeAction's announce=this.$announce), so don't read this.$root directly
  const root = this && this.$root
  if (root && root.announceMsg) { root.announceMsg(m); return }
  const el = document.querySelector('[aria-live]')
  if (el) {
    el.textContent = ''
    requestAnimationFrame(() => { el.textContent = m })
  }
}

import i18n from './i18n/index.js'

app.use(store)
app.use(router)
app.use(i18n)
// vue-i18n@9 legacy:true only provides $t inside component instances; globalProperties needs explicit injection
app.config.globalProperties.$t = i18n.global.t
// EP 组件内部文案（确认框按钮/日期选择器/分页等）跟随界面语言；运行期切换由 app-root.vue 的
// el-config-provider 响应式接管，这里只定首启值
const EP_LOCALES = { 'zh-CN': window.ElementPlusLocaleZhCn, 'en-US': window.ElementPlusLocaleEn }
app.use(ElementPlus, { size: 'small', locale: EP_LOCALES[i18n.global.locale] || EP_LOCALES['zh-CN'] })
// 服务式组件（MessageBox/Message/Notification）不挂在 el-config-provider 组件树内，读的是 install 时的
// 模块级 globalConfig 快照——语言切换后须重新注入，否则弹窗按钮停留首启语言（OK/Cancel vs 确定/取消）
const epLocaleCfg = Vue.computed(() => ({ locale: EP_LOCALES[i18n.global.locale] || EP_LOCALES['zh-CN'] }))
ElementPlus.provideGlobalConfig(epLocaleCfg, app, true)
Vue.watch(() => i18n.global.locale, () => { ElementPlus.provideGlobalConfig(epLocaleCfg, app, true) })

// v-click-outside="fn": callback when clicking outside the element (unified capture, auto cleanup, replacing hand-written document listeners in each component)
app.directive('click-outside', {
  mounted (el, binding) {
    el._coHandler = e => {
      // contains instead of closest(el): closest expects a CSS selector, passing an element throws InvalidSelector (a console ERR noise source)
      if (!el.contains(e.target)) binding.value(e)
    }
    document.addEventListener('mousedown', el._coHandler, true)
  },
  unmounted (el) {
    document.removeEventListener('mousedown', el._coHandler, true)
  }
})

// Reload from DB when other windows modify data (runtime module registered outside the root module)
store.registerModule('_rt', {
  actions: {
    async refreshFromDb () {
      let rows
      try { rows = await window.todoAPI.dbCall('getAll', {}) } catch (e) { console.error('[rt] read failed:', e); return }
      store.commit('todo/setAllRows', rows)
      store.dispatch('todo/computeViews')
    }
  }
})


// Global errors are funneled into the logger (console output unchanged, plus reported to the main process into renderer.log)
installGlobalErrorCapture()

// Reminder sound: the main process sends the audio file path, played here via Audio (Electron allows playback without a user gesture by default)
if (window.todoAPI && window.todoAPI.onPlaySound) {
  window.todoAPI.onPlaySound(file => {
    try { new Audio(file).play().catch(() => {}) } catch (e) { /* empty */ }
  })
}

/** Global a11y: fills in click activation for Space on role="button"/"checkbox"/"switch"/"menuitem"
 *  (the HTML spec requires both Enter and Space to activate; the project uses roles instead of <button> in many places, so adding @keydown.space one by one is unmaintainable.
 *  A single document listener covers the whole site, excluding INPUT/TEXTAREA/select/native button and other natively supported elements.) */
document.addEventListener('keydown', (e) => {
  if (e.key !== ' ' || e.ctrlKey || e.altKey || e.metaKey) return
  if (e.repeat) return
  const t = e.target
  if (!t || !t.getAttribute) return
  // Natively activatable elements keep their own handling
  const tag = t.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A' || t.isContentEditable) return
  const role = t.getAttribute('role')
  if (role === 'button' || role === 'checkbox' || role === 'switch' || role === 'menuitem' || role === 'option' || role === 'tab') {
    // checkbox/switch still need click to trigger; aria-disabled treated as disabled
    if (t.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return }
    e.preventDefault()
    t.click()
  }
}, true) // Capture phase runs before in-component keydown handlers. NOTE: preventDefault does NOT stop
// propagation, so role-bearing elements must NOT also bind @keydown.space — handler + this global click()
// would toggle twice and cancel out (2026-09-09 review found exactly that across 14 spots; real <button>s
// are safe because this preventDefault cancels their native Space keyup activation).

// Lets deep logic call UI capabilities (assigned as the root instance proxy in bootstrap after mount, with $store/$message/$confirm)
window.appUI = null

// Window roles: main window (default) / tomato float window (__tomato-float) / global quick-add window (__quick-add)
// Float and quick-add windows are lightweight helpers: auto-backup setInterval never runs there;
// the float window adds a fallback tick heartbeat (main.js the bottom), quick-add syncs passively via storage events and IPC broadcasts
const isMainShell = !/__tomato-float|__quick-add/.test(window.location.hash)

async function bootstrap () {
  // 2026-09-02 measurement verdict: keep it serial. Tried settings∥category in parallel; measured total time actually rose ~50ms
  // (category's DB IPC contended with settings, todo/init went from ~57ms to ~150ms), reverted.
  // First frame paints at mount (+11ms); the data pipeline reacts in within 350ms, so serial is enough.
  // Dual-channel settings consistency fallback: restore known keys from config.json when localStorage was cleared
  try {
    const cfg = await window.todoAPI.getSettings()
    bootMark('settings restored')
    if (cfg && typeof cfg === 'object') {
      const known = Object.keys(store.state.settings)
      const patch = {}
      for (const k of known) if (k in cfg) patch[k] = cfg[k]
      if (Object.keys(patch).length) store.commit('settings/updateSettings', patch)
    }
  } catch {}
  // Legacy plaintext password migration: upgrade to safeStorage ciphertext (enc1: prefix)
  try {
    const pw = store.state.settings.securityLockPassword
    if (pw && !String(pw).startsWith('enc1:')) {
      const enc = await window.todoAPI.encryptSecret(pw)
      store.commit('settings/updateSettings', { securityLockPassword: enc })
    }
  } catch {}
  try {
    await store.dispatch('todo/init')
    bootMark('todo/init')
    await store.dispatch('category/init') // Categories unified into SQLite (CLI and UI share one source; auto-migrates localStorage on first run)
    bootMark('category/init')
    // Primary-data mirror restore: backfill settings/habits/tomato records from the DB archive when it is newer than LS (no more loss when LS is cleared)
    store.dispatch('settings/initFromDb').catch(() => {})
    store.dispatch('habits/initFromDb').catch(() => {})
    store.dispatch('tomato/initFromDb').catch(() => {})
    import('./utils/tomatoEstimate.js').then(m => m.initFromDb()).catch(() => {}) // Estimated tomatoes: backfill from meta when newer (same ledger as CLI setEstimate, 2026-09-03)
    store.dispatch('filters/load').catch(() => {}) // Saved filters (smart lists)
    // Statutory holiday table (data source for repeat tasks "skip holidays / weekdays only") + lunar calendar library injection (lunar yearly repeats)
    store.commit('todo/setHolidayList', getHolidayList())
    import('./utils/lunar.js').then(m => m.loadSolarLunar())
      .then(m => setLunarLib(m.default || m)).catch(() => {})
    // Yesterday's-leftover migration prompt only pops in the main window (2026-08-31 user-tested: missing guard made the fullscreen confirm pop in float/quick-add windows too)
    if (isMainShell) import('./utils/leftovers.js').then(m => m.maybeAskLeftovers(store)).catch(() => {})
  } catch (e) { console.error('[main] init failed', e && e.stack || e) }
  bootMark('secondary stores')

  // External writes (CLI/other windows) trigger a full reload after persisting; payload { reason, at }, no exclude concept.
  // Debounced 500ms: avoids burst full reloads when multiple windows (float/widgets) are online simultaneously
  let _todosChangedTimer = null
  let _todosChangedTail = null
  const _reloadExternal = () => {
    store.dispatch('todo/init').catch(() => {})
    // CLI can now write categories (category add/rename/rm) — reloading todos only would make new categories appear in the sidebar only after restart
    store.dispatch('category/init').catch(() => {})
  }
  window.todoAPI.onTodosChanged(() => {
    clearTimeout(_todosChangedTimer)
    // Guard runs when the timer fires, not on arrival: an IPC broadcast may arrive before subscribeAction.after timestamps,
    // so checking at fire time is the only way to cover "our own persisted write broadcast coming back" (otherwise todo/init's historyClear
    // would wipe the undo stack and Ctrl+Z of the just-completed op stops working; 2026-08-31 user-tested: couldn't undo after completing in the matrix)
    _todosChangedTimer = setTimeout(() => {
      if (Date.now() - (store.state.todo._lastLocalWriteAt || 0) < 1500) {
        // External updates arriving within the echo-suppression window are not dropped outright: schedule a trailing reload, otherwise tasks just created in the quick-add window/peer would wait for the next change to appear
        clearTimeout(_todosChangedTail)
        _todosChangedTail = setTimeout(_reloadExternal, 1600)
        return
      }
      _reloadExternal()
    }, 500)
  })

  // CLI settings set hot-apply: the main process watcher diffs changed keys and pushes a patch; going through the update action keeps
  // LS/config.json/shortcuts/login-items all in sync (the write-back mirror's _savedAt updates, so the main process diff converges to empty)
  if (window.todoAPI.onExternalSettingsChanged) {
    window.todoAPI.onExternalSettingsChanged(patch => {
      try {
        if (patch && Object.keys(patch).length) store.dispatch('settings/update', patch)
      } catch (e) { console.error('[cli-settings] hot-apply failed', e) }    })
  }

  // CLI tomato command channel (pickdone tomato start/stop/attach): dispatches existing store/tomato actions,
  // reusing idempotency tokens/cross-window claims/record-keeping/project focus minutes; on completion the state is written back to meta cliTomatoState for CLI status to read
  // 浮窗不消费 CLI 命令:双窗各 dispatch start/stop 且都写回执,回执内容由最后写完的窗决定=非确定性(2026-09-04 二轮深审 P2)
  if (window.todoAPI.onCliTomatoCmd && isMainShell) {
    window.__cliTomatoLastSeq = 0
    window.todoAPI.onCliTomatoCmd(async cmd => {
      try {
        if (!cmd || !(cmd.seq > (window.__cliTomatoLastSeq || 0))) return
        window.__cliTomatoLastSeq = cmd.seq
        // Stale-command replay protection: the cmd in meta survives App crashes/exits; on next start the first external write would execute it as a new
        // command (an old start would suddenly kick off a focus session). 60s TTL; CLI includes at when writing commands
        if (!cmd.at || Date.now() - cmd.at > 60000) { console.warn('[cli-tomato] ignoring stale command (>60s):', cmd.action, 'seq=' + cmd.seq); return }
        const t = store.state.tomato
        if (cmd.action === 'start') {
          if (cmd.minutes > 0 && cmd.minutes !== t.tomatoTime) {
            // One-shot CLI minutes must not permanently rewrite the user's focus-length setting: remember the original
            // (only if not already remembered by an earlier CLI start) and restore it when the CLI session stops
            if (!window.__cliTomatoPrevMinutes) window.__cliTomatoPrevMinutes = t.tomatoTime
            store.commit('tomato/patch', { tomatoTime: cmd.minutes })
          }
          if (t.status === 'startTomatoTime' || t.status === 'startRestTime') {
            store.dispatch('tomato/giveUp', { record: true, reason: 'cli' }) // Already running: record the previous segment first (per account-keeping closeout, never discard focused time without record) then start a new one
          }
          store.dispatch('tomato/startFocus')
          if (cmd.taskId) store.dispatch('tomato/attach', cmd.taskId)
        } else if (cmd.action === 'stop') {
          const stopP = t.status !== 'default'
            ? store.dispatch('tomato/giveUp', { record: cmd.record !== false, reason: cmd.reason || 'cli' }) /* Stable marker, translated at the display layer */
            : Promise.resolve()
          // CLI session ended: give the closeout persist a chance to finish, then put the user's own focus length back
          stopP.catch(() => {}).then(() => {
            if (window.__cliTomatoPrevMinutes > 0) {
              store.commit('tomato/patch', { tomatoTime: window.__cliTomatoPrevMinutes })
              window.__cliTomatoPrevMinutes = 0
            }
          })
        } else if (cmd.action === 'attach') {
          store.dispatch('tomato/attach', cmd.taskId || null)
        }
        // 账本类命令(record-update/record-remove/backfill)已退役:CLI 直写 tomato_records 行表,
        // 渲染端经 tomato-records-changed 广播重载,不再走本通道(2026-09-04 根修,批3)
        setTimeout(() => {
          try {
            const s = store.state.tomato
            window.todoAPI.dbCall('setMeta', ['cliTomatoState', JSON.stringify({
              seq: cmd.seq, status: s.status, remainSec: s.remainSec, tomatoTime: s.tomatoTime,
              startedAt: s.startedAt, /* CLI status derives real-time remaining seconds from this (remainSec freezes at command time, drift unbounded) */
              attach: s.attachTodo ? { taskId: s.attachTodo.taskId, content: s.attachTodo.taskContent } : null,
              todayTomatoCount: s.todayTomatoCount, at: Date.now()
            })]).catch(() => {})
          } catch (e) { console.error('[cli-tomato] failed to write back state', e) }
        }, 150)
      } catch (e) { console.error('[cli-tomato] command execution failed', e) }
    })
  }

  // Ledger DB broadcast: other windows/CLI directly landed ledger rows, this window reloads the ledger from DB (single source of truth = tomato_records row table)
  if (window.todoAPI.onTomatoRecordsChanged) {
    window.todoAPI.onTomatoRecordsChanged(() => { store.dispatch('tomato/recordsReload').catch(e => console.error('[tomato] ledger reload failed', e)) })
  }

  // Tomato cross-window sync: float/main windows have independent Vuex instances; each reads back after the peer writes localStorage (float starts → main countdown follows)
  window.addEventListener('storage', e => {
    if (e.key === 'tomatoState' || e.key === 'tomatoSyncPing') store.commit('tomato/syncFromStorage')
    // Language/settings cross-window sync: float and quick-add windows are long-lived independent renderers that read only once at creation — they must read back after the main window changes language/theme
    if (e.key === 'appLocale' && e.newValue && i18n.global.locale !== e.newValue) {
      i18n.global.locale = e.newValue
      if (window.todoAPI && window.todoAPI.setAppLocale) window.todoAPI.setAppLocale(e.newValue)
    }
    if (e.key === 'settingsState' && e.newValue) {
      try {
        const next = JSON.parse(e.newValue)
        const cur = store.state.settings
        // Drop out-of-order stale packets: both sides write whole-package + 150ms debounce to LS; a late-arriving older packet once rolled new settings back (root cause of the white-noise selection regressing by chance)
        if (next._lsAt && cur._lsAt && next._lsAt <= cur._lsAt) return
        const patch = {}
        // Apply a diff across all keys instead of picking only 4: any commit the float window makes to settingsState triggers a whole-package persist write-back to LS,
        // syncing only 4 keys would let stale copies of the other keys roll back settings the main window just wrote (only catching up on the next event)
        for (const k of Object.keys(next)) {
          if (k.startsWith('_') || k === 'schemaV') continue
          if (JSON.stringify(next[k]) !== JSON.stringify(cur[k])) patch[k] = next[k]
        }
        if (Object.keys(patch).length) store.commit('settings/updateSettings', patch)
      } catch { /* Malformed JSON ignored */ }
    }
  })
  // Auto-backup loop: checks every minute; when the time since the last backup exceeds the configured interval (and the switch is on), writes a rolling snapshot.
  // Runs in the main window only (float/quick-add main.js won't enter the if block; runAutoBackup has file-lock-level dedup to avoid rewrites)
  if (isMainShell) {
    setInterval(() => {
      const st = store.state.settings
      if (st.autoBackupEnabled === false) return
      const interval = (st.autoBackupIntervalMin || 30) * 60000
      if (Date.now() - (loadRuntime().autoBackupLastAt || 0) < interval) return
      store.dispatch('todo/writeAutoBackup').catch(() => {})
    }, 60000)
  }

  // White noise follows the focus lifecycle (2026-09-01 semantics finalized: picked a sound → auto play/switch on focus start, auto stop at end;
  // float-menu sound picks sync to the main window store via storage; dispatched uniformly here). Main window only, to avoid double audio
  if (isMainShell) {
    const applyNoise = () => {
      const st = store.state.tomato
      const key = store.state.settings.whiteNoiseAudio
      const vol = Number(store.state.settings.whiteNoiseVolume)
      if (st.status === 'startTomatoTime' && key) noisePlayer.startNoise(key, Number.isFinite(vol) ? vol : .55)
      else noisePlayer.stopNoise()
    }
    store.subscribe((mutation) => {
      const sp = mutation.type === 'settings/updateSettings' && mutation.payload
      if (mutation.type === 'tomato/patch' || (sp && ('whiteNoiseAudio' in sp || 'whiteNoiseVolume' in sp))) applyNoise()
    })
    applyNoise()

    // Custom white-noise file replaced on disk: the main process broadcasts 'white-noise-updated' after the user
    // picks a new file (channel name fixed main-process-side); drop the player's permanent decode cache so the
    // new audio actually plays. Preload exposes onWhiteNoiseUpdated — guarded because older preload builds may
    // not whitelist the channel yet (in that case nothing subscribes and behavior is the old status quo).
    if (typeof window.todoAPI.onWhiteNoiseUpdated === 'function') {
      window.todoAPI.onWhiteNoiseUpdated(d => {
        noisePlayer.invalidate(d && d.key)
        applyNoise() // was playing the replaced sound: restart so it re-decodes the new file immediately
      })
    }
  }

  // Shared tomato tick: main window drives + float window is a fallback heartbeat (2026-09-04 deep review P0: main window can be closed/rebuilt (tray minimization),
  // single-point heartbeat would make the entire focus that is counting down in the float window silently evaporate). Quick-add does not participate ( controlling CPU stack, was 3-window 1Hz at 5-15% ).
  // cross-window sync relies on the localStorage storage event + tomato.js's deterministic tomatoId + claimPhase token.
  const isFloatShell = /__tomato-float/.test(window.location.hash)
  if (isMainShell || isFloatShell) {
    setInterval(() => { store.dispatch('tomato/tick').catch(() => {}) }, 1000)
  }

  // When the tomato timer is enabled and the float window hasn't been closed, auto-show the float window 6 seconds after start — main window only
  // (quick-add/float windows also load this file; indiscriminate popping would "revive" a float window the user closed)
  if (isMainShell) {
    setTimeout(() => {
      if (window.todoAPI && store.state.settings.enableTomatoFloating !== false) {
        window.todoAPI.showTomatoFloat()
      }
    }, 6000)
  }

  // Global shortcut conflict notice: sent only after the main process exhausts retries, at most once per key per run; uses a non-blocking toast (the modal-dialog approach was dropped)
  if (typeof window.todoAPI.onShortcutConflict === 'function') {
    const offConflict = window.todoAPI.onShortcutConflict(({ msg }) => {
      try {
        window.ElementPlus.ElMessage({ type: 'warning', message: msg, duration: 6000, showClose: true })
      } catch { /* Silent if toast fails; don't add errors on top of the notice */ }
    })
    // Browser shim fallback Proxy may return a non-function: nothing was really subscribed then, and nuking the API property wouldn't unsubscribe — just leave it
    if (typeof offConflict !== 'function') { /* nothing to unsubscribe */ }
  }

  // Global update-ready notice: users shouldn't have to open settings to learn an update finished — a long-lived toast says quitting installs it (the button in SettingsModal can still restart-update immediately).
  // Kept outside the shortcut-conflict block: it was wrongly nested inside that if, so in environments without the conflict API the updater subscription never ran at all
  if (typeof window.todoAPI.onUpdaterEvent === 'function') {
    let _readyToasted = false
    window.todoAPI.onUpdaterEvent(d => {
      if (d) store.commit('ui/setUpdateState', d) // Mirror into the ui store: data source for the red-dot badge on the sidebar settings gear
      if (d && d.status === 'ready' && !_readyToasted) {
        _readyToasted = true
        try {
          window.ElementPlus.ElMessage({ type: 'success', message: i18n.global.t('update.readyToast'), duration: 12000, showClose: true })
        } catch { /* Silent if toast fails; the update still installs on quit */ }
      }
    })
  }

  // Shortcut action dispatch (deleteEvent/pinEvent/startPomodoro/switchTo* etc., aligned with the reference shortcutKeySettings)
  window.todoAPI.onShortcutAction(action => {
    const selectedTaskId = () => {
      const el = document.querySelector('.td-item.selected')
      if (!el) return null
      const v2 = el.__vue__
      if (v2 && v2.todo) return v2.todo.taskId
      const v3 = el.__vueParentComponent && el.__vueParentComponent.ctx
      return (v3 && v3.todo && v3.todo.taskId) || null
    }
    switch (action) {
      case 'deleteEvent': {
        const id = store.state.ui.rightSidebarTodoEdit.taskId || selectedTaskId()
        const t = id && store.state.todo.todoList.find(x => x.taskId === id)
        if (t) deleteWithUndo(window.appUI, store, t).then(ok => { if (ok) store.dispatch('todo/computeViews') })
        break
      }
      case 'pinEvent': case 'unpinEvent': {
        const id = store.state.ui.rightSidebarTodoEdit.taskId || selectedTaskId()
        const t = id && store.state.todo.todoList.find(x => x.taskId === id)
        if (t) {
          store.dispatch('todo/updateTodoFields', { taskId: t.taskId, patch: { taskSort: action === 'pinEvent' ? 99999.5 : -99999.5 } })
        }
        break
      }
      case 'startPomodoro': {
        store.commit('ui/toggleTomatoPanel', true)
        store.dispatch('tomato/startFocus')
        break
      }
      case 'toggleAllSubtasks': {
        // Expand/collapse all subtask blocks: toggles the global isShowSubTask
        store.commit('settings/updateSettings', { isShowSubTask: !store.state.settings.isShowSubTask })
        break
      }
      case 'switchToDaytodo': router.push({ name: 'todo-list-today' }).catch(() => {}); break
      case 'switchToRecentTodos': router.push({ name: 'todo-list-today' }).catch(() => {}); break
      case 'switchToSchedule': router.push({ name: 'todo-list-calendar' }).catch(() => {}); break
      case 'switchToInbox': router.push({ name: 'todo-list-todo-box' }).catch(() => {}); break
    }
  })
  window.todoAPI.onOpenSettings(() => store.commit('ui/toggleSettings', true))
  window.todoAPI.onSecurityLock(() => store.commit('ui/setLocked', true))
  if (window.todoAPI.onSecurityUnlock) window.todoAPI.onSecurityUnlock(() => store.commit('ui/setLocked', false))

  // Shortcuts: ctrl+n focuses quick-add / ctrl+s sync / ctrl+z undo / ctrl+y·ctrl+shift+z redo (offline = local archive)
  window.addEventListener('keydown', e => {
    // Inside inputs/textareas, leave Ctrl+Z to text-level undo; don't steal it
    const ae = document.activeElement
    const inEditor = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
    if (e.ctrlKey && e.key.toLowerCase() === 'n') {
      e.preventDefault()
      window.dispatchEvent(new CustomEvent('todo:focus-quickadd'))
    } else if (e.ctrlKey && e.key.toLowerCase() === 's') {
      e.preventDefault()
      store.dispatch('todo/syncTodos').catch(e => console.error('[todo] manual sync failed', e))
    } else if (!inEditor && e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      store.dispatch('todo/undo').then(r => {
        const ok = r && r.ok
        const label = ok && r.label ? i18n.global.t('statsH.main.undone') + '：' + r.label : i18n.global.t(ok ? 'statsH.main.undone' : 'statsH.main.undoEmpty')
        window.appUI.$message[ok ? 'success' : 'info'](label)
      }).catch(e => console.error('[todo] undo failed:', e))
    } else if (!inEditor && ((e.ctrlKey && e.key.toLowerCase() === 'y') || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault()
      store.dispatch('todo/redo').then(r => {
        const ok = r && r.ok
        const label = ok && r.label ? i18n.global.t('statsH.main.redone') + '：' + r.label : i18n.global.t(ok ? 'statsH.main.redone' : 'statsH.main.redoEmpty')
        window.appUI.$message[ok ? 'success' : 'info'](label)
      }).catch(e => console.error('[todo] redo failed:', e))
    }
  })

  // Day-rollover refresh: full recompute only when tasks changed (dirty flag) or the calendar day rolled over, avoiding idle spinning every minute
  // Compare the full date string: getDate() only compares day-of-month, so a cross-month sleep (1st→2nd, same number) would miss it and freeze the Today page on the old month
  let lastComputedDay = new Date().toDateString()
  setInterval(() => {
    const day = new Date().toDateString()
    const dayChanged = day !== lastComputedDay
    if (dayChanged) lastComputedDay = day
    // Midnight rollover: reset the selected day whenever it isn't "truly today" (previously only checked "exactly yesterday"; picking tomorrow/earlier then crossing a day left the page silently stuck on the old selection)
    if (dayChanged && store.state.ui.daySelectedTs) {
      const t0 = new Date(); t0.setHours(0,0,0,0)
      if (store.state.ui.daySelectedTs !== +t0) store.commit('ui/setDaySelected', 0)
    }
    if (store.state.todo.viewsDirty || dayChanged) store.dispatch('todo/computeViews')
  }, 60 * 1000)

  // Color mode (light/dark/follow system): apply at startup + react to changes
  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  const applyColorMode = () => {
    const mode = store.state.settings.colorMode
    const dark = mode === 'system' ? mql.matches : mode === 'dark'
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
    document.documentElement.classList.toggle('dark', dark)
  }
  // Follow system: track OS light/dark switches in real time
  if (mql.addEventListener) mql.addEventListener('change', applyColorMode)
  else if (mql.addListener) mql.addListener(applyColorMode)
  applyColorMode()
  store.subscribe((mutation) => {
    if (mutation.type === 'settings/updateSettings' && mutation.payload && mutation.payload.colorMode) applyColorMode()
  })

  // mount moved before bootstrap: if any link in the init chain hangs, no more white screen
}

// Mount first, then initialize: Vuex reactivity refreshes the UI automatically once init data arrives;
// even a hung/failed init still guarantees a visible interface (P0 white-screen prevention)
window.appUI = app.mount('#app')
bootMark('Vue mount (first paint)')
window.__startupReport = () => console.table(__bootMarks)
bootstrap()

export default Vue
