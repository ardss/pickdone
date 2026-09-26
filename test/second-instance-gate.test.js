/* round3-stability-finding-6 (2026-09-26): the inline second-instance handler called
 * showMainOrLock() unconditionally; an event arriving before app.whenReady() resolved reached
 * createMainWindow() -> new BrowserWindow, which Electron hard-throws before ready — the
 * escaping exception surfaced as a crash dialog on a plain double launch. The gate now lives
 * in src/main/second-instance-gate.js (wireSecondInstance) and defers show() until ready.
 * Plain Node with a fake app — no electron launch, no %APPDATA%.
 * Run directly: node --test test/second-instance-gate.test.js */
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { wireSecondInstance } = require('../pickdone/src/main/second-instance-gate.js')

function fakeApp ({ ready }) {
  const handlers = {}
  const resolvers = []
  return {
    handlers,
    on (ev, fn) { handlers[ev] = fn },
    isReady: () => ready,
    whenReady: () => new Promise(resolve => { resolvers.push(resolve) }),
    __resolveReady: () => resolvers.forEach(r => r())
  }
}

test('app already ready: show runs synchronously (behavior preserved)', () => {
  const app = fakeApp({ ready: true })
  let shown = 0
  wireSecondInstance(app, () => { shown++ })
  app.handlers['second-instance']()
  assert.equal(shown, 1, 'ready instance shows immediately, exactly as before the fix')
})

test('app NOT ready: show is deferred until whenReady resolves (THE FIX)', () => {
  const app = fakeApp({ ready: false })
  let shown = 0
  wireSecondInstance(app, () => { shown++ })
  app.handlers['second-instance']()
  assert.equal(shown, 0, 'show must NOT run before ready — the pre-fix path created BrowserWindow here and crashed')
  app.__resolveReady()
  // let the microtask queue drain
  return Promise.resolve().then(() => assert.equal(shown, 1, 'show runs once whenReady resolves'))
})

test('two events before ready collapse into shows after ready (no lost activation)', () => {
  const app = fakeApp({ ready: false })
  let shown = 0
  wireSecondInstance(app, () => { shown++ })
  app.handlers['second-instance']()
  app.handlers['second-instance']()
  app.__resolveReady()
  return Promise.resolve().then(() => assert.equal(shown, 2, 'every launch attempt surfaces the window after ready'))
})
