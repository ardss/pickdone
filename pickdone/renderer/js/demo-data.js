/**
 * Full-feature demo data for the browser debug host (5175) — for thorough manual walkthrough of every page.
 * Usage (console or IAB): (await import('/demo-data.js')).seed()
 * Idempotent: repeated runs first clear the previous round (seed_v3 registry); tomato/habit check-ins are seeded only once.
 * Covers: categories/project folders/today's multi tasks (time+subtasks+tags+priority+estimated tomatoes)/future schedule/
 *       overdue incomplete/30-day completed history/todo box/recycle bin/30 days of tomato focus records (incl. give-ups)/habit check-in history.
 */
const DAY = 86400000
const REG_KEY = 'demoSeedV3'
const TOMATO_FLAG = 'demoTomatoSeededV4'

const dkey = ts => window.dayjs(ts).format('YYYY-MM-DD')

async function purgeOld (store, reg) {
  const ids = reg.taskIds || []
  const alive = store.state.todo.todoList.filter(t => ids.includes(t.taskId)).map(t => t.taskId)
    .concat(store.state.todo.recycleList.filter(t => ids.includes(t.taskId)).map(t => t.taskId))
  if (!alive.length) return
  // purgeIds has no corresponding channel in the 5175 shim; hardDelete clears the shim storage, removeLocal clears the Vuex side, then recompute views
  await window.todoAPI.dbCall('hardDelete', alive)
  for (const id of alive) store.commit('todo/removeLocal', id)
  await store.dispatch('todo/computeViews')
}

export async function seed () {
  const el = document.querySelector('#app')
  const store = el.__vue_app__._context.config.globalProperties.$store
  window.__store = store
  let reg
  try { reg = JSON.parse(localStorage.getItem(REG_KEY)) || {} } catch { reg = {} }

  await purgeOld(store, reg)
  // Empty the recycle bin (demo environment: orphan soft-deleted rows from previous rounds are cleared too)
  const recycleIds = store.state.todo.recycleList.map(t => t.taskId)
  if (recycleIds.length) {
    await window.todoAPI.dbCall('hardDelete', recycleIds)
    for (const id of recycleIds) store.commit('todo/removeLocal', id)
    await store.dispatch('todo/computeViews')
  }
  const taskIds = []

  // —— Categories + project folders (idempotent: same id overwrites) ——
  const uid = (store.state.auth.user && store.state.auth.user.userId) || 840001
  const now = Date.now()
  const cats = [
    { categoryId: 9101, userId: uid, categoryName: '工作', categoryColor: '#4076C4', createTime: now, listSort: 901, folderIs: false, folderId: 0, deleted: false },
    { categoryId: 9102, userId: uid, categoryName: '学习', categoryColor: '#519A54', createTime: now, listSort: 902, folderIs: false, folderId: 0, deleted: false },
    { categoryId: 9103, userId: uid, categoryName: '生活', categoryColor: '#D9982F', createTime: now, listSort: 903, folderIs: false, folderId: 0, deleted: false },
    { categoryId: 9201, userId: uid, categoryName: '产品发布', categoryColor: '#7E57C2', createTime: now, listSort: 910, folderIs: true, folderId: 0, deleted: false }
  ]
  for (const c of cats) await window.todoAPI.dbCall('upsertCategory', c)

  const today = store.state.todo.todayTimestamp || +window.dayjs().startOf('day')
  const at = (dayOffset, h = 0, m = 0) => today + dayOffset * DAY + h * 3600000 + m * 60000

  const add = async (content, opt = {}) => {
    const t = await store.dispatch('todo/addTodo', {
      todoContent: content,
      todoDate: opt.date != null ? opt.date : today,
      todoTime: opt.time || 0,
      categoryId: opt.cat || 0,
      estimate: opt.snow || 0,
      todoSublist: opt.subs || null,
      addToTop: false
    })
    const id = (t && t.taskId) || t
    taskIds.push(id)
    const patch = {}
    if (opt.priority) { patch.priority = opt.priority; patch.important = opt.priority >= 3; }
    if (Object.keys(patch).length) await store.dispatch('todo/updateTodoFields', { taskId: id, patch })
    return id
  }

  // —— Today's 12 entries (tags/time/subtasks/priority/estimated tomatoes all covered) ——
  await add('整理季度报表 #工作', { cat: 9101, time: at(0, 9, 30), snow: 3, priority: 3 })
  await add('回复客户邮件 #工作', { cat: 9101, time: at(0, 11, 0) })
  await add('写周报 #工作', { cat: 9101, time: at(0, 16, 0), snow: 2 })
  await add('评审产品发布清单', { cat: 9201, time: at(0, 14, 0), priority: 3, snow: 2 })
  await add('准备发布会讲稿 #工作', { cat: 9201, snow: 4 })
  await add('英语阅读 30 分钟 #学习 #读书', { cat: 9102, time: at(0, 8, 0) })
  await add('刷算法题两道 #学习', { cat: 9102, snow: 2 })
  await add('看《深入浅出统计学》第 3 章 #读书', { cat: 9102 })
  await add('超市采购(牛奶/鸡蛋/咖啡)', { cat: 9103, time: at(0, 18, 30) })
  await add('给爸妈打电话', { cat: 9103 })
  await add('预约牙医', { cat: 9103, subs: [{ text: '查附近诊所', checked: true }, { text: '打电话约时间', checked: false }, { text: '加日历提醒', checked: false }] })
  await add('晚上跑步 5 公里', { cat: 9103, subs: [{ text: '换装备', checked: false }, { text: '拉伸', checked: false }] })

  // —— Tomorrow/day after/this week/next week ——
  await add('明天 团队周会 #工作', { cat: 9101, date: at(1, 10, 0), time: at(1, 10, 0) })
  await add('明天 交房租', { cat: 9103, date: at(1), priority: 3 })
  await add('明天 复习笔记 #学习', { cat: 9102, date: at(1) })
  await add('明天 买生日礼物', { cat: 9103, date: at(1) })
  await add('后天 项目排期评审 #工作', { cat: 9201, date: at(2, 15, 0), time: at(2, 15, 0), snow: 2 })
  await add('后天 还书去图书馆 #读书', { cat: 9102, date: at(2) })
  await add('后天 体检报告解读', { cat: 9103, date: at(2) })
  await add('周五 需求评审会 #工作', { cat: 9101, date: at(4, 14, 0), time: at(4, 14, 0) })
  await add('周六 爬山', { cat: 9103, date: at(5) })
  await add('周日 每周复盘 #学习', { cat: 9102, date: at(6) })
  await add('下周三 官网文案终稿', { cat: 9201, date: at(9), snow: 3 })
  await add('下周五 数据复盘月报', { date: at(11), snow: 2 })

  // —— Overdue incomplete (past 1~6 days, for incomplete-group/reschedule drills) ——
  await add('逾期 提交报销单 #工作', { cat: 9101, date: at(-2), priority: 3 })
  await add('逾期 修水槽', { cat: 9103, date: at(-4) })
  await add('逾期 背 50 个单词 #学习', { cat: 9102, date: at(-1) })
  await add('逾期 预约理发', { cat: 9103, date: at(-6) })

  // —— Completed history (past 30 days, ~40 entries, backing the achieved page/stats page/calendar completed) ——
  const donePool = [
    ['每日站会 #工作', 9101], ['处理工单 #工作', 9101], ['写日报 #工作', 9101],
    ['晨读 20 分钟 #学习 #读书', 9102], ['网课一节 #学习', 9102], ['背单词 #学习', 9102],
    ['做饭', 9103], ['散步 30 分钟', 9103], ['收拾房间', 9103], ['记账', 9103]
  ]
  for (let d = 1; d <= 30; d++) {
    const n = 1 + (d % 3)
    for (let k = 0; k < n; k++) {
      const [c, cat] = donePool[(d * 3 + k) % donePool.length]
      const id = await add(d + '天前 ' + c, { cat, date: at(-d, 9 + k * 3) })
      await store.dispatch('todo/updateTodoFields', { taskId: id, patch: { complete: true, completedAt: at(-d, 10 + k * 4, 24) } })
    }
  }

  // —— Todo box (no date) ——
  await add('想法:写一篇番茄工作法实践文 #学习')
  await add('想法:给 CLI 加 filter 命令')
  await add('有空时看看 WWDC 回放 #学习')
  await add('翻新书单:《卡片笔记写作法》 #读书')
  await add('研究一下地铁卡换新')
  await add('灵感:app 图标换季配色')

  // —— Recycle bin (goes through the real soft-delete channel; updateTodoFields' delete patch doesn't persist under the shim) ——
  for (const [c, cat] of [['废弃 旧版公告稿', 9101], ['删除 重复任务', 0], ['不要的草稿', 0]]) {
    const id = await add(c, { cat, date: at(-3) })
    const row = store.state.todo.todoList.find(t => t.taskId === id)
    if (row) await store.dispatch('todo/deleteTodo', row)
  }

  // —— Tomato focus records (past 30 days, 2~6 per day; previous rounds cleared before seeding so same-id dedupe doesn't block corrections) ——
  if (!localStorage.getItem(TOMATO_FLAG)) {
    await store.dispatch('tomato/removeRecordsByIdPrefix', 'demo_tmt_')
    const doneIds = taskIds.slice() // For linking: some tomatoes attach to historical completed tasks
    const recs = []
    let seq = 0
    for (let d = 0; d <= 30; d++) {
      const dayTs = at(-d)
      const count = 2 + (d % 5)
      for (let k = 0; k < count; k++) {
        const end = dayTs + (9 + k * 2) * 3600000 + 25 * 60000
        if (end > Date.now()) continue // 今天的记录只落已发生的时段，别造未来账
        const attach = (d + k) % 3 !== 0 // 1/3 free focus
        recs.push({
          tomatoId: 'demo_tmt_' + (++seq),
          endTime: end,
          dateKey: dkey(end),
          focus: attach ? '已完成任务 ' + ((d + k) % 10 + 1) : '自由专注',
          focusTaskId: attach ? doneIds[(d * 7 + k) % doneIds.length] : null,
          focusDuration: 25, rest: 5, restDuration: 5,
          succeed: !((d * 11 + k) % 9 === 0) // Roughly one-tenth give-up records, feeding the give-up retrospective
        })
      }
    }
    // 批量注入:一次 append(行表支持数组)+一次 recordsReplace;逐条 addRecord 曾产生 120 次 LS 全量写+120 次 IPC(二轮深审 P2)
    window.todoAPI.dbCall('tomatoAppendMany', recs).catch(e => console.warn('[demo] ledger append failed', e)); window.todoAPI.dbCall('tomatoAll').then(rows => store.commit('tomato/recordsReplace', rows)).catch(() => {})
    localStorage.setItem(TOMATO_FLAG, String(Date.now()))
  }

  // —— Habits + 30-day check-in history (written as a whole replacement) ——
  const mk = (name, frequency, ratio, offset) => {
    const records = {}
    for (let d = 0; d <= 30; d++) {
      const ts = at(-d)
      if (offset > 0 && d % offset !== 0) continue
      if ((d * 13 + name.length) % 10 < ratio * 10) records[dkey(ts)] = true
    }
    return { id: 930000 + name.length * 7 + (frequency.type === 'daily' ? 1 : frequency.type === 'weekdays' ? 2 : 3), name, color: '#0f9d8f', createdAt: at(-31), frequency, records }
  }
  store.commit('habits/replaceAll', {
    schemaV: 1,
    habits: [
      mk('每日阅读 #读书', { type: 'daily' }, 0.8, 0),
      mk('健身', { type: 'weekdays', weekdays: [0, 2, 4] }, 0.9, 0),
      mk('深度整理', { type: 'interval', intervalN: 3 }, 1, 3)
    ],
    moments: [],
    savedAt: Date.now()
  })

  localStorage.setItem(REG_KEY, JSON.stringify({ taskIds, seededAt: Date.now() }))
  return { tasks: taskIds.length, tomato: store.state.tomato.tomatoRecordList.length, habits: store.state.habits.habits.length, todayDebug: today, todayTsDebug: store.state.todo.todayTimestamp }
}

export async function purge () {
  const el = document.querySelector('#app')
  const store = el.__vue_app__._context.config.globalProperties.$store
  let reg
  try { reg = JSON.parse(localStorage.getItem(REG_KEY)) || {} } catch { reg = {} }
  await purgeOld(store, reg)
  localStorage.removeItem(REG_KEY)
  localStorage.removeItem(TOMATO_FLAG)
  // Clear the demo tomato records (including those polluted by previous rounds' dateKeys); next seed re-pours them
  await store.dispatch('tomato/removeRecordsByIdPrefix', 'demo_tmt_')
  return 'purged'
}
