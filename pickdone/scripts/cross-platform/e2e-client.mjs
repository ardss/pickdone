/* eslint-env node */
/**
 * Lane A cross-machine E2E client runner — runs on the CLIENT host against the
 * desktop bridge server. Prints one JSON result line per phase; exit code is the
 * number of failed phases (0 = all green).
 *
 * Usage: node e2e-client.mjs --host <ip> --port <n> --challenge '<challengeId>|<code>' \
 *          --device win-b [--csrf-from-pair]
 */
const args = process.argv.slice(2)
const val = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null }
const host = val('--host')
const port = Number(val('--port'))
const [challengeId, code] = (val('--challenge') || '|').split('|')
const device = val('--device') || 'win-b'

const base = `http://${host}:${port}`
const results = []
const phase = async (name, fn) => {
  try {
    const detail = await fn()
    results.push({ phase: name, ok: true, detail })
    console.log(JSON.stringify({ phase: name, ok: true, detail }))
  } catch (e) {
    results.push({ phase: name, ok: false, error: String(e && e.message || e) })
    console.log(JSON.stringify({ phase: name, ok: false, error: String(e && e.message || e) }))
  }
}
const post = async (path, body, headers = {}) => {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json() }
}

let t = null

await phase('hello', async () => {
  const res = await fetch(`${base}/crossplatform/hello`, { signal: AbortSignal.timeout(5000) })
  const j = await res.json()
  if (res.status !== 200 || j.service !== 'pickdone-crossplatform') throw new Error('bad hello: ' + res.status)
  return j
})

await phase('pair', async () => {
  const r = await post('/crossplatform/pair', { challengeId, code, deviceId: device })
  if (r.status !== 200 || !r.json.ok) throw new Error('pair failed: ' + r.status + ' ' + r.json.error)
  t = r.json
  return { scope: t.scope, expiresAt: t.expiresAt }
})
const auth = () => ({ Authorization: `Bearer ${t.token}`, 'X-PickDone-Request': t.csrfHeader, Origin: 'http://localhost:5173' })

await phase('push-create', async () => {
  const r = await post('/crossplatform/push', { deviceId: device, messageId: 'e2e-create-1', payload: { ops: [{ entity: 'todos', rows: [{ taskId: 'e2e-b-1', title: 'created on B', updatedAt: 1000, deleted: 0, deletedAt: 0 }] }] } }, auth())
  if (r.status !== 200 || r.json.result.results[0].outcomes[0].verdict !== 'applied') throw new Error('create failed: ' + JSON.stringify(r.json))
  return r.json.result.results[0].outcomes[0].verdict
})

await phase('push-edit', async () => {
  const r = await post('/crossplatform/push', { deviceId: device, messageId: 'e2e-edit-1', payload: { ops: [{ entity: 'todos', rows: [{ taskId: 'e2e-b-1', title: 'edited on B', updatedAt: 2000, deleted: 0, deletedAt: 0 }] }] } }, auth())
  if (r.status !== 200 || r.json.result.results[0].outcomes[0].verdict !== 'applied') throw new Error('edit failed: ' + JSON.stringify(r.json))
  return r.json.result.results[0].outcomes[0].verdict
})

await phase('push-delete-tombstone', async () => {
  const r = await post('/crossplatform/push', { deviceId: device, messageId: 'e2e-del-1', payload: { ops: [{ entity: 'todos', rows: [{ taskId: 'e2e-b-1', deleted: 1, deletedAt: 3000, updatedAt: 3000 }] }] } }, auth())
  const v = r.json.result && r.json.result.results[0].outcomes[0].verdict
  if (r.status !== 200 || !['applied', 'conflict_tombstone_wins'].includes(v)) throw new Error('delete failed: ' + JSON.stringify(r.json))
  return v
})

await phase('pull-verify', async () => {
  const r = await post('/crossplatform/pull', { deviceId: device, messageId: 'e2e-pull-1' }, auth())
  if (r.status !== 200) throw new Error('pull failed: ' + r.status)
  const todo = r.json.result.entities.todos.find(x => x.taskId === 'e2e-b-1')
  if (!todo || todo.deleted !== 1 || todo.deletedAt !== 3000) throw new Error('tombstone not visible on server: ' + JSON.stringify(todo))
  return { taskId: todo.taskId, deleted: todo.deleted, deletedAt: todo.deletedAt }
})

await phase('disconnect-retry-idempotent', async () => {
  // same messageId as push-create: the bridge must return the cached verdict, replay=true
  const r = await post('/crossplatform/push', { deviceId: device, messageId: 'e2e-create-1', payload: { ops: [{ entity: 'todos', rows: [{ taskId: 'e2e-b-1', title: 'created on B', updatedAt: 1000, deleted: 0, deletedAt: 0 }] }] } }, auth())
  if (r.status !== 200 || r.json.replay !== true) throw new Error('retry not idempotent: ' + JSON.stringify(r.json))
  return { replay: r.json.replay }
})

await phase('server-write-and-pull', async () => {
  // the desktop side writes through the repo directly (orchestrator does it server-side);
  // the client only verifies the locally-written row arrives on pull
  const r = await post('/crossplatform/pull', { deviceId: device, messageId: 'e2e-pull-2' }, auth())
  const todo = r.json.result.entities.todos.find(x => x.taskId === 'e2e-a-1')
  if (!todo || todo.title !== 'written on A') throw new Error('locally-written row missing on pull: ' + JSON.stringify(todo))
  return { taskId: todo.taskId, title: todo.title }
})

process.exit(results.filter(r => !r.ok).length)
