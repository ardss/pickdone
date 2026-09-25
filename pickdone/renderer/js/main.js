import noisePlayer from './utils/noisePlayer.js'
import { deleteWithUndo } from './utils/confirm.js'
import { normalizeSortMode } from './utils/sortMode.js'
/** Entry: assembles store/router, initializes data, mounts global capabilities
 *  Vue 3 (global build runtime): createApp bootstrap, UI layer is Element Plus */
const Vue = window.Vue // vue3 global build (includes createApp and the runtime template compiler)
const ElementPlus = window.ElementPlus

import store from './store/index.js'
import { onExternalHabitBlob } from './store/habits.js'
import { createExternalReloader, kindsFromChangedEvent } from './utils/externalReload.js'
import { loadRuntime } from './store/helpers/runtimeState.js'
import router from './router.js'
import App from './app-root.vue'
import { setLunarLib } from './utils/repeat.js'
import { getHolidayList } from './utils/holidays.js'
import { isStaleTomatoCmd, expiredTomatoReceipt } from './utils/tomatoShared.js'

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
import { commit as commitCommand } from "./utils/commandBus.js"

app.use(store)
// Aux-window habit edits must feed back into main-window Vuex state, or the next main-window persist overwrites them with a stale copy (LWW)
// U-10: return whether the blob was accepted (applyExternal's savedAt guard) — the aux-relay only
// writes the durable DB meta for ACCEPTED blobs, so a stale round can't clobber newer DB state
onExternalHabitBlob(blob => {
  const s = store.state.habits
  if (!blob || !Array.isArray(blob.habits)) return false
  if ((blob.savedAt || 0) < (s.savedAt || 0)) return false
  store.commit('habits/applyExternal', blob)
  return true
})
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
      // Round-6 P0: whole-table replacement (backup restore / CSV import / seed purge all funnel here).
      // Undo entries surviving the replace carry pre-restore snapshots whose from-only delete loop would
      // mass-tombstone the freshly restored rows on the first Ctrl+Z — and sync those deletions to the
      // peer. Same generation guard as purgeIds/purgeAllRecycle: history must not cross a table replace.
      store.commit('todo/historyClear')
      store.commit('todo/setAllRows', rows)
      store.dispatch('todo/computeViews').catch(e => console.warn('[rt] computeViews failed:', e))
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
// F18 (2026-09-24): both hand-copied hash regexes here (isMainShell / isFloatShell) route through
// utils/auxWindow.js now — one copy had drifted to miss __quick-add.
import { isAuxWindow, isFloatWindow } from './utils/auxWindow.js'
const isMainShell = !isAuxWindow()

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
    store.dispatch('auth/initGamification').catch(e => console.warn('[auth] gamification init failed:', e)) // Y10: fold synced gamification deltas into the LS totals
    store.dispatch('habits/initFromDb').catch(() => {})
    store.dispatch('tomato/initFromDb').catch(() => {})
    // Remote running-tomato chip: subscribe to 'tomato-announce' syncEvents + load snapshot
    store.dispatch('tomatoAnnounce/init').catch(() => {})
    import('./utils/tomatoEstimate.js').then(m => m.initFromDb(store.state.todo.todoList.map(t => t.taskId))).catch(() => {}) // Estimated tomatoes: backfill from meta when newer (same ledger as CLI setEstimate, 2026-09-03; Y: per-task key union over live ids)
    // U-6 (2026-09-20): the todoBox difficulty sort reads estimates lazily (ensureEstimate read-through).
    // When an async fetch lands, rebuild views once so the order corrects instead of staying stale until
    // an unrelated rebuild (guarded by the sort mode — other sorts never read estimates).
    import('./utils/tomatoEstimate.js').then(m => m.onEstimateFetched(() => {
      if (store.state.settings.todoBoxSortMethod === 'difficulty') store.dispatch('todo/computeViews').catch(() => {})
    })).catch(() => {})
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
  let _todosChangedSyncApply = false // last broadcast was a LAN-sync-applied round (payload reason)
  let _todosChangedKinds = null // round kinds from the lan-sync-apply broadcast (op = comma-joined)
  // F1 (2026-09-20): reload pipeline extracted to utils/externalReload.js so it is unit-testable
  // and so inbound rounds also refresh saved filters ('filter' kind) and tomato estimates
  // ('meta' kind, initFromDb throttled to 1s) — both used to stay stale until restart.
  const _reloadExternal = createExternalReloader({
    store,
    reloadEstimates: () => import('./utils/tomatoEstimate.js').then(m => m.initFromDb(store.state.todo.todoList.map(t => t.taskId)))
  })
  window.todoAPI.onTodosChanged(evt => {
    _todosChangedSyncApply = !!(evt && evt.reason === 'lan-sync-apply')
    _todosChangedKinds = kindsFromChangedEvent(evt)
    clearTimeout(_todosChangedTimer)
    // Guard runs when the timer fires, not on arrival: an IPC broadcast may arrive before subscribeAction.after timestamps,
    // so checking at fire time is the only way to cover "our own persisted write broadcast coming back" (otherwise todo/init's historyClear
    // would wipe the undo stack and Ctrl+Z of the just-completed op stops working; 2026-08-31 user-tested: couldn't undo after completing in the matrix)
    _todosChangedTimer = setTimeout(() => {
      if (Date.now() - (store.state.todo._lastLocalWriteAt || 0) < 1500) {
        // External updates arriving within the echo-suppression window are not dropped outright: schedule a trailing reload, otherwise tasks just created in the quick-add window/peer would wait for the next change to appear
        clearTimeout(_todosChangedTail)
        _todosChangedTail = setTimeout(() => _reloadExternal({ preserveHistory: _todosChangedSyncApply, kinds: _todosChangedSyncApply ? _todosChangedKinds : null }), 1600)
        return
      }
      // Direct path must cancel any pending trailing reload — otherwise an echo-window trailing
      // timer followed by a direct reload runs _reloadExternal twice (double full reload)
      clearTimeout(_todosChangedTail)
      _reloadExternal({ preserveHistory: _todosChangedSyncApply, kinds: _todosChangedSyncApply ? _todosChangedKinds : null })
    }, 500)
  })

  // CLI settings set hot-apply + LAN-sync applied settings rows: the main process diffs changed keys
  // and pushes a patch. Routed through `settings/updateExternal` (P1-3): the inbound patch is
  // sanitized (unknown/type-mismatch keys dropped, numeric strings coerced) exactly like the
  // restore()/load() paths, so junk from a peer or an old CLI build cannot corrupt live settings.
  if (window.todoAPI.onExternalSettingsChanged) {
    window.todoAPI.onExternalSettingsChanged(patch => {
      try {
        if (patch && Object.keys(patch).length) store.dispatch('settings/updateExternal', patch)
      } catch (e) { console.error('[cli-settings] hot-apply failed', e) }    })
  }

  // F2 (2026-09-20): LAN-sync habits fold channel. Habit fields are NOT part of DEFAULT_SETTINGS,
  // so the settings sanitizer would drop them — S1's main process therefore emits a dedicated
  // 'external-habits-changed' channel with { fields: { habits?, moments? }, savedAt }, which is
  // routed into store/habits.js applyExternalPatch (merges into state, records savedAt, never
  // persists → no echo loop). Registered defensively: when S1's emitter is not merged yet the
  // preload API is simply absent and nothing is wired (no breakage).
  if (window.todoAPI.onExternalHabitsChanged) {
    window.todoAPI.onExternalHabitsChanged(payload => {
      try {
        store.dispatch('habits/applyExternalPatch', payload)
      } catch (e) { console.error('[habits] external patch apply failed', e) }
    })
  }

  // P1-5 (2026-09-19 UX review): LAN sync conflict notice — main emits AT MOST ONE 'sync-conflict'
  // syncEvent per round; show a single non-intrusive toast so the user learns their losing edit was
  // superseded (todo losers: their earlier copy is preserved in the recycle bin; setting/meta: the
  // peer's version was applied). Aux windows (float/quick-add) do not own user notifications.
  // P2b (round 2): under edit-war a toast per round piles up — keep at most ONE visible conflict
  // toast (replace the previous instance) with a 30s minimum interval between shows.
  let _conflictToast = null
  let _conflictShownAt = 0
  if (window.todoAPI.onSyncEvent && isMainShell) {
    window.todoAPI.onSyncEvent(evt => {
      if (!evt || evt.type !== 'sync-conflict') return
      try {
        const EP = window.ElementPlus
        if (!EP || !EP.ElMessage) return
        if (Date.now() - _conflictShownAt < 30 * 1000) return // rate-limit: one conflict notice per 30s window
        if (_conflictToast) { try { _conflictToast.close() } catch (e) { /* already gone */ } _conflictToast = null }
        const key = evt.applied ? 'sync.conflictApplied' : 'sync.conflictKept'
        _conflictToast = EP.ElMessage({ type: 'warning', message: i18n.global.t(key, { name: evt.name || '' }), duration: 6000, showClose: true })
        _conflictShownAt = Date.now()
      } catch (e) { console.warn('[lan-sync] conflict toast failed', e) }
    })
  }

  // Quit-flush ack handshake (main waits for this before closing the DB, ≤2s cap): dbMirror/store flush
  // handlers registered this channel EARLIER (their modules load before main.js), so by the time our
  // listener runs their flush invokes are already dispatched — a short defer just lets the queued IPC
  // messages actually leave before we ack. Payload echoes the token so the main process can drop stale acks.
  if (window.todoAPI.onAppQuittingFlush && window.todoAPI.notifyQuitFlushDone) {
    window.todoAPI.onAppQuittingFlush(payload => {
      setTimeout(() => {
        try { window.todoAPI.notifyQuitFlushDone({ token: payload && payload.token }) } catch (e) { /* app is quitting */ }
      }, 60)
    })
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
        // 2026-09-11 P1: rejection used to be silent — the main process had already marked the command consumed, so no receipt was
        // ever written and the CLI's waitForTomatoAck polled to its full timeout. Write an 'expired' receipt (seq ≥ cmd.seq) so the CLI unblocks.
        if (isStaleTomatoCmd(cmd, Date.now())) {
          console.warn('[cli-tomato] ignoring stale command (>60s):', cmd.action, 'seq=' + cmd.seq)
          // 2026-09-12: the expired receipt is what unblocks the CLI's waitForTomatoAck — a failed write leaves
          // the CLI polling to its full timeout with no trace, so surface the error.
          commitCommand("meta", "put", ['cliTomatoState', JSON.stringify(expiredTomatoReceipt(cmd, Date.now()))]).catch(e => console.error('[cli-tomato] failed to write expired receipt (CLI will wait until timeout):', e))
          return
        }
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
            commitCommand("meta", "put", ['cliTomatoState', JSON.stringify({
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
    // U-17 (2026-09-20): the abandon modal dispatches 'tomato-stop-noise'; wire it to the player so
    // giving up from the modal stops the white noise immediately (the dispatch used to be dead code)
    noisePlayer.listenStopNoiseEvent()

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
  const isFloatShell = isFloatWindow()
  if (isMainShell || isFloatShell) {
    setInterval(() => { store.dispatch('tomato/tick').catch(() => {}) }, 1000)
  }

  // When the tomato timer is enabled and the float window hasn't been closed, auto-show the float window 6 seconds after start — main window only
  // (quick-add/float windows also load this file; indiscriminate popping would "revive" a float window the user closed)
  // F12 (2026-09-24, adversarial-review round 2): the "user explicitly closed" marker lives in the todo
  // DB meta table ('tomatoFloatClosedByUser'), owned by main-process tomato-float.js — the single
  // convergence point of every open/close path (hide() sets it; show()/undock() clear it), so all
  // bypass re-open paths (SettingsModal switch, TomatoPanel button, tray undock) are covered by
  // construction and no renderer-side wiring can drift. (An earlier localStorage + todoAPI-wrapper
  // attempt failed: contextBridge objects are read-only.) dbCall round-trips the marker read.
  if (isMainShell) {
    setTimeout(() => {
      if (!window.todoAPI || store.state.settings.enableTomatoFloating === false) return
      let markerRead = null
      try { markerRead = window.todoAPI.dbCall('getMeta', 'tomatoFloatClosedByUser') } catch { /* db unavailable: default to showing */ }
      Promise.resolve(markerRead).then(v => {
        if (v === '1') return // the user explicitly closed the float last run: keep it closed
        window.todoAPI.showTomatoFloat()
      }).catch(() => { /* marker read failed: err on the visible side */ })
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
    let _availableToasted = false // one-shot: a new version becomes available (autoDownload off) — the main process may re-broadcast 'available' on every 4h check, the toast must not repeat
    window.todoAPI.onUpdaterEvent(d => {
      if (d) store.commit('ui/setUpdateState', d) // Mirror into the ui store: data source for the red-dot badge on the sidebar settings gear
      if (d && d.status === 'available' && !_availableToasted) {
        // Promise kept (updater.js: 'when off, only a new-version notice is shown'): with auto-download
        // off the only consumer of status='available' used to be Settings→About — users who never open
        // settings never heard about the new version. Same long-lived toast shape as the ready toast.
        _availableToasted = true
        try {
          window.ElementPlus.ElMessage({ type: 'info', message: i18n.global.t('statsH.update.availableToast'), duration: 12000, showClose: true })
        } catch { /* Silent if toast fails; Settings→About still offers the download */ }
      }
      if (d && d.status === 'ready' && !_readyToasted) {
        _readyToasted = true
        try {
          window.ElementPlus.ElMessage({ type: 'success', message: i18n.global.t('update.readyToast'), duration: 12000, showClose: true })
        } catch { /* Silent if toast fails; the update still installs on quit */ }
      }
    })
  }

  // Shortcut action dispatch (deleteEvent/pinEvent/startPomodoro/switchTo* etc., aligned with the reference shortcutKeySettings)
  // Round-2 P1: existence-guarded like the onSecurityUnlock neighbor — a preload without the channel must not throw at boot.
  // D6-F2: QuickAdd unmounts on statistics/calendar/search/filter (the bar is hidden there), removing
  // its todo:focus-quickadd listener — Ctrl+N was dead on those views. When the bar is not mounted,
  // fall back by routing to Today (which always mounts it) and focusing after the route lands.
  const focusQuickAdd = () => {
    if (document.querySelector('.qa-wrap')) {
      window.dispatchEvent(new CustomEvent('todo:focus-quickadd'))
      return
    }
    router.push({ name: 'todo-list-today' }).then(() => {
      setTimeout(() => window.dispatchEvent(new CustomEvent('todo:focus-quickadd')), 120)
    }).catch(() => {})
  }
  if (window.todoAPI.onShortcutAction) window.todoAPI.onShortcutAction(action => {
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
        // F-D2 (maint/dw 2026-09-23): the main-process before-input-event does not know about
        // input focus, so typing Ctrl+D inside an input used to delete the selected/edited task
        // outright. Same inEditor exemption the Ctrl+Z/Y branches below already honor.
        const ae = document.activeElement
        const inEditor = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
        if (inEditor) break
        const id = store.state.ui.rightSidebarTodoEdit.taskId || selectedTaskId()
        const t = id && store.state.todo.todoList.find(x => x.taskId === id)
        if (t) deleteWithUndo(window.appUI, store, t).then(ok => { if (ok) store.dispatch('todo/computeViews').catch(e => console.warn('[todo] undo-refresh computeViews failed:', e)) })
        else window.appUI && window.appUI.$message && window.appUI.$message.info(i18n.global.t('statsH.main.deleteNoSelection'))
        break
      }
      case 'pinEvent': case 'unpinEvent': {
        const id = store.state.ui.rightSidebarTodoEdit.taskId || selectedTaskId()
        const t = id && store.state.todo.todoList.find(x => x.taskId === id)
        if (!t) break
        // D6-F5: taskSort only drives order in the "custom" manual sort — in created/difficulty modes
        // the pin silently did nothing visible. Announce honestly instead of a no-op write.
        if (normalizeSortMode(store.state.settings.sortMode) !== 'custom') {
          window.appUI && window.appUI.$message && window.appUI.$message.info(i18n.global.t('statsH.main.pinIgnoredSort'))
          break
        }
        const pinning = action === 'pinEvent'
        // F-D6 (maint/dw 2026-09-23): the dispatch used to be fire-and-forget while the success
        // toast fired unconditionally — a failed safeUpsert (retry-queue only) left a fake
        // "pinned" toast and an unhandled rejection. Await + honest failure toast (P3-7 shape).
        store.dispatch('todo/updateTodoFields', { taskId: t.taskId, patch: { taskSort: pinning ? 99999.5 : -99999.5 } }).then(() => {
          window.appUI && window.appUI.$message && window.appUI.$message.success(i18n.global.t(pinning ? 'statsH.main.pinned' : 'statsH.main.unpinned', { name: t.taskContent || i18n.global.t('statsJ.TodoItem.untitled') }))
        }).catch(e => {
          console.error('[todo] pin/unpin failed:', e)
          window.appUI && window.appUI.$message && window.appUI.$message.error(i18n.global.t('statsH.main.actionFailedMsg') + ((e && e.message) || ''))
        })
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
      // D6-F6: "Recent todos" was hard-wired to todo-list-today-x, which nav-gate hides for non-dev
      // users — the shortcut teleported to a page the sidebar refuses to show. Only route to the
      // experimental view under the same two-layer gate; everyone else lands on Today.
      case 'switchToRecentTodos': {
        const s = store.state.settings
        router.push({ name: (s.developerMode && s.showTodayXModule === true) ? 'todo-list-today-x' : 'todo-list-today' }).catch(() => {})
        break
      }
      case 'switchToSchedule': router.push({ name: 'todo-list-calendar' }).catch(() => {}); break
      case 'switchToInbox': router.push({ name: 'todo-list-todo-box' }).catch(() => {}); break
      // D6-F3: 'addEvent' was registered in the binding table (src/main/shortcuts.js) but never
      // dispatched — the shortcut did nothing at all. Implement as "start inline create here":
      // focus the quick-add bar (the current view's inline-create entry point).
      case 'addEvent': focusQuickAdd(); break
      // F-D1 (maint/dw 2026-09-23): sync is now a first-class in-app shortcut dispatched by the
      // main process's before-input-event table (the old Ctrl+S was a hardcoded keydown branch
      // below that ignored shortcutKeySettings.sync). Same feedback surface and in-flight guard.
      case 'sync': runSync(); break
    }
  })
  // Round-2 P1: existence-guarded (same rationale as onShortcutAction above).
  if (window.todoAPI.onSecurityLock) window.todoAPI.onSecurityLock(() => store.commit('ui/setLocked', true))
  if (window.todoAPI.onSecurityUnlock) window.todoAPI.onSecurityUnlock(() => store.commit('ui/setLocked', false))

  // Shortcuts: ctrl+n focuses quick-add / ctrl+z undo / ctrl+y·ctrl+shift+z redo (offline = local archive)
  // (Ctrl+S moved to the dispatched shortcut pipeline: shortcuts.js inApp table → case 'sync' above, F-D1)
  let syncInFlight = false
  const runSync = () => {
    // Key auto-repeat and in-flight sync would stack identical notifications: ignore re-triggers
    if (syncInFlight) return
    syncInFlight = true
    // Same feedback surface as the SideNav sync icon: success/error notify, never silent
    store.dispatch('todo/syncTodos').then(
      () => window.appUI.$notify({ title: i18n.global.t('statsE.SideNav.syncCompleteMsg'), message: i18n.global.t('statsG.SideNav.syncDoneMsg'), type: 'success', duration: 2000 }),
      e => window.appUI.$notify({ title: i18n.global.t('statsE.SideNav.syncFailedMsg'), message: (e && e.message) || i18n.global.t('statsG.SideNav.syncFailMsg'), type: 'error', duration: 4000 })
    ).finally(() => { syncInFlight = false })
  }
  window.addEventListener('keydown', e => {
    // Inside inputs/textareas, leave Ctrl+Z to text-level undo; don't steal it
    const ae = document.activeElement
    const inEditor = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
    if (e.ctrlKey && e.key.toLowerCase() === 'n') {
      e.preventDefault()
      focusQuickAdd()
    } else if (!inEditor && e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      store.dispatch('todo/undo').then(r => {
        const ok = r && r.ok
        const label = ok && r.label ? i18n.global.t('statsH.main.undoneLabel', { label: r.label }) : i18n.global.t(ok ? 'statsH.main.undone' : 'statsH.main.undoEmpty')
        window.appUI.$message[ok ? 'success' : 'info'](label)
      }).catch(e => {
        // P3-7 (maint/dw 2026-09-23): a real failure path (persistSnapshotDiff writes can throw) used
        // to die silently in the console while success/empty both toasted — surface it.
        console.error('[todo] undo failed:', e)
        window.appUI && window.appUI.$message && window.appUI.$message.error(i18n.global.t('statsH.main.actionFailedMsg') + ((e && e.message) || ''))
      })
    } else if (!inEditor && ((e.ctrlKey && e.key.toLowerCase() === 'y') || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault()
      store.dispatch('todo/redo').then(r => {
        const ok = r && r.ok
        const label = ok && r.label ? i18n.global.t('statsH.main.redoneLabel', { label: r.label }) : i18n.global.t(ok ? 'statsH.main.redone' : 'statsH.main.redoEmpty')
        window.appUI.$message[ok ? 'success' : 'info'](label)
      }).catch(e => {
        // P3-7: same honest failure toast as undo above
        console.error('[todo] redo failed:', e)
        window.appUI && window.appUI.$message && window.appUI.$message.error(i18n.global.t('statsH.main.actionFailedMsg') + ((e && e.message) || ''))
      })
    }
  })

  // Day-rollover refresh: full recompute only when tasks changed (dirty flag) or the calendar day rolled over, avoiding idle spinning every minute
  // Compare the full date string: getDate() only compares day-of-month, so a cross-month sleep (1st→2nd, same number) would miss it and freeze the Today page on the old month
  let lastComputedDay = new Date().toDateString()
  // [C5 fix] main-shell gate (same convention as the auto-backup loop): aux windows (tomato float,
  // quick-add) used to run this loop too — an extra full computeViews per minute per window, a second
  // driver racing the main window's recycle purge across midnight, and daySelectedTs commits in
  // windows that never show the picker. The float window already falls back to local candidate
  // computation when views are empty/lagging (TomatoFloatPage.vue), so gating is safe there.
  if (isMainShell) {
    setInterval(() => {
      const day = new Date().toDateString()
      const dayChanged = day !== lastComputedDay
      if (dayChanged) lastComputedDay = day
      // Midnight rollover: reset the selected day whenever it isn't "truly today" (previously only checked "exactly yesterday"; picking tomorrow/earlier then crossing a day left the page silently stuck on the old selection)
      if (dayChanged && store.state.ui.daySelectedTs) {
        const t0 = new Date(); t0.setHours(0,0,0,0)
        if (store.state.ui.daySelectedTs !== +t0) store.commit('ui/setDaySelected', 0)
      }
      // .catch: an async action rejection here would surface as an unhandled promise rejection every minute
      if (store.state.todo.viewsDirty || dayChanged) store.dispatch('todo/computeViews').catch(e => console.warn('[todo] periodic computeViews failed:', e))
    }, 60 * 1000)
  }

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
