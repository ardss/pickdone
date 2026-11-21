import test from 'node:test'
import assert from 'node:assert/strict'
import projectV2 from '../../../renderer/js/store/projectV2.js'

function fixture (projects) {
  const meta = new Map(projects.map(p => ['pd.project.v2:' + p.projectId, JSON.stringify(p)]))
  globalThis.window = {
    commands: { commit: async (kind, verb, payload) => {
      assert.equal(kind, 'meta')
      if (verb === 'put') meta.set(payload[0], payload[1])
      else if (verb === 'delete') meta.delete(payload)
      else throw Error('UNEXPECTED_VERB:' + verb)
      return { results: [true], failedIndex: -1 }
    } },
    todoAPI: {
      dbCall: async (op, key) => {
        if (op === 'projectV2Keys') return [...meta.keys()]
        if (op === 'getMeta') return meta.get(key) ?? null
        throw Error('UNEXPECTED_DB_OP:' + op)
      },
      getMetaMany: async keys => keys.map(key => ({ key, value: meta.get(key) ?? null }))
    }
  }
  const state = projectV2.state()
  const commit = (action, payload) => projectV2.mutations[action](state, payload)
  const dispatch = (action, payload) => projectV2.actions[action](
    { state, commit, dispatch, rootState: { category: { list: [{ categoryId: 99, categoryName: 'Archived', delete: false }] }, todo: { todoList: [] } } },
    payload
  )
  return { meta, state, dispatch }
}
const sample = (projectId, name, deleted) => ({
  schemaVersion: 1, projectId, name, status: 'active', deleted, origin: 'native-project-v2'
})
test('archived project can restore from the same identity; no new entity', async () => {
  const x = fixture([sample('prj_test001', 'Archived', true)])
  await x.dispatch('refresh')
  assert.equal(projectV2.getters.all(x.state).length, 0)
  await assert.rejects(x.dispatch('update', { projectId: 'prj_test001', patch: { status: 'paused' } }), /PROJECT_V2_ARCHIVED_RESTORE_REQUIRED/)
  const r = await x.dispatch('update', { projectId: 'prj_test001', patch: { deleted: false } })
  assert.equal(r.deleted, false)
  assert.equal(projectV2.getters.all(x.state).length, 1)
  assert.equal(x.meta.size, 1)
  await x.dispatch('update', { projectId: 'prj_test001', patch: { deleted: true } })
  assert.equal(projectV2.getters.all(x.state).length, 0)
  await x.dispatch('update', { projectId: 'prj_test001', patch: { deleted: false } })
  assert.equal(projectV2.getters.all(x.state).length, 1)
})
test('archived same-name project cannot restore when active name now exists', async () => {
  const x = fixture([sample('prj_archive', 'Duplicated', true), sample('prj_active', 'Duplicated', false)])
  await x.dispatch('refresh')
  await assert.rejects(x.dispatch('update', { projectId: 'prj_archive', patch: { deleted: false } }), /PROJECT_V2_DUPLICATE_NAME/)
  assert.equal(JSON.parse(x.meta.get('pd.project.v2:prj_archive')).deleted, true)
})
test('category conversion restores an archived linked project rather than duplicating it', async () => {
  const x = fixture([sample('prj_legacy_99', 'Archived', true)])
  await x.dispatch('refresh')
  const r = await x.dispatch('fromCategory', { categoryId: 99 })
  assert.equal(r.projectId, 'prj_legacy_99')
  assert.equal(r.deleted, false)
  assert.equal(x.meta.size, 1)
})
