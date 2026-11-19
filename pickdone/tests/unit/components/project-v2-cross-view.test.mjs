import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url)
const Database = require('../../../vendor/better-sqlite3-multiple-ciphers')
const { queryEpisodesByCategory } = require('../../../src/main/db-episode-ops.cjs')

test('project handoff SQL uses explicit project link, not category equality', () => {
  const db = new Database(':memory:')
  try {
    db.exec("CREATE TABLE todos(id TEXT PRIMARY KEY, content TEXT, categoryId INTEGER, deleted INTEGER DEFAULT 0);"+
      "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);"+
      "CREATE TABLE work_episodes(id TEXT PRIMARY KEY,taskId TEXT,startedAt INTEGER,note TEXT,deleted INTEGER DEFAULT 0)")
    const ins = db.prepare('INSERT INTO todos(id,content,categoryId,deleted) VALUES (?,?,?,0)')
    ins.run('tid_one','Explicit membership in another category',1)
    ins.run('tid_two','Same category without project membership',1)
    ins.run('tid_three','Same project in a different category',2)
    db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('pd.taskProject.v2:tid_one','prj_aaa')
    db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('pd.taskProject.v2:tid_three','prj_aaa')
    db.prepare('INSERT INTO work_episodes(id,taskId,startedAt,note) VALUES (?,?,?,?)')
      .run('ep_a','tid_one',100,'goal: explicit task')
    const v2 = queryEpisodesByCategory(db,'prj_aaa')
    assert.deepEqual(new Set(v2.tasks.map(t => t.taskId)),new Set(['tid_one','tid_three']))
    assert.equal(v2.recent.length,1)
    assert.equal(v2.tasks.find(x=>x.taskId==='tid_one').episodeCount,1)
    assert.deepEqual(new Set(queryEpisodesByCategory(db,1).tasks.map(t=>t.taskId)),new Set(['tid_one','tid_two']))
    assert.deepEqual(queryEpisodesByCategory(db,'prj_nonexistent').tasks,[])
  } finally { db.close() }
})
test('all desktop project views use V2 membership and production writes',()=>{
  const base=new URL('../../../renderer/js/',import.meta.url)
  const read=x=>readFileSync(new URL(x,base),'utf8')
  const overview=read('views/ProjectOverviewView.vue')
  const detail=read('views/ProjectView.vue')
  const panel=read('components/EditPanel.vue')
  const deps=read('components/DepView.vue')
  const category=read('components/side-nav/SnManageCategoriesModal.vue')
  const source=read('store/projectV2.js')
  assert.match(overview,/\['projectV2\/all'\]/)
  assert.match(overview,/projectV2\/create/)
  assert.match(overview,/projectV2\/recoverLegacy/)
  assert.match(detail,/projectV2\/tasksOf/)
  assert.match(detail,/projectV2\/update/)
  assert.match(detail,/:cat-id="projectId"/)
  assert.match(deps,/fixedProjectId: \{ type: \[Number, String\]/)
  assert.match(deps,/taskProjects/)
  assert.match(panel,/projectV2\/assign/)
  assert.match(category,/projectV2\/fromCategory/)
  assert.doesNotMatch(category,/this\.\$store\.commit\('category\/setProject'/)
  assert.match(source,/verifiedPut/)
  assert.match(source,/projectV2Keys/)
  assert.match(source,/async recoverLegacy/)
})
test('CLI legacy project reads delegate to project-v2, never legacy category flags',()=>{
  const file=readFileSync(new URL('../../../cli/lib-taxonomy.cjs',import.meta.url),'utf8')
  const chunk=file.split('function runProjects ({ opts, lib, emit }) {')[1]?.split('function runMilestone')[0]
  assert.ok(chunk)
  assert.match(chunk,/require\('\.\/lib-project-v2\.cjs'\)/)
  assert.doesNotMatch(chunk,/lib\.getProjects\(\)/)
  assert.doesNotMatch(chunk,/lib\.setProjectFlag\(/)
})
