// Source-shape pin: boot ordering in src/main/index.js.
// reloadAll + Meta GC must run AFTER registerIpc()/extWatch.watchDbForExternalWrites()
// and BEFORE initLanSync, so first paint is not blocked by synchronous GC work and
// the bus fanout hooks are wired before the GC commits (perf-boot-gc-scheduler-before-registeripc).
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
