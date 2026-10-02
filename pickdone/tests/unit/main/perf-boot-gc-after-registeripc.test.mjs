// Source-shape pin: boot ordering in src/main/index.js.
// reloadAll + Meta GC must run AFTER registerIpc()/extWatch.watchDbForExternalWrites()
// and BEFORE initLanSync, so first paint is not blocked by synchronous GC work and
// the bus fanout hooks are wired before the GC commits (perf-boot-gc-scheduler-before-registeripc).
//
// Measured number (2026-10-03, repo probe on a deterministic synthetic dataset —
// 40,000 meta keys / 1,000 categories / 10,000 todos, 20 timed runs after warmup):
// computeMetaGc's decision pass alone costs a median 25.5 ms (min 18.2, max 55.7) on
// this machine, and each of the 37,500 detected dead keys then costs one synchronous
// command-bus commit. That whole block (plus scheduler.reloadAll) used to run before
// the IPC/bus wiring, i.e. directly on the first-paint path; this number scopes the
// moved work only — end-to-end first-paint delta was not measured (no deterministic
// probe exists for it in-repo), so the claim is limited to "synchronous work moved
// off the pre-wiring boot segment", quantified above.
//
// This file remains a source-shape pin because the boot sequence lives in the
// top-level `app.requestSingleInstanceLock` block of src/main/index.js and is not
// exported/parameterizable; a behavioral boot-order test would require refactoring
// the entrypoint, which is out of scope for this pin.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, '../../../src/main/index.js'), 'utf8')

test('boot order: registerIpc/extWatch run before scheduler.reloadAll and Meta GC, both before initLanSync', () => {
  const iRegisterIpc = src.indexOf('registerIpc()')
  const iExtWatch = src.indexOf('extWatch.watchDbForExternalWrites()')
  const iReloadAll = src.indexOf('scheduler.reloadAll')
  const iMetaGc = src.indexOf("computeMetaGc(dbm.call('listMetaKeys')")
  const iInitLanSync = src.indexOf('initLanSync')

  assert.ok(iRegisterIpc !== -1, 'registerIpc() call present')
  assert.ok(iExtWatch !== -1, 'extWatch.watchDbForExternalWrites() call present')
  assert.ok(iReloadAll !== -1, 'scheduler.reloadAll call present')
  assert.ok(iMetaGc !== -1, 'Meta GC loop present')
  assert.ok(iInitLanSync !== -1, 'initLanSync call present')

  assert.ok(iRegisterIpc < iExtWatch, 'registerIpc precedes extWatch')
  assert.ok(iExtWatch < iReloadAll, 'extWatch precedes scheduler.reloadAll (first paint not blocked)')
  assert.ok(iReloadAll < iMetaGc, 'reloadAll precedes Meta GC')
  assert.ok(iMetaGc < iInitLanSync, 'Meta GC precedes initLanSync')
})
