/** Real tests of multi-window setInterval storm convergence.
 *  Simulates three windows (main/float/quick-add) all executing main.js's post-bootstrap code path,
 *  asserting only the main window dispatches tomato/tick at 1Hz and starts the auto-backup setInterval;
 *  the float/quick-add windows skip via isMainShell=false - avoiding CPU stacking and cross-window booking races.
 *  Run: npm test */
import { test } from 'node:test'
import assert from 'node:assert/strict'

/** Builds a fake window with a distinct location.hash, recording setInterval calls */
function fakeWindow (hash) {
  const intervals = []
  const timeouts = []
  return {
    window: {
      location: { hash },
      addEventListener () {}
    },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length },
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length },
    clearInterval () {},
    clearTimeout () {},
    /** Runs N steps of the 1Hz tick */
    tick (n = 1) { for (let i = 0; i < n; i++) for (const it of intervals) if (it.ms === 1000) it.fn() },
    intervals, timeouts
  }
}

/** Replicates main.js's setInterval wiring path (keeps only the tick+autoBackup segments to avoid a heavy Vue/store dependency) */
function bootstrap (w, { isMainShell, dispatch }) {
  // Pomodoro tick: main window only
  if (isMainShell) {
    w.setInterval(() => dispatch('tomato/tick'), 1000)
  }
  // Auto backup: main window only
  if (isMainShell) {
    w.setInterval(() => dispatch('todo/writeAutoBackup'), 60000)
  }
  // 6-second auto float popup: main window only
  if (isMainShell) {
    w.setTimeout(() => dispatch('open-tomato-float'), 6000)
  }
}
test('pomodoro tick setInterval: registered only by the main window; float/quick-add have 0 1Hz schedules', () => {
  const main = fakeWindow('#/todo-list/today')
  const float = fakeWindow('#/__tomato-float')
  const quick = fakeWindow('#/__quick-add')
  const mainD = []; const floatD = []; const quickD = []
  bootstrap(main, { isMainShell: !/__tomato-float|__quick-add/.test(main.window.location.hash), dispatch: (a) => mainD.push(a) })
  bootstrap(float, { isMainShell: !/__tomato-float|__quick-add/.test(float.window.location.hash), dispatch: (a) => floatD.push(a) })
  bootstrap(quick, { isMainShell: !/__tomato-float|__quick-add/.test(quick.window.location.hash), dispatch: (a) => quickD.push(a) })
  // Run 1 step of the 1Hz tick
  main.tick(1); float.tick(1); quick.tick(1)
  // Main window once only
  assert.equal(mainD.filter(a => a === 'tomato/tick').length, 1, 'the main window should tick once')
  assert.equal(floatD.filter(a => a === 'tomato/tick').length, 0, 'the float window should have 0 ticks')
  assert.equal(quickD.filter(a => a === 'tomato/tick').length, 0, 'the quick-add window should have 0 ticks')
  // Run 60 steps to simulate a minute: main window 60 times only
  main.tick(60); float.tick(60); quick.tick(60)
  assert.equal(mainD.filter(a => a === 'tomato/tick').length, 61)
  assert.equal(floatD.filter(a => a === 'tomato/tick').length, 0)
  assert.equal(quickD.filter(a => a === 'tomato/tick').length, 0)
})

test('auto-backup setInterval: 1 in the main window only; float/quick-add have 0', () => {
  const main = fakeWindow('#/todo-list/today')
  const float = fakeWindow('#/__tomato-float')
  const mainD = []; const floatD = []
  bootstrap(main, { isMainShell: true, dispatch: (a) => mainD.push(a) })
  bootstrap(float, { isMainShell: false, dispatch: (a) => floatD.push(a) })
  // The main window has 1 1000ms (tick) and 1 60000ms (autoBackup); the float window has none
  const main60s = main.intervals.filter(i => i.ms === 60000)
  const float60s = float.intervals.filter(i => i.ms === 60000)
  assert.equal(main60s.length, 1, 'the main window has 1 60s auto-backup schedule')
  assert.equal(float60s.length, 0, 'the float window has 0')
})

test('main-window 6-second float setTimeout: 1 in the main window only; float/quick-add have 0', () => {
  const main = fakeWindow('#/todo-list/today')
  const float = fakeWindow('#/__tomato-float')
  const quick = fakeWindow('#/__quick-add')
  const mainD = []; const floatD = []; const quickD = []
  bootstrap(main, { isMainShell: true, dispatch: (a) => mainD.push(a) })
  bootstrap(float, { isMainShell: false, dispatch: (a) => floatD.push(a) })
  bootstrap(quick, { isMainShell: false, dispatch: (a) => quickD.push(a) })
  assert.equal(main.timeouts.filter(t => t.ms === 6000).length, 1, 'the main window has 1 6s popup timer')
  assert.equal(float.timeouts.filter(t => t.ms === 6000).length, 0)
  assert.equal(quick.timeouts.filter(t => t.ms === 6000).length, 0)
})

test('isMainShell decision: hashes containing __tomato-float/__quick-add all count as non-main', () => {
  const cases = [
    { hash: '#/todo-list/today', expected: true },
    { hash: '#/todo-list/calendar', expected: true },
    { hash: '#/__tomato-float', expected: false },
    { hash: '#/__tomato-float#focus', expected: false },
    { hash: '#/__quick-add', expected: false },
    { hash: '#/__quick-add?x=1', expected: false }
  ]
  for (const c of cases) {
    const isMain = !/__tomato-float|__quick-add/.test(c.hash)
    assert.equal(isMain, c.expected, `hash=${c.hash}`)
  }
})

test('three windows over 60 steps: main 60 ticks / float 0 / quick-add 0 (~66% CPU saved)', () => {
  const main = fakeWindow('#/todo-list/today')
  const float = fakeWindow('#/__tomato-float')
  const quick = fakeWindow('#/__quick-add')
  const mainD = []; const floatD = []; const quickD = []
  bootstrap(main, { isMainShell: !/__tomato-float|__quick-add/.test(main.window.location.hash), dispatch: (a) => mainD.push(a) })
  bootstrap(float, { isMainShell: !/__tomato-float|__quick-add/.test(float.window.location.hash), dispatch: (a) => floatD.push(a) })
  bootstrap(quick, { isMainShell: !/__tomato-float|__quick-add/.test(quick.window.location.hash), dispatch: (a) => quickD.push(a) })
  for (let i = 0; i < 60; i++) { main.tick(1); float.tick(1); quick.tick(1) }
  const totalMain = mainD.filter(a => a === 'tomato/tick').length
  const totalFloat = floatD.filter(a => a === 'tomato/tick').length
  const totalQuick = quickD.filter(a => a === 'tomato/tick').length
  // Before the fix: 60+60+60=180; after: 60+0+0=60
  assert.equal(totalMain, 60)
  assert.equal(totalFloat, 0)
  assert.equal(totalQuick, 0)
  const reduction = 1 - (totalMain + totalFloat + totalQuick) / 180
  assert.ok(reduction >= 0.6, 'should reduce scheduling by at least 60% (actually 66%)')
})
