/**
 * Portable text snapshot for handing a PickDone task to a human or AI.
 * No filesystem paths, no DB writes, no image bytes.
 */
const asArray = value => {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return []
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
}
const field = value => value == null || value === '' ? '未设置' : String(value)
const when = value => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? new Date(n).toLocaleString('zh-CN', { hour12: false }) : '未设置'
}
const tagsOf = text => [...new Set([...String(text || '').matchAll(/(?:^|\s)#([^\s#]+)/gu)].map(m => m[1]))]
const safeAttachmentUrl = value => {
  const url = String(value || '')
  return /^local:\/\/[^/\s\\?#]+$/i.test(url) ? url : ''
}
const attachmentLines = (items, noun) => {
  const rows = asArray(items)
  if (!rows.length) return ['- 无']
  return rows.map((item, index) => {
    const a = item && typeof item === 'object' ? item : { name: String(item || '') }
    const name = String(a.name || noun + (index + 1)).replace(/[\r\n]+/g, ' ')
    const url = safeAttachmentUrl(a.url)
    const size = Number.isFinite(Number(a.size)) && Number(a.size) >= 0 ? '；大小 ' + a.size + ' 字节' : ''
    return '- ' + (index + 1) + '. ' + name + size + (url ? '；引用 ' + url : '；无可共享引用')
  })
}
const subtaskLines = (value) => asArray(value).map((s, i) => {
  const item = s && typeof s === 'object' ? s : { text: String(s || '') }
  return '- [' + (item.checked || item.complete ? 'x' : ' ') + '] ' + (i + 1) + '. ' + String(item.text || item.content || '')
})
const dateSequence = value => asArray(value).map(when)

export function formatTaskHandoff (task, options = {}) {
  if (!task || !task.taskId) throw new Error('Task ID is required to copy a handoff')
  const edit = options.draft || {}
  const title = edit.title !== undefined ? edit.title : task.taskContent
  const description = edit.desc !== undefined ? edit.desc : task.taskDescribe
  const date = edit.dateTs !== undefined ? edit.dateTs : task.todoTime
  const reminder = edit.remindTs !== undefined ? edit.remindTs : task.reminderTime
  const priority = edit.priority !== undefined ? edit.priority : task.priority
  const important = edit.important !== undefined ? edit.important : task.important
  const subtasks = options.subtasks ?? edit.sublist ?? task.subtasks
  const images = options.images ?? edit.todoImageList ?? task.image
  const files = options.files ?? edit.fileList ?? task.files
  const offsets = edit.reminderOffsets ?? task.reminderOffsets
  const extra = edit.reminderExtra ?? task.reminderExtra
  const tags = tagsOf(String(title || '') + '\n' + String(description || ''))
  const subs = subtaskLines(subtasks)
  const lines = [
    '[PickDone-Task-Handoff/v1]',
    '任务ID: ' + task.taskId,
    '标题: ' + field(title),
    '状态: ' + (task.complete ? '已完成' : '未完成'),
    '创建时间: ' + when(task.createTime),
    '最近修改: ' + when(task.updateTime),
    '完成时间: ' + when(task.completedAt),
    '分类: ' + field(options.categoryName || task.categoryName),
    '分类颜色: ' + field(options.categoryColor),
    '标签: ' + (tags.length ? tags.map(t => '#' + t).join(' ') : '无'),
    '优先级: ' + field(priority),
    '重要: ' + (important ? '是' : '否') + '；紧急: ' + (task.urgent ? '是' : '否'),
    '难度: ' + field(task.difficulty ?? 0),
    '预计番茄: ' + field(options.estimate ?? task.tomatoEstimate ?? 0),
    '已完成番茄: ' + field(options.actual ?? 0),
    '计划时间: ' + when(date),
    '截止日期: ' + when(edit.deadlineTs ?? task.deadlineTs),
    '提醒时间: ' + when(reminder),
    '提前提醒(分钟): ' + (asArray(offsets).join(', ') || '无'),
    '其他提醒: ' + (dateSequence(extra).join('; ') || '无'),
    '重复组ID: ' + field(edit.repeatId ?? task.repeatId),
    '重复组任务数: ' + field(options.repeatCount ?? 0),
    '重复规则: ' + (options.repeatRule && typeof options.repeatRule === 'object' ? JSON.stringify(options.repeatRule) : field(options.repeatRule)),
    '前置任务ID: ' + (asArray(task.predecessors).join(', ') || '无'),
    '',
    '## 任务描述（原文）',
    description || '（无）',
    '',
    '## 子任务',
    ...(subs.length ? subs : ['- 无']),
    '',
    '## 图片',
    ...attachmentLines(images, '图片'),
    '',
    '## 文件附件',
    ...attachmentLines(files, '附件'),
    '',
    '## 任务专注记录',
    options.focusRecords ? JSON.stringify(options.focusRecords, null, 2) : '无',
    '',
    '## 已启用的工作连续性内容',
    options.work ? JSON.stringify(options.work, null, 2) : '未启用',
    '',
    '## 给执行者',
    '本卡是复制时的任务快照；有 PickDone CLI 权限时请按唯一任务ID读取最新内容：pickdone get ' + task.taskId + ' --json',
    '图片和附件只记录受控引用，不包含二进制内容；如无法访问原设备，请要求用户另外发送附件。',
    '处理结果可使用现有 CLI 更新任务描述；满足验收条件后再勾选任务并回读确认。'
  ]
  return lines.join('\n')
}
