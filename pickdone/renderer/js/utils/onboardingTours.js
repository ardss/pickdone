/* Onboarding tours (Driver.js spotlight-style micro-guidance)
   Principle = contextual teaching: appears only the moment the need arises, each shown only once (ledgered in localStorage), re-viewable from the settings page.
   No full nanny tour — day one doesn't need the ledger taught; when users hit it on day three, someone will teach it (product positioning) */
import { tt } from './core.js'

const LS_KEY = 'onboardingToursSeen'
/* v0.1 release decision: auto micro-tours fully off (manual re-view entry kept). Restore = flip back to true */
const AUTO_TOURS_ENABLED = false
const T = (k) => `statsH.Onboarding.${k}`

function seenMap () {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') } catch (e) { return {} }
}
function markSeen (key) {
  const m = seenMap()
  m[key] = Date.now()
  try { localStorage.setItem(LS_KEY, JSON.stringify(m)) } catch (e) { /* ignore */ }
}
export function resetToursSeen () {
  try { localStorage.removeItem(LS_KEY) } catch (e) { /* ignore */ }
}

function driverFactory () {
  // IIFE mounts as window.driver = { js: { driver, ... } } (nested namespace)
  const ns = (window.driver && window.driver.js) || window['driver.js']
  if (!ns || !ns.driver) return null
  return ns.driver
}

/* Step definitions for each tour: steps whose element is missing are auto-skipped (doesn't blow up under differing view states) */
const TOURS = {
  /* Today page: two steps of the core loop — start focus + see your day */
  today: () => ({
    steps: [
      { element: '.tomato-timer__play', popover: { title: tt(T('focusTitle')), description: tt(T('focusDesc')), side: 'top', align: 'center' } },
      { element: '.day-rail', popover: { title: tt(T('railTitle')), description: tt(T('railDesc')), side: 'left', align: 'start' } }
    ]
  }),
  /* Task-row tomato pips: first lesson of the ledger concept after the first tomato is recorded */
  pips: () => ({
    steps: [
      { element: '.td-tomcount', popover: { title: tt(T('pipsTitle')), description: tt(T('pipsDesc')), side: 'top', align: 'center' } }
    ]
  }),
  /* Edit panel: the description area's image/attachment toolbar (tour of Plan B's unified entry) */
  editpanel: () => ({
    steps: [
      { element: '.ep-attach-bar', popover: { title: tt(T('attachTitle')), description: tt(T('attachDesc')), side: 'left', align: 'start' } }
    ]
  }),
}
/* Run a given tour; force=true ignores the "seen" ledger (settings-page re-view). Steps with missing elements are removed automatically */
export function runTour (key, force = false) {
  if (!TOURS[key]) return false
  if (!force && seenMap()[key]) return false
  const factory = driverFactory()
  if (!factory) return false
  const def = TOURS[key]()
  // Missing element = auto-skip under differing view states; steps without an element = centered notice, always kept (the journey completion page depends on it)
  const steps = (def.steps || []).filter(st => !st.element || document.querySelector(st.element))
  if (!steps.length) return false
  // driver.js@1.0.3: steps go through config, setSteps no longer exists
  // The spotlight blocks sight but not Tab: during a tour the main app shell goes inert (Tab/clicks can't get in); popups mounted on body are unaffected; restored on finish/close
  const appRoot = document.getElementById('app')
  if (appRoot) appRoot.setAttribute('inert', '')
  const releaseInert = () => { if (appRoot) appRoot.removeAttribute('inert') }
  const drv = factory({
    animate: true,
    allowClose: true,
    overlayOpacity: 0.6,
    showProgress: false,
    nextBtnText: tt(T('next')),
    prevBtnText: tt(T('prev')),
    doneBtnText: tt(T('done')),
    steps,
    onDestroy: () => releaseInert()
  })
  drv.drive()
  markSeen(key)
  return true
}

/* Trigger rule: pop only if unseen. Called by the view itself after mount; the delay belongs to the caller.
   On first launch there may be higher-priority popups (welcome wizard/yesterday's leftovers etc.) — the tour must wait until they've all exited before appearing,
   otherwise the spotlight mask blocks the wizard buttons, forming a three-layer popup storm (hit in dual-Persona testing) */
const BLOCKING_SELECTORS = '.ob-mask, .el-overlay-message-box, .modal-container, .driver-overlay'
/* Retry cap: infinitely re-queuing itself while the user keeps a modal open is pointless; give up after ~90 seconds (tried again next time the view is entered) */
const MAX_RETRIES = 30

export function maybeRunTour (key, delayMs = 1200, retries = 0) {
  if (!AUTO_TOURS_ENABLED) return
  if (seenMap()[key]) return
  setTimeout(() => {
    // Double-check: may have been manually seen from the settings page while waiting
    if (seenMap()[key]) return
    if (document.querySelector(BLOCKING_SELECTORS)) {
      if (retries < MAX_RETRIES) maybeRunTour(key, 3000, retries + 1)
      return
    }
    runTour(key, true)
  }, delayMs)
}

export function tourSeenState () { return seenMap() }


/* ============ First-run full journey (hands-on version) ============
   Not "read the instructions" but let the user actually do it once: preset sample task → create their own → click tomato to select → drag onto the timeline → start focus.
   Each completed action auto-advances to the next step; skip and next are always available, never trapping the user.
   No mask during the drag stage (the driver spotlight only lets through the highlighted element; dragging needs both ends interactive) — replaced by a persistent banner. */
const J_SEED_TEXT = () => tt(T('jSeedTask'))
const poll = (test, cb, interval = 400) => {
  const iv = setInterval(() => { let ok = false; try { ok = test() } catch (e) { /* empty */ } if (ok) { clearInterval(iv); cb() } }, interval)
  return iv
}
function journeyBanner (text, skipLabel, onSkip) {
  const el = document.createElement('div')
  el.className = 'tour-journey-banner'
  el.innerHTML = '<span>' + text + '</span><button type="button" class="tour-journey-skip">' + skipLabel + '</button>'
  document.body.appendChild(el)
  return el
}
export function runJourney (force = false) {
  if (!force && seenMap().journey) return false
  const factory = driverFactory()
  if (!factory) return false
  const inp = document.querySelector('.qa-input')
  if (!inp) return false // The journey can only run on the Today page (where the quick-add box exists)
  markSeen('journey')
  // Preset sample task (default schedule): created via the real input chain so the drag/tomato steps in focus have a real target; auto-retried once if it doesn't land
  const seedOnce = () => {
    inp.value = J_SEED_TEXT()
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    // QuickAdd listens for keyup.enter (with isComposing/229 guards); sending keydown would never create
    inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
  }
  if (!document.querySelector('.td-item')) {
    seedOnce()
    watch = poll(() => !!document.querySelector('.td-item'), () => {
      clearWatch()
      stageCreate()
    }, 300)
    // Sample task not landed within 2.4s = creation failed (input chain busy/view abnormal); retry once
    setTimeout(() => {
      if (!document.querySelector('.td-item') && !document.querySelector('.tour-journey-banner')) seedOnce()
    }, 2400)
    return true // stageCreate is relayed by the poll above
  }
  let drv = null
  let watch = null
  const clearWatch = () => { if (watch) { clearInterval(watch); watch = null } }
  let ending = false // × close = exit the whole journey (no relaying to the next stage); next-step/auto-advance is the only way forward
  const singleStep = (step, onDone, { doneLabel = false } = {}) => {
    clearWatch()
    if (drv) { try { drv.destroy() } catch (e) { /* empty */ } }
    // Mid-journey stages always show "Next" as the advance button: showing "Done" once made users think the journey had ended
    drv = factory({
      steps: [step],
      allowClose: true,
      overlayOpacity: 0.4,
      nextBtnText: doneLabel ? tt(T('done')) : tt(T('next')),
      doneBtnText: doneLabel ? tt(T('done')) : tt(T('next')),
      onDestroy: () => {
        clearWatch()
        if (!ending && onDone) onDone()
      },
      onNextClick: () => { drv.moveNext() },
      onCloseClick: () => finishAll()
    })
    drv.drive()
    return drv
  }
  const finishAll = () => {
    ending = true
    clearWatch()
    if (drv) { try { drv.destroy() } catch (e) { /* empty */ } drv = null }
    const b = document.querySelector('.tour-journey-banner')
    if (b) b.remove()
  }
  // Stage E: completion page (re-view entry)
  const stageDone = () => {
    singleStep({ popover: { title: tt(T('jDoneTitle')), description: tt(T('jDoneDesc')) } }, finishAll, { doneLabel: true })
  }
  // Stage D: start focus (click play; auto-advances once --work appears)
  const stageFocus = () => {
    const d = singleStep({ element: '.tomato-timer__play', popover: { title: tt(T('jFocusTitle')), description: tt(T('jFocusDesc')), side: 'top', align: 'center' } }, stageDone)
    watch = poll(() => !!document.querySelector('.tomato-timer__play--work'), () => { clearWatch(); stageDone() })
    void d
  }
  // Stage C: drag to schedule (no-mask banner; auto-advances when the task lands on the rail; "skip this step" also works)
  const stageDrag = () => {
    const b = journeyBanner(tt(T('jDragBanner')), tt(T('jSkipStep')), () => { b.remove(); stageFocus() })
    watch = poll(() => !!document.querySelector('.day-rail .pd-task-item'), () => { b.remove(); stageFocus() })
  }
  // Stage B: select the sample task (wait for the row-end tomato to render first, then attach the active listener)
  const stagePick = () => {
    clearWatch()
    watch = poll(() => !!document.querySelector('.td-tom'), () => {
      clearWatch()
      if (drv) drv.destroy()
      singleStep({ element: '.td-tom', popover: { title: tt(T('jPickTitle')), description: tt(T('jPickDesc')), side: 'top', align: 'center' } }, stageDrag)
      watch = poll(() => !!document.querySelector('.td-tom.active'), () => { clearWatch(); stageDrag() })
    })
  }
  // Stage A: create your own task (task count growing above baseline = user-created, auto-advance; baseline is snapshotted only after the sample task renders, so the seed isn't mistaken for user creation)
  const stageCreate = () => {
    const armGrowth = () => {
      const baseCount = document.querySelectorAll('.td-item').length
      watch = poll(() => document.querySelectorAll('.td-item').length > baseCount, () => { clearWatch(); stagePick() })
    }
    if (document.querySelector('.td-item')) { armGrowth(); return }
    watch = poll(() => !!document.querySelector('.td-item'), () => { clearWatch(); armGrowth() })
    singleStep({ element: '.qa-input', popover: { title: tt(T('jCreateTitle')), description: tt(T('jCreateDesc')), side: 'bottom', align: 'start' } }, stagePick)
  }
  // Start once the quick-add box is ready
  watch = poll(() => !!document.querySelector('.qa-input'), () => { clearWatch(); stageCreate() })
  return true
}
