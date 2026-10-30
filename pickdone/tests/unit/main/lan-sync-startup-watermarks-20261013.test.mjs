import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Execute the actual init prefix in isolation. The private setting reader in
// lan-sync-bootstrap.js dereferences state.db, so the state must be initialized
// BEFORE createTrackedWatermarks reads the persisted settings.
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../src/main/lan-sync-bootstrap.js'), 'utf8')
const start = src.indexOf('function initLanSync (')
const stop = src.indexOf('  registerOps()', start)
assert(start >= 0 && stop > start, 'LAN init source boundary missing')

test('LAN cold boot seeds durable per-peer progress instead of reading null state.db', () => {
  const steps = []
  const db = {call(op, args) {
    steps.push([op,args])
    assert.equal(op, 'settingsRowsAll')
    return [{key:'sync.peerWatermarks.v2',value:'{"existing-peer":17}',deleted:false}]
  }}
  const initPrefix = src.slice(start, stop) + '\n}'
  const getState = new Function('db', `
    let state = null
    const createTrackedWatermarks = () => {
      const rows = state.db.call('settingsRowsAll', {})
      const row = rows.find(r => r.key === 'sync.peerWatermarks.v2')
      return new Map(Object.entries(JSON.parse(row.value)))
    }
    ${initPrefix}
    initLanSync({db,getWindowSenders:()=>[]})
    return state
  `)
  const state = getState(db)
  assert.equal(state.db,db)
  assert.equal(state.peerWatermarks.get('existing-peer'),17)
  assert.equal(steps.length,1)
})
