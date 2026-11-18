import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { formatTaskHandoff } from '../../../renderer/js/utils/taskHandoff.mjs'

const sample = {
  taskId: 'tid_840001AbC_123', taskContent: '标题 #开发', taskDescribe: '第一行\n第二行',
  complete: false, categoryId: 5, priority: 3, important: 1, urgent: 1,
  todoTime: 1795000000000, deadlineTs: 1795100000000,
  reminderTime: 1795001000000, reminderOffsets: [10, 30], reminderExtra: [1795102000000],
  repeatId: 'repeat-one', predecessors: '["task-pred"]',
  difficulty: 2, image: JSON.stringify([{name: '截图.png', url: 'local://screenshot%20one.png', size: 1234}]),
  files: JSON.stringify([{name: '需求.pdf',url:'local://spec.pdf',size: 554}]),
  subtasks: JSON.stringify([{text:'第一步',checked:true},{text:'第二步',checked:false}])
}
test('full task copy contains ID, original description, dates, subtasks and attachment references', () => {
  const text = formatTaskHandoff(sample, { categoryName: 'PickDone', estimate: 3 })
  for (const phrase of [
    'tid_840001AbC_123', '标题 #开发', '第一行\n第二行', 'PickDone', '#开发',
    '优先级: 3', '提前提醒(分钟): 10, 30', 'repeat-one', 'task-pred',
    '- [x] 1. 第一步', '- [ ] 2. 第二步', '截图.png', 'local://screenshot%20one.png',
    '需求.pdf', 'local://spec.pdf', '预计番茄: 3'
  ]) assert.ok(text.includes(phrase), phrase)
})
test('copy includes fresh unsaved panel fields and never leaks absolute file paths', () => {
  const text = formatTaskHandoff(sample, {
    draft: { title: '刚输入的标题', desc: '刚输入的内容', dateTs: 0 },
    images: [{name:'本地截图',url:'file:///C:/Users/private/data.png'}],
    files: [{name:'报告',url:'https://other.example/?token=secret'}],
    subtasks: [{text:'新增子项',checked:false}]
  })
  assert.ok(text.includes('刚输入的标题'))
  assert.ok(text.includes('刚输入的内容'))
  assert.ok(text.includes('新增子项'))
  assert.ok(text.includes('计划时间: 未设置'))
  assert.ok(!text.includes('file:///C:/'))
  assert.ok(!text.includes('token=secret'))
  assert.ok(!text.includes('userId:'))
  assert.ok(!text.includes('syncAuthor'))
})
test('invalid missing ID cannot produce falsely traceable copied task', () => {
  assert.throws(() => formatTaskHandoff({ taskContent: 'no ID' }), /Task ID/)
})
test('UI adds just the copy icon to existing footer and still has delete control', () => {
  const file = fileURLToPath(new URL('../../../renderer/js/components/EditPanel.vue', import.meta.url))
  const src = readFileSync(file, 'utf8')
  const footer = src.match(/<div class="ep-tools">([\s\S]*?)<\/div>/)?.[1] || ''
  assert.ok(footer.includes('class="ep-tool ep-copy"'))
  assert.ok(footer.includes('name="copy"'))
  assert.ok(footer.includes('copyTaskFull'))
  assert.ok(footer.includes('class="ep-tool danger"'))
  assert.ok(!footer.includes('复制给AI'))
})

test('copy includes every visible detail section including focus, repeat rule, and optional work records', () => {
  const text = formatTaskHandoff(sample, {
    categoryName: 'PickDone', categoryColor: '#5f9ea0',
    estimate: 4, actual: 2, repeatCount: 3,
    repeatRule: {type: 'weekly', interval: 1, days: [1, 3]},
    focusRecords: [{tomatoId: 'focus-abc', focusDuration: 25, succeed: true}],
    work: {
      episodes: [{episodeId:'ep-1',summary:'实现复制',role:'agent'}],
      findings: [{statement:'已验证剪贴板',confidence:'high'}],
      decisions: [{choice:'复用任务ID',decider:'human'}],
      sources: [{title:'设计图',canonicalUri:'source-example'}]
    }
  })
  for (const value of [
    '分类颜色: #5f9ea0', '已完成番茄: 2', '重复组任务数: 3',
    'weekly', 'focus-abc', 'ep-1', '已验证剪贴板',
    '复用任务ID', '设计图', '创建时间:', '最近修改:', '完成时间:'
  ]) assert.ok(text.includes(value), value)
})
