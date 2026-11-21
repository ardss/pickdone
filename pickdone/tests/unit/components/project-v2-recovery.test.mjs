import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { projectIdFromLegacy, projectKey, taskProjectKey, createLegacyProjectRecord,
  parseProjectRecord, quarantinedLegacyProjects } from '../../../shared/project-v2.mjs'

const make = createRequire(import.meta.url)('../../../cli/lib-project-v2.cjs')
const named = [
  {categoryId:10001,categoryName:'Kynoptic',createTime:3},
  {categoryId:10002,categoryName:'相鉴 PhotoAtlas',createTime:4},
  {categoryId:10003,categoryName:'SmartRing-AgentCompanion',createTime:5}
]
const bad=[{categoryId:10004,categoryName:''},{categoryId:10005,categoryName:null}]
const tasks=[
  {taskId:'tid_a',categoryId:10001,complete:false}, {taskId:'tid_b',categoryId:10001,complete:true},
  {taskId:'tid_c',categoryId:10002,complete:false},{taskId:'tid_d',categoryId:10003,complete:true},
  {taskId:'tid_ghost',categoryId:10004,complete:false}
]
function fixture(){
  const meta=new Map([['projectCategoryIds','[10001,10002,10003,10004,10005]']]);const writes=[]
  const lib={
    open:()=>({call:(op,arg)=>{
      if(op==='listMetaKeys')return [...meta.keys()]
      if(op==='getMeta')return meta.get(arg)||null
      if(op==='getAllCategories')return [...named,...bad]
      throw Error('unexpected read '+op)
    }}),
    getProjects:()=>named.map(c=>({categoryId:c.categoryId,name:c.categoryName,status:'active'})),
    getProjectIds:()=>[10001,10002,10003,10004,10005],
    liveTasks:()=>tasks,
    CliError:class extends Error {constructor(m,c){super(m);this.code=c}},
    commit:(entity,verb,args)=>{assert.equal(entity,'meta');assert.equal(verb,'put');writes.push(args);meta.set(...args)},
    audit:{record:()=>{}}
  }
  return {api:make({lib}),meta,writes}
}
test('independent entity identity and explicit membership keys',()=>{
  assert.equal(projectIdFromLegacy(10001),'prj_legacy_10001')
  assert.equal(projectKey('prj_legacy_10001'),'pd.project.v2:prj_legacy_10001')
  assert.equal(taskProjectKey('tid_a'),'pd.taskProject.v2:tid_a')
  assert.throws(()=>projectIdFromLegacy(-1))
  assert.throws(()=>createLegacyProjectRecord(bad[0]),/UNVERIFIED/)
  assert.equal(parseProjectRecord(JSON.stringify(createLegacyProjectRecord(named[0]))).name,'Kynoptic')
  assert.equal(parseProjectRecord('{}'),null)
})
test('anonymous projects are visible but never given fabricated names',()=>{
  const r=quarantinedLegacyProjects([...named,...bad],[10001,10002,10003,10004,10005],tasks)
  assert.deepEqual(r.map(x=>x.legacyCategoryId),['10004','10005'])
  assert.equal(r[0].taskCount,1);assert.equal(r[0].unfinishedCount,1)
  assert.equal(r[0].name,null)
})
test('dry-run, verified migration and idempotent replay',()=>{
  const {api,writes}=fixture()
  const dry=api.migrate()
  assert.deepEqual([dry.projectCount,dry.totalLinks,dry.unresolvedProjects,dry.unresolvedTaskCount],[3,4,2,1])
  assert.equal(writes.length,0)
  const live=api.migrate({yes:true})
  assert.deepEqual([live.wroteEntities,live.wroteLinks,live.verified],[3,4,true])
  assert.equal(writes.length,7)
  assert.deepEqual(api.list().map(x=>x.assignedTaskCount).sort(),[1,1,2])
  assert.deepEqual([api.migrate({yes:true}).wroteEntities,api.migrate({yes:true}).wroteLinks,writes.length],[0,0,7])
})
test('conflict is detected before any write',()=>{
  const {api,meta,writes}=fixture()
  meta.set('pd.taskProject.v2:tid_b','prj_some_other_project')
  assert.throws(()=>api.migrate({yes:true}),/task project conflict/)
  assert.equal(writes.length,0)
})
test('UI keeps unresolved project links available without remapping',()=>{
  const vue=readFileSync(new URL('../../../renderer/js/views/ProjectOverviewView.vue',import.meta.url),'utf8')
  assert.match(vue,/<details v-for="p in unresolvedLegacyProjects"/)
  assert.match(vue,/openRecoveredTask \(t\) \{ this\.\$store\.commit\('ui\/openEdit', t\)/)
})
test('data backup includes new independent entity/link keys',()=>{
  const f=readFileSync(new URL('../../../renderer/js/store/helpers/todoBackup.js',import.meta.url),'utf8')
  assert.match(f,/pd\.project\.v2:prj_legacy_/)
  assert.match(f,/pd\.taskProject\.v2:/)
})
